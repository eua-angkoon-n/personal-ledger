import { Router } from 'express';
import { requireUser } from '../auth.js';
import { encrypt } from '../crypto.js';
import { query, tx } from '../db.js';
import { HttpError, id, optionalStr, str, type Body } from '../http.js';
import { assertOwnsTaxEntity } from './tax-entities.js';
import { syncEmailAccount } from '../worker.js';
import { audit } from '../services/audit.js';

export const accountsRouter = Router();

// ห้าม select pdf_password_enc ออกไปแม้แต่เข้า audit_log — GET /api/audit-log คืน before_data/after_data
// ดิบให้เจ้าของอ่านได้ตรง ๆ ถ้าใส่ ciphertext ของรหัสผ่าน PDF เข้าไปจะรั่วไปอีกทางที่ไม่มีใครกันไว้
// (บั๊กจริงที่เจอใน Slice 8 ตอน archive ใช้ `select *`) ทุก audit ของตารางนี้ต้องผ่านคอลัมน์ชุดนี้เท่านั้น
const ACCOUNT_AUDIT_COLUMNS = 'id, nickname, account_number, bank_id, email_account_id, promptpay_id, default_tax_entity_id, archived_at';

accountsRouter.get('/accounts', requireUser(async (_req, res, user) => {
  // ห้าม select pdf_password_enc ออกไปทาง API เด็ดขาด
  const { rows } = await query(
    `select a.id, a.nickname, a.account_number, a.promptpay_id, a.created_at, a.default_tax_entity_id,
            b.id as bank_id, b.name as bank_name, e.id as email_account_id, e.email
     from bank_account a
     join bank b on b.id = a.bank_id
     join email_account e on e.id = a.email_account_id
     where a.user_id = $1 and a.archived_at is null order by a.nickname`,
    [user.id],
  );
  res.json(rows);
}));

accountsRouter.post('/accounts', requireUser(async (req, res, user) => {
  const b = req.body as Body;
  const emailAccountId = id(b, 'email_account_id');
  const owns = await query('select 1 from email_account where id = $1 and user_id = $2', [emailAccountId, user.id]);
  if (!owns.rowCount) throw new HttpError(403, 'กล่องอีเมลนี้ไม่ใช่ของคุณ');
  const defaultTaxEntityId = b.default_tax_entity_id == null ? null : id(b, 'default_tax_entity_id');
  if (defaultTaxEntityId != null) await assertOwnsTaxEntity(user.id, defaultTaxEntityId);

  // insert + audit อยู่ใน tx เดียวกัน ตามกฎของ audit(): แถวข้อมูลกับแถว audit ต้อง commit/rollback พร้อมกัน
  const created = await tx(async (c) => {
    const { rows } = await c.query<{ id: number }>(
      `insert into bank_account (user_id, bank_id, email_account_id, nickname, account_number, pdf_password_enc, promptpay_id, default_tax_entity_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${ACCOUNT_AUDIT_COLUMNS}`,
      [
        user.id,
        id(b, 'bank_id'),
        emailAccountId,
        str(b, 'nickname', 60),
        str(b, 'account_number', 40),
        encrypt(str(b, 'pdf_password', 200)),
        optionalStr(b, 'promptpay_id', 40),
        defaultTaxEntityId,
      ],
    );
    await audit(c, { userId: user.id, action: 'bank_account.create', entityType: 'bank_account', entityId: rows[0]!.id, after: rows[0], ip: req.ip ?? null });
    return rows[0]!;
  });
  // backfill เต็มกล่องแบบ fire-and-forget — ผู้ใช้ไม่ต้องรอ ต้องมี .catch() เสมอไม่งั้นโปรเซสตาย (unhandled rejection)
  syncEmailAccount(emailAccountId, { full: true }).catch((e) =>
    console.error(`[worker] backfill mailbox=${emailAccountId} ล้มเหลว:`, e),
  );
  res.status(201).json({ id: created.id });
}));

