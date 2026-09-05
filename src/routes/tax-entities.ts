import { Router } from 'express';
import { requireUser } from '../auth.js';
import { encrypt } from '../crypto.js';
import { query } from '../db.js';
import { enumStr, HttpError, pathId, str, type Body } from '../http.js';

export const taxEntitiesRouter = Router();

const ENTITY_TYPES = ['individual', 'sole_proprietor', 'company'] as const;

// ใช้ร่วมกันทุกจุดที่รับ tax_entity_id จาก client (accounts.ts, tax-documents.ts) — เดียวกันหมด กัน
// user A ชี้ FK ไป tax_entity ของ user B (FK ธรรมดาไม่กันข้าม user ได้ ต้อง route guard เสมอ)
export async function assertOwnsTaxEntity(userId: number, taxEntityId: number): Promise<void> {
  const owns = await query('select 1 from tax_entity where id = $1 and user_id = $2', [taxEntityId, userId]);
  if (!owns.rowCount) throw new HttpError(403, 'Tax Entity นี้ไม่ใช่ของคุณ');
}

// ห้าม select tax_id_enc ออกไปทาง API เด็ดขาด — เหมือน pdf_password_enc/refresh_token_enc
taxEntitiesRouter.get('/tax-entities', requireUser(async (_req, res, user) => {
  const { rows } = await query(
    `select id, entity_type, display_name, vat_registered, is_active, created_at, tax_id_enc is not null as has_tax_id
     from tax_entity where user_id = $1 order by display_name`,
    [user.id],
  );
  res.json(rows);
}));

taxEntitiesRouter.post('/tax-entities', requireUser(async (req, res, user) => {
  const b = req.body as Body;
  const entityType = enumStr(b, 'entity_type', ENTITY_TYPES);
  const displayName = str(b, 'display_name', 100);
  const taxId = b.tax_id == null || b.tax_id === '' ? null : encrypt(str(b, 'tax_id', 20));
  const vatRegistered = typeof b.vat_registered === 'boolean' ? b.vat_registered : false;

  const { rows } = await query<{ id: number }>(
    `insert into tax_entity (user_id, entity_type, display_name, tax_id_enc, vat_registered)
     values ($1, $2, $3, $4, $5) returning id, entity_type, display_name, vat_registered, is_active, created_at,
       tax_id_enc is not null as has_tax_id`,
    [user.id, entityType, displayName, taxId, vatRegistered],
  );
  res.status(201).json(rows[0]);
}));

// ไม่มี DELETE — archive ผ่าน is_active=false เท่านั้น (§17 "Hard Delete ทำลายประวัติ" → ใช้ Archive)
taxEntitiesRouter.patch('/tax-entities/:id', requireUser(async (req, res, user) => {
  const entityId = pathId(req);
  const b = req.body as Body;
  const taxIdProvided = Object.prototype.hasOwnProperty.call(b, 'tax_id');
  const { rows } = await query(
    `update tax_entity set
       display_name = coalesce($3, display_name),
       vat_registered = coalesce($4, vat_registered),
       is_active = coalesce($5, is_active),
       tax_id_enc = case when $6 then $7 else tax_id_enc end
     where id = $1 and user_id = $2
     returning id, entity_type, display_name, vat_registered, is_active, created_at,
       tax_id_enc is not null as has_tax_id`,
    [
      entityId,
      user.id,
      b.display_name == null ? null : str(b, 'display_name', 100),
      typeof b.vat_registered === 'boolean' ? b.vat_registered : null,
      typeof b.is_active === 'boolean' ? b.is_active : null,
      taxIdProvided,
      taxIdProvided ? (b.tax_id == null || b.tax_id === '' ? null : encrypt(str(b, 'tax_id', 20))) : null,
    ],
  );
  if (!rows[0]) throw new HttpError(404, 'ไม่พบ Tax Entity');
  res.json(rows[0]);
}));
