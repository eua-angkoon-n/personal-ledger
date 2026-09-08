import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import session from 'express-session';

process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:5432/unused';

const { createAuthRouter } = await import('../src/auth.js');
const { api } = await import('../src/api.js');

const authEnv = {
  googleClientId: 'client-id',
  googleClientSecret: 'client-secret',
  baseUrl: 'http://localhost',
  adminEmail: 'admin@example.com',
};

type QueryCall = { sql: string; params: unknown[] };

async function openTestApp(existingUserId?: number, googleEmail = 'member@example.com') {
  const calls: QueryCall[] = [];
  const fakeQuery = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('select id from app_user')) {
      return { rows: existingUserId ? [{ id: existingUserId }] : [], rowCount: existingUserId ? 1 : 0 };
    }
    if (sql.includes('insert into app_user')) return { rows: [{ id: 42 }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };
  const fakeFetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      return Response.json({ access_token: 'access-token', refresh_token: 'refresh-token' });
    }
    if (url === 'https://www.googleapis.com/oauth2/v3/userinfo') {
      return Response.json({ sub: 'google-user-1', email: googleEmail, name: 'Family Member' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret-test-secret-test-secret', resave: false, saveUninitialized: false }));
  app.use('/auth', createAuthRouter({
    query: fakeQuery as never,
    encrypt: (value: string) => `encrypted:${value}`,
    env: authEnv,
    fetch: fakeFetch,
  }));
  app.use('/api', api);

  const server = app.listen(0);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not open a TCP port');

  let cookie = '';
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('cookie', cookie);
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...init,
      headers,
      redirect: 'manual',
    });
    const setCookie = response.headers.getSetCookie()[0];
    if (setCookie) cookie = setCookie.split(';', 1)[0]!;
    return response;
  };

  return { calls, request, close: () => server.close() };
}

async function completeGoogleLogin(request: (path: string, init?: RequestInit) => Promise<Response>) {
  const start = await request('/auth/google');
  assert.equal(start.status, 302);
  const googleUrl = new URL(start.headers.get('location')!);
  const state = googleUrl.searchParams.get('state');
  assert.ok(state);
  return request(`/auth/google/callback?code=oauth-code&state=${state}`);
}

test('ผู้ใช้ Google ใหม่ถูกสร้างทันทีตอน callback และได้สถานะ pending', async (t) => {
  const app = await openTestApp();
  t.after(app.close);

  const initialMe = await app.request('/api/me');
  assert.deepEqual(await initialMe.json(), { user: null });

  // ไม่ล็อกอิน + endpoint ที่ย้ายไป src/routes/admin.ts ต้องยัง mount อยู่จริง (401 ไม่ใช่ 404 จาก fallback)
  const parserKeys = await app.request('/api/admin/parser-keys');
  assert.equal(parserKeys.status, 401);

  const callback = await completeGoogleLogin(app.request);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/');

  const insert = app.calls.find(({ sql }) => sql.includes('insert into app_user'));
  assert.ok(insert, 'ต้องสร้าง app_user ตอน callback ไม่มีขั้นกรอกรหัสเชิญคั่นอีกแล้ว');
  // member@example.com ไม่ใช่ adminEmail — ด่านที่กันคนนอกคือสถานะนี้ ไม่ใช่รหัสเชิญ
  assert.equal(insert.params[3], false, 'ต้องไม่ได้ is_admin');
  assert.equal(insert.params[4], 'pending', 'ต้องเป็น pending รอแอดมินอนุมัติ');

  // refresh token ต้องถูกเก็บให้ผู้ใช้ใหม่ด้วย ไม่งั้น Gmail polling ไม่ทำงานเลยแบบไม่มี error
  const mailbox = app.calls.find(({ sql }) => sql.includes('insert into email_account'));
  assert.ok(mailbox, 'ต้องผูกกล่องอีเมลให้ผู้ใช้ใหม่');
  assert.equal(mailbox.params[2], 'encrypted:refresh-token');
});

test('ADMIN_EMAIL ได้ is_admin + approved อัตโนมัติตอนล็อกอินครั้งแรก', async (t) => {
  const app = await openTestApp(undefined, 'Admin@Example.com');
  t.after(app.close);

  const callback = await completeGoogleLogin(app.request);
  assert.equal(callback.status, 302);

  const insert = app.calls.find(({ sql }) => sql.includes('insert into app_user'));
  assert.ok(insert);
  assert.equal(insert.params[3], true, 'ต้องได้ is_admin (เทียบอีเมลแบบไม่สนตัวพิมพ์)');
  assert.equal(insert.params[4], 'approved');
});

test('สมาชิกเดิมล็อกอินซ้ำต้องไม่สร้างผู้ใช้ใหม่', async (t) => {
  const app = await openTestApp(7);
  t.after(app.close);

  const callback = await completeGoogleLogin(app.request);
  assert.equal(callback.status, 302);
  assert.equal(app.calls.some(({ sql }) => sql.includes('insert into app_user')), false);
});

test('ไม่มี endpoint สมัครสมาชิกด้วยรหัสเชิญเหลืออยู่', async (t) => {
  const app = await openTestApp();
  t.after(app.close);

  const signup = await app.request('/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inviteCode: 'family-only' }),
  });
  assert.equal(signup.status, 404);
});
