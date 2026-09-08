import { Router } from 'express';
import { requireUser } from '../auth.js';
import { pool, query } from '../db.js';
import { HttpError, type Body } from '../http.js';
import { audit } from '../services/audit.js';
import { syncEmailAccount } from '../worker.js';

export const emailAccountsRouter = Router();

emailAccountsRouter.get('/email-accounts', requireUser(async (_req, res, user) => {
  const { rows } = await query('select id, email, last_synced_at from email_account where user_id = $1', [user.id]);
  res.json(rows);
}));

// ยิงมือ — await แล้วตอบสรุปกลับ ไม่ใช่ 202 เพราะตัวเลขนี้คือของที่ต้องใช้ตรวจ Slice 2 ตอนเมลจริงมาถึง
emailAccountsRouter.post('/email-accounts/:id/sync', requireUser(async (req, res, user) => {
  const emailAccountId = Number(req.params.id);
  const owns = await query('select 1 from email_account where id = $1 and user_id = $2', [emailAccountId, user.id]);
  if (!owns.rowCount) throw new HttpError(403, 'กล่องอีเมลนี้ไม่ใช่ของคุณ');
  const full = (req.body as Body).full === true;
  const summary = await syncEmailAccount(emailAccountId, { full });
  // ไม่มี tx ให้เกาะ (sync ทำงานจบไปแล้วและเขียนหลายตารางเอง) — เขียนผ่าน pool เหมือน tax.export
  // เก็บแค่ตัวเลขสรุป ห้ามแตะ refresh_token_enc ของกล่อง
  await audit(pool, {
    userId: user.id,
    action: 'email_account.sync',
    entityType: 'email_account',
    entityId: emailAccountId,
    after: { full, ...summary },
    ip: req.ip ?? null,
  });
  res.json(summary);
}));
