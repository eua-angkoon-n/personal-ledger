import { Router } from 'express';
import { requireAdmin, revokeAtGoogle } from '../auth.js';
import { decrypt } from '../crypto.js';
import { query, tx } from '../db.js';
import { HttpError, type Body } from '../http.js';
import { PARSER_KEYS } from '../parsers/index.js';
import { audit } from '../services/audit.js';

export const adminRouter = Router();

adminRouter.get('/admin/parser-keys', requireAdmin(async (_req, res) => {
  res.json({ keys: PARSER_KEYS });
}));

adminRouter.get('/admin/users', requireAdmin(async (_req, res) => {
  const { rows } = await query(
    'select id, email, display_name, is_admin, status, created_at from app_user order by created_at',
  );
  res.json(rows);
}));

adminRouter.patch('/admin/users/:id', requireAdmin(async (req, res, admin) => {
  const b = req.body as Body;
  const status = b.status == null ? null : String(b.status);
  const isAdmin = typeof b.is_admin === 'boolean' ? b.is_admin : null;
  if (status !== null && !['pending', 'approved', 'rejected'].includes(status)) {
    throw new HttpError(400, 'status ไม่ถูกต้อง');
  }
  if (status === null && isAdmin === null) throw new HttpError(400, 'ไม่มีข้อมูลที่ต้องการแก้ไข');
  const targetId = Number(req.params.id);
  if (targetId === admin.id) throw new HttpError(400, 'เปลี่ยนสถานะหรือบทบาทตัวเองไม่ได้');

  if (status === 'rejected') {
    // ยกเลิกสิทธิ์ที่ Google เท่านั้น — ไม่ลบแถว email_account อีกต่อไป
    // (พบจาก code review: bank_account.email_account_id ไม่มี on delete cascade และตั้งแต่ Slice 4A
    // bank_account ก็ไม่ถูกลบจริงแล้ว (archive แทน) ลบ email_account เลยชน FK 23503 ทุกครั้งที่ผู้ใช้
    // เคยเพิ่มบัญชีธนาคารมาก่อน — revoke ที่ Google ทำให้ token ใช้ไม่ได้แล้ว แถวที่เหลือไม่มีความเสี่ยงเพิ่ม)
    const { rows } = await query<{ refresh_token_enc: string }>(
      'select refresh_token_enc from email_account where user_id = $1',
      [targetId],
    );
    for (const r of rows) {
      await revokeAtGoogle(decrypt(r.refresh_token_enc));
    }
  }
  // audit_log.user_id = **ผู้ลงมือ** (แอดมิน) ไม่ใช่ผู้ถูกกระทำ คำถามที่ต้องตอบได้คือ "ใครอนุมัติ/ปฏิเสธคนนี้"
  // ผลตามมาโดยตั้งใจ: แถวนี้ไม่โผล่ในหน้า /audit ของผู้ถูกกระทำ แต่โผล่ในมุมมองแอดมิน (?scope=all)
  const updated = await tx(async (c) => {
    const before = (await c.query('select id, email, status, is_admin from app_user where id = $1', [targetId])).rows[0];
    if (!before) throw new HttpError(404, 'ไม่พบผู้ใช้');
    const { rows } = await c.query(
      `update app_user set status = coalesce($2, status), is_admin = coalesce($3, is_admin)
       where id = $1 returning id, email, status, is_admin`,
      [targetId, status, isAdmin],
    );
    if (!rows[0]) throw new HttpError(404, 'ไม่พบผู้ใช้');
    await audit(c, {
      userId: admin.id,
      action: 'app_user.update',
      entityType: 'app_user',
      entityId: targetId,
      before,
      after: rows[0],
      ip: req.ip ?? null,
    });
    return rows[0];
  });
  res.json(updated);
}));