accountsRouter.patch('/accounts/:id', requireUser(async (req, res, user) => {
  const b = req.body as Body;
  const emailAccountId = b.email_account_id == null ? null : id(b, 'email_account_id');
  if (emailAccountId !== null) {
    const owns = await query('select 1 from email_account where id = $1 and user_id = $2', [emailAccountId, user.id]);
    if (!owns.rowCount) throw new HttpError(403, 'กล่องอีเมลนี้ไม่ใช่ของคุณ');
  }
  const hasPromptpay = Object.prototype.hasOwnProperty.call(b, 'promptpay_id');
  const hasDefaultTaxEntity = Object.prototype.hasOwnProperty.call(b, 'default_tax_entity_id');
  const defaultTaxEntityId = hasDefaultTaxEntity && b.default_tax_entity_id != null ? id(b, 'default_tax_entity_id') : null;
  if (hasDefaultTaxEntity && defaultTaxEntityId != null) await assertOwnsTaxEntity(user.id, defaultTaxEntityId);
  const accountId = Number(req.params.id);
  const updated = await tx(async (c) => {
    const before = (await c.query(`select ${ACCOUNT_AUDIT_COLUMNS} from bank_account where id = $1 and user_id = $2`, [accountId, user.id])).rows[0];
    const { rows } = await c.query<{ id: number; email_account_id: number }>(
      `update bank_account set
         bank_id = coalesce($3, bank_id),
         email_account_id = coalesce($4, email_account_id),
         nickname = coalesce($5, nickname),
         account_number = coalesce($6, account_number),
         promptpay_id = case when $7 then $8 else promptpay_id end,
         pdf_password_enc = coalesce($9, pdf_password_enc),
         default_tax_entity_id = case when $10 then $11 else default_tax_entity_id end
       where id = $1 and user_id = $2 and archived_at is null returning ${ACCOUNT_AUDIT_COLUMNS}`,
      [
        accountId,
        user.id,
        b.bank_id == null ? null : id(b, 'bank_id'),
        emailAccountId,
        b.nickname == null ? null : str(b, 'nickname', 60),
        b.account_number == null ? null : str(b, 'account_number', 40),
        hasPromptpay,
        hasPromptpay ? optionalStr(b, 'promptpay_id', 40) : null,
        b.pdf_password == null || b.pdf_password === '' ? null : encrypt(str(b, 'pdf_password', 200)),
        hasDefaultTaxEntity,
        defaultTaxEntityId,
      ],
    );
    if (!rows[0]) throw new HttpError(404, 'ไม่พบบัญชี');
    // รหัสผ่าน PDF เปลี่ยนหรือไม่เก็บเป็น boolean ไม่ใช่ค่า — ต้องตรวจสอบได้ว่ามีคนเปลี่ยนแต่ห้ามเห็นค่า
    await audit(c, {
      userId: user.id,
      action: 'bank_account.update',
      entityType: 'bank_account',
      entityId: accountId,
      before,
      after: { ...rows[0], pdf_password_changed: !(b.pdf_password == null || b.pdf_password === '') },
      ip: req.ip ?? null,
    });
    return rows[0];
  });
  syncEmailAccount(updated.email_account_id, { full: true }).catch((e) =>
    console.error(`[worker] reprocess account=${updated.id} ล้มเหลว:`, e),
  );
  res.json({ id: updated.id, email_account_id: updated.email_account_id });
}));

accountsRouter.delete('/accounts/:id', requireUser(async (req, res, user) => {
  // เก็บเข้าคลัง (archive) แทนลบจริง — statement/txn ผูก on delete cascade กับ bank_account
  // ลบแถวจริงจะพาประวัติ statement/txn ทั้งชุดหายไปด้วย
  const accountId = Number(req.params.id);
  await tx(async (c) => {
    const before = (await c.query(`select ${ACCOUNT_AUDIT_COLUMNS} from bank_account where id = $1 and user_id = $2`, [accountId, user.id])).rows[0];
    if (!before) throw new HttpError(404, 'ไม่พบบัญชี');
    const { rows } = await c.query(
      `update bank_account set archived_at = now() where id = $1 and user_id = $2 and archived_at is null returning ${ACCOUNT_AUDIT_COLUMNS}`,
      [accountId, user.id],
    );
    if (!rows[0]) throw new HttpError(404, 'ไม่พบบัญชี');
    await audit(c, { userId: user.id, action: 'bank_account.archive', entityType: 'bank_account', entityId: accountId, before, after: rows[0], ip: req.ip ?? null });
  });
  res.status(204).end();
}));
