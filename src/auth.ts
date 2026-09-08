import { randomBytes } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { encrypt } from './crypto.js';
import { query } from './db.js';
import { env } from './env.js';

// gmail.readonly เท่านั้น — ห้ามเติม scope `drive` ลงในไคลเอนต์ตัวนี้เด็ดขาด
const SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.readonly'];

declare module 'express-session' {
  interface SessionData {
    userId?: number;
    oauthState?: string;
    addMailbox?: boolean;
    pendingSignup?: {
      googleSub: string;
      email: string;
      displayName: string;
      refreshTokenEnc?: string;
    };
  }
}

export type User = {
  id: number;
  email: string;
  display_name: string;
  is_admin: boolean;
  status: 'pending' | 'approved' | 'rejected';
};

export async function loadUser(req: Request): Promise<User | null> {
  if (!req.session.userId) return null;
  const { rows } = await query<User>(
    'select id, email, display_name, is_admin, status from app_user where id = $1',
    [req.session.userId],
  );
  return rows[0] ?? null;
}

/** approved เท่านั้นถึงจะแตะข้อมูลได้ — pending/rejected ผ่านด่านนี้ไม่ได้ */
export function requireUser(handler: (req: Request, res: Response, user: User) => Promise<void>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await loadUser(req);
      if (!user) return void res.status(401).json({ error: 'ยังไม่ได้เข้าสู่ระบบ' });
      if (user.status !== 'approved') return void res.status(403).json({ error: 'บัญชียังไม่ได้รับอนุมัติ' });
      await handler(req, res, user);
    } catch (e) {
      next(e);
    }
  };
}

export function requireAdmin(handler: (req: Request, res: Response, user: User) => Promise<void>) {
  return requireUser(async (req, res, user) => {
    if (!user.is_admin) return void res.status(403).json({ error: 'ต้องเป็นแอดมิน' });
    await handler(req, res, user);
  });
}

/** ต่อ Google ที่ปลายทาง revoke จริง ๆ ไม่ใช่แค่ลบแถวในตารางเรา */
export async function revokeAtGoogle(refreshToken: string): Promise<void> {
  await fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshToken }),
  });
}

// ponytail: rate limit ในหน่วยความจำ พอสำหรับ instance เดียว ถ้าสเกลค่อยย้ายไปตาราง/redis
const attempts = new Map<string, { n: number; resetAt: number }>();
function tooManyAttempts(ip: string): boolean {
  const now = Date.now();
  const e = attempts.get(ip);
  if (!e || now > e.resetAt) {
    attempts.set(ip, { n: 1, resetAt: now + 15 * 60_000 });
    return false;
  }
  e.n += 1;
  return e.n > 10;
}

type AuthDependencies = {
  query: typeof query;
  encrypt: typeof encrypt;
  env: Pick<typeof env, 'googleClientId' | 'googleClientSecret' | 'baseUrl' | 'inviteCode' | 'adminEmail'>;
  fetch: typeof fetch;
};

const defaultAuthDependencies: AuthDependencies = { query, encrypt, env, fetch };

export function createAuthRouter({
  query,
  encrypt,
  env,
  fetch,
}: AuthDependencies = defaultAuthDependencies): Router {
  const authRouter = Router();
  const saveEmailAccount = (userId: number, email: string, refreshTokenEnc: string) => query(
    `insert into email_account (user_id, email, refresh_token_enc) values ($1, $2, $3)
     on conflict (user_id, email) do update set refresh_token_enc = excluded.refresh_token_enc`,
    [userId, email, refreshTokenEnc],
  );

authRouter.get('/google', (req, res) => {
  if (tooManyAttempts(req.ip ?? 'unknown')) return void res.status(429).send('ลองใหม่อีก 15 นาที');
  req.session.oauthState = randomBytes(16).toString('hex');
  req.session.pendingSignup = undefined;
  // ?add=1 = ผู้ใช้ที่ล็อกอินอยู่แล้วต่อกล่องอีเมลใบที่ 2 (requirement 1.1) ไม่ใช่การสมัครใหม่
  req.session.addMailbox = req.query.add === '1';
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: `${env.baseUrl}/auth/google/callback`,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent', // บังคับให้ได้ refresh_token ทุกครั้ง ไม่ใช่เฉพาะครั้งแรก
    state: req.session.oauthState,
  }).toString();
  res.redirect(url.toString());
});

