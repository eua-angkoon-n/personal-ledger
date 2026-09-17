import { Router } from 'express';
import { requireAdmin, requireUser } from '../auth.js';
import { query, tx } from '../db.js';
import { HttpError, optionalStr, regex, str, type Body } from '../http.js';
import { PARSER_KEYS } from '../parsers/index.js';
import { audit } from '../services/audit.js';

export const banksRouter = Router();

banksRouter.get('/banks', requireUser(async (_req, res) => {
  const { rows } = await query('select * from bank order by name');
  res.json(rows);
}));

// ตาราง bank ไม่มีคอลัมน์ความลับ (ชื่อ/อีเมลผู้ส่ง/pattern/parser_key) — `returning *` เข้า audit ได้ตรง ๆ
// ต่างจาก bank_account/email_account/tax_entity ที่ต้องเลือกคอลัมน์เอง
banksRouter.post('/banks', requireAdmin(async (req, res, admin) => {
  const b = req.body as Body;
  const parserKey = str(b, 'parser_key');
  if (!(PARSER_KEYS as readonly string[]).includes(parserKey)) {
    throw new HttpError(400, `parser_key ต้องเป็นหนึ่งใน ${PARSER_KEYS.join(', ')}`);
  }
  const created = await tx(async (c) => {
    const { rows } = await c.query<{ id: number }>(
      `insert into bank (name, sender_email, sender_domain, subject_monthly, subject_ondemand,
                         attachment_filename_pattern, parser_key, is_active)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [
        str(b, 'name'),
        str(b, 'sender_email').toLowerCase(),
        str(b, 'sender_domain').toLowerCase(),
        regex(b, 'subject_monthly'),
        regex(b, 'subject_ondemand'),
        regex(b, 'attachment_filename_pattern'),
        parserKey,
        b.is_active !== false,
      ],
    );
    await audit(c, { userId: admin.id, action: 'bank.create', entityType: 'bank', entityId: rows[0]!.id, after: rows[0], ip: req.ip ?? null });
    return rows[0]!;
  });
  res.status(201).json(created);
}));

banksRouter.patch('/banks/:id', requireAdmin(async (req, res, admin) => {
  const b = req.body as Body;
  const parserKey = b.parser_key == null ? null : str(b, 'parser_key');
  if (parserKey !== null && !(PARSER_KEYS as readonly string[]).includes(parserKey)) {
    throw new HttpError(400, `parser_key ต้องเป็นหนึ่งใน ${PARSER_KEYS.join(', ')}`);
  }
  const bankId = Number(req.params.id);
  const updated = await tx(async (c) => {
    const before = (await c.query('select * from bank where id = $1', [bankId])).rows[0];
    const { rows } = await c.query(
      `update bank set
         name = coalesce($2, name),
         sender_email = coalesce($3, sender_email),
         sender_domain = coalesce($4, sender_domain),
         subject_monthly = coalesce($5, subject_monthly),
         subject_ondemand = coalesce($6, subject_ondemand),
         attachment_filename_pattern = coalesce($7, attachment_filename_pattern),
         parser_key = coalesce($8, parser_key),
         is_active = coalesce($9, is_active)
       where id = $1 returning *`,
      [
        bankId,
        optionalStr(b, 'name'),
        optionalStr(b, 'sender_email')?.toLowerCase() ?? null,
        optionalStr(b, 'sender_domain')?.toLowerCase() ?? null,
        b.subject_monthly == null ? null : regex(b, 'subject_monthly'),
        b.subject_ondemand == null ? null : regex(b, 'subject_ondemand'),
        b.attachment_filename_pattern == null ? null : regex(b, 'attachment_filename_pattern'),
        parserKey,
        typeof b.is_active === 'boolean' ? b.is_active : null,
      ],
    );
    if (!rows[0]) throw new HttpError(404, 'ไม่พบธนาคาร');
    await audit(c, { userId: admin.id, action: 'bank.update', entityType: 'bank', entityId: bankId, before, after: rows[0], ip: req.ip ?? null });
    return rows[0];
  });
  res.json(updated);
}));

// ลบไม่ได้ถ้ามีบัญชีผูกอยู่ — FK จะโยน error ออกมาเอง แล้ว handler แปลงเป็น 409
banksRouter.delete('/banks/:id', requireAdmin(async (req, res, admin) => {
  const bankId = Number(req.params.id);
  await tx(async (c) => {
    const before = (await c.query('select * from bank where id = $1', [bankId])).rows[0];
    const { rowCount } = await c.query('delete from bank where id = $1', [bankId]);
    // คง 204 แบบ idempotent เหมือนเดิม (ลบของที่ไม่มีอยู่ไม่ใช่ error) — audit เฉพาะตอนที่ลบได้จริง
    if (rowCount) {
      await audit(c, { userId: admin.id, action: 'bank.delete', entityType: 'bank', entityId: bankId, before, ip: req.ip ?? null });
    }
  });
  res.status(204).end();
}));
