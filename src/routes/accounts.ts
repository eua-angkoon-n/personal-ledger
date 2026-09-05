import { Router } from 'express';
import { requireUser } from '../auth.js';
import { encrypt } from '../crypto.js';
import { query } from '../db.js';
import { HttpError, id, optionalStr, str, type Body } from '../http.js';
import { assertOwnsTaxEntity } from './tax-entities.js';
import { syncEmailAccount } from '../worker.js';

export const accountsRouter = Router();

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

  const { rows } = await query<{ id: number }>(
    `insert into bank_account (user_id, bank_id, email_account_id, nickname, account_number, pdf_password_enc, promptpay_id, default_tax_entity_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
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
  // backfill เต็มกล่องแบบ fire-and-forget — ผู้ใช้ไม่ต้องรอ ต้องมี .catch() เสมอไม่งั้นโปรเซสตาย (unhandled rejection)
  syncEmailAccount(emailAccountId, { full: true }).catch((e) =>
    console.error(`[worker] backfill mailbox=${emailAccountId} ล้มเหลว:`, e),
  );
  res.status(201).json({ id: rows[0]!.id });
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
  const { rows } = await query<{ id: number; email_account_id: number }>(
    `update bank_account set
       bank_id = coalesce($3, bank_id),
       email_account_id = coalesce($4, email_account_id),
       nickname = coalesce($5, nickname),
       account_number = coalesce($6, account_number),
       promptpay_id = case when $7 then $8 else promptpay_id end,
       pdf_password_enc = coalesce($9, pdf_password_enc),
       default_tax_entity_id = case when $10 then $11 else default_tax_entity_id end
     where id = $1 and user_id = $2 and archived_at is null returning id, email_account_id`,
    [
      Number(req.params.id),
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
  syncEmailAccount(rows[0].email_account_id, { full: true }).catch((e) =>
    console.error(`[worker] reprocess account=${rows[0]!.id} ล้มเหลว:`, e),
  );
  res.json(rows[0]);
}));

accountsRouter.delete('/accounts/:id', requireUser(async (req, res, user) => {
  // เก็บเข้าคลัง (archive) แทนลบจริง — statement/txn ผูก on delete cascade กับ bank_account
  // ลบแถวจริงจะพาประวัติ statement/txn ทั้งชุดหายไปด้วย
  const { rowCount } = await query(
    'update bank_account set archived_at = now() where id = $1 and user_id = $2 and archived_at is null',
    [Number(req.params.id), user.id],
  );
  if (!rowCount) throw new HttpError(404, 'ไม่พบบัญชี');
  res.status(204).end();
}));