authRouter.get('/google/callback', async (req, res, next) => {
  try {
    const { code, state } = req.query;
    if (!req.session.oauthState || state !== req.session.oauthState) {
      return void res.status(400).send('state ไม่ตรง — เริ่มเข้าสู่ระบบใหม่');
    }
    // ต่อกล่องเพิ่มได้เฉพาะตอนล็อกอินอยู่แล้ว — ไม่งั้นตกไปทางสมัครปกติ
    const addMailbox = req.session.addMailbox === true && req.session.userId != null;
    req.session.oauthState = undefined;
    req.session.addMailbox = undefined;
    if (typeof code !== 'string') return void res.status(400).send('ไม่มี code');

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.googleClientId,
        client_secret: env.googleClientSecret,
        redirect_uri: `${env.baseUrl}/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    });
    // ต้อง log body ของ Google ด้วย — ข้อความ 502 ที่ผู้ใช้เห็นไม่บอกว่า invalid_client,
    // redirect_uri_mismatch หรือ code หมดอายุ ซึ่งเป็นสามอย่างที่ต้องรู้เพื่อแก้ (body ไม่มี secret)
    if (!tokenRes.ok) {
      console.error('token exchange ล้มเหลว', tokenRes.status, await tokenRes.text());
      return void res.status(502).send('แลก token กับ Google ไม่สำเร็จ');
    }
    const token = (await tokenRes.json()) as { access_token: string; refresh_token?: string };

    // ถาม userinfo แทนการถอด id_token เอง — ไม่ต้องตรวจลายเซ็น JWT เองให้พลาด
    const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    if (!infoRes.ok) {
      console.error('userinfo ล้มเหลว', infoRes.status, await infoRes.text());
      return void res.status(502).send('อ่านข้อมูลผู้ใช้จาก Google ไม่สำเร็จ');
    }
    const info = (await infoRes.json()) as { sub: string; email: string; name?: string };

    // ต่อกล่องเพิ่ม: ผูกเข้ากับผู้ใช้ใน session ไม่ใช่หา app_user จาก google_sub
    // (ยืนยันความเป็นเจ้าของกล่องด้วยการผ่าน OAuth ของกล่องนั้นแล้ว)
    // ponytail: กล่องเดียวกันผูกได้หลาย app_user (unique เป็น (user_id, email))
    // Google revoke ทีเดียวทั้งไคลเอนต์+ผู้ใช้ → reject คนหนึ่งจะตัดสิทธิ์อีกคนที่แชร์กล่องนั้นไปด้วย
    // รับได้ในสเกลครอบครัว ถ้าเจอปัญหาจริงค่อยแยกเป็น many-to-many
    const existing = addMailbox
      ? { rows: [] as { id: number }[] }
      : await query<{ id: number }>('select id from app_user where google_sub = $1', [info.sub]);
    let userId = addMailbox ? req.session.userId : existing.rows[0]?.id;

    if (!userId) {
      req.session.userId = undefined;
      req.session.pendingSignup = {
        googleSub: info.sub,
        email: info.email,
        displayName: info.name ?? '',
        refreshTokenEnc: token.refresh_token ? encrypt(token.refresh_token) : undefined,
      };
      return void res.redirect('/');
    }

    req.session.pendingSignup = undefined;
    if (token.refresh_token) {
      await saveEmailAccount(userId, info.email, encrypt(token.refresh_token));
    }

    req.session.userId = userId;
    res.redirect('/');
  } catch (e) {
    next(e);
  }
});

authRouter.post('/signup', async (req, res, next) => {
  try {
    if (tooManyAttempts(req.ip ?? 'unknown')) return void res.status(429).json({ error: 'ลองใหม่อีก 15 นาที' });
    const pending = req.session.pendingSignup;
    if (!pending) return void res.status(409).json({ error: 'ไม่มีการสมัครสมาชิกที่รอดำเนินการ' });
    const inviteCode = (req.body as { inviteCode?: unknown }).inviteCode;
    if (inviteCode !== env.inviteCode) return void res.status(403).json({ error: 'รหัสเชิญไม่ถูกต้อง' });

    const existing = await query<{ id: number }>('select id from app_user where google_sub = $1', [pending.googleSub]);
    let userId = existing.rows[0]?.id;
    if (!userId) {
      const isAdmin = pending.email.toLowerCase() === env.adminEmail;
      const created = await query<{ id: number }>(
        `insert into app_user (google_sub, email, display_name, is_admin, status)
         values ($1, $2, $3, $4, $5) returning id`,
        [pending.googleSub, pending.email, pending.displayName, isAdmin, isAdmin ? 'approved' : 'pending'],
      );
      userId = created.rows[0]!.id;
    }

    if (pending.refreshTokenEnc) {
      await saveEmailAccount(userId, pending.email, pending.refreshTokenEnc);
    }

    req.session.pendingSignup = undefined;
    req.session.userId = userId;
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

authRouter.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

  return authRouter;
}

export const authRouter = createAuthRouter();
