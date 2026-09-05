import { Router } from 'express';
import { requireUser } from '../auth.js';
import { decrypt } from '../crypto.js';
import { pool, query, tx } from '../db.js';
import { getAttachment, getMessage, listAttachments, listMessages, refreshAccessToken } from '../gmail.js';
import { enumStr, HttpError, id, isoDate, optionalStr, pathId, satang, str, type Body } from '../http.js';
import { audit } from '../services/audit.js';
import { detectMime, readStoredFile, sha256Of, storeFile } from '../services/file-vault.js';
import { assertOwnsTaxEntity } from './tax-entities.js';

export const taxDocumentsRouter = Router();

const DOCUMENT_TYPES = [
  'tax_invoice', 'e_tax_invoice', 'receipt', 'withholding_certificate',
  'insurance_certificate', 'donation_receipt', 'investment_certificate', 'other',
] as const;
const STATUSES = ['draft', 'verified', 'submitted'] as const;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;

// ไม่ select storage_path/file_sha256 ออกไปทาง API — path บนดิสก์ไม่ใช่ข้อมูลที่ client ต้องรู้
const TAX_DOC_COLUMNS = `id, tax_entity_id, document_type, tax_year, issuer_name, issuer_tax_id, recipient_tax_id,
  document_no, issue_date, subtotal_satang, vat_satang, total_satang, withholding_satang,
  file_mime, file_size_bytes, original_filename, gmail_message_id, status, verified_at, retention_until,
  created_at, updated_at`;

function optId(q: Record<string, unknown>, field: string): number | null {
  const v = q[field];
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${field} ไม่ถูกต้อง`);
  return n;
}

function optEnumQ<T extends string>(q: Record<string, unknown>, field: string, values: readonly T[]): T | null {
  const v = q[field];
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
    throw new HttpError(400, `${field} ต้องเป็นหนึ่งใน ${values.join(', ')}`);
  }
  return v as T;
}

function optYear(v: unknown, field: string): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 2000 || n > 2200) throw new HttpError(400, `${field} ต้องเป็นปีที่ถูกต้อง`);
  return n;
}

function requiredYear(v: unknown, field: string): number {
  const n = optYear(v, field);
  if (n == null) throw new HttpError(400, `ต้องกรอก ${field}`);
  return n;
}

function optionalSatang(b: Body, field: string): number | null {
  if (b[field] == null || b[field] === '') return null;
  return satang(b, field);
}

type TaxDocMeta = {
  taxEntityId: number;
  documentType: (typeof DOCUMENT_TYPES)[number];
  taxYear: number;
  issuerName: string;
  issuerTaxId: string | null;
  recipientTaxId: string | null;
  documentNo: string | null;
  issueDate: string | null;
  subtotalSatang: number | null;
  vatSatang: number | null;
  totalSatang: number;
  withholdingSatang: number | null;
};

function parseTaxDocMeta(b: Body): TaxDocMeta {
  return {
    taxEntityId: id(b, 'tax_entity_id'),
    documentType: enumStr(b, 'document_type', DOCUMENT_TYPES),
    taxYear: requiredYear(b.tax_year, 'tax_year'),
    issuerName: str(b, 'issuer_name', 200),
    issuerTaxId: optionalStr(b, 'issuer_tax_id', 20),
    recipientTaxId: optionalStr(b, 'recipient_tax_id', 20),
    documentNo: optionalStr(b, 'document_no', 100),
    issueDate: b.issue_date == null || b.issue_date === '' ? null : isoDate(b, 'issue_date'),
    subtotalSatang: optionalSatang(b, 'subtotal_satang'),
    vatSatang: optionalSatang(b, 'vat_satang'),
    totalSatang: satang(b, 'total_satang'),
    withholdingSatang: optionalSatang(b, 'withholding_satang'),
  };
}

// ตรวจ magic bytes → เช็คซ้ำด้วย sha256 ของ plaintext ก่อนเขียนไฟล์ (กันไฟล์เข้ารหัสค้างบนดิสก์แบบไม่มีแถวอ้างถึง) → เข้ารหัสลงดิสก์ → insert
async function createTaxDocument(
  userId: number,
  meta: TaxDocMeta,
  buf: Buffer,
  originalFilename: string,
  gmail?: { messageId: string; attachmentId: string },
) {
  const mime = detectMime(buf);
  if (!mime) throw new HttpError(400, 'ไฟล์ต้องเป็น PDF, JPEG หรือ PNG เท่านั้น');
  if (buf.length > MAX_FILE_BYTES) throw new HttpError(413, `ไฟล์ใหญ่เกิน ${MAX_FILE_BYTES / 1024 / 1024}MB`);

  await assertOwnsTaxEntity(userId, meta.taxEntityId);

  const sha256 = sha256Of(buf);
  // ต่างคนถือใบเสร็จใบเดียวกันได้ → unique ต่อ user (ดู tax_document_sha_uniq ใน migration 009) เช็คซ้ำในระดับ user เดียวกัน
  const dup = await query(
    'select 1 from tax_document where user_id = $1 and file_sha256 = $2 and archived_at is null',
    [userId, sha256],
  );
  if (dup.rowCount) throw new HttpError(409, 'เอกสารนี้เคยอัปโหลดไว้แล้ว (ไฟล์ซ้ำ)');

  const stored = await storeFile(userId, buf);

  const { rows } = await query(
    `insert into tax_document (
       user_id, tax_entity_id, document_type, tax_year, issuer_name, issuer_tax_id, recipient_tax_id,
       document_no, issue_date, subtotal_satang, vat_satang, total_satang, withholding_satang,
       storage_path, file_sha256, file_mime, file_size_bytes, original_filename,
       gmail_message_id, gmail_attachment_id
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     returning ${TAX_DOC_COLUMNS}`,
    [
      userId, meta.taxEntityId, meta.documentType, meta.taxYear, meta.issuerName, meta.issuerTaxId,
      meta.recipientTaxId, meta.documentNo, meta.issueDate, meta.subtotalSatang, meta.vatSatang,
      meta.totalSatang, meta.withholdingSatang, stored.storagePath, stored.sha256, mime, stored.size,
      originalFilename, gmail?.messageId ?? null, gmail?.attachmentId ?? null,
    ],
  );
  return rows[0];
}

taxDocumentsRouter.get('/tax-documents', requireUser(async (req, res, user) => {
  const q = req.query as Record<string, unknown>;
  const taxEntityId = optId(q, 'tax_entity_id');
  const taxYearFilter = optYear(q.tax_year, 'tax_year');
  const status = optEnumQ(q, 'status', STATUSES);
  const documentType = optEnumQ(q, 'document_type', DOCUMENT_TYPES);
  const search = typeof q.q === 'string' && q.q.trim() !== '' ? q.q.trim() : null;

  const limitRaw = q.limit == null || q.limit === '' ? LIST_LIMIT_DEFAULT : Number(q.limit);
  if (!Number.isInteger(limitRaw) || limitRaw <= 0) throw new HttpError(400, 'limit ไม่ถูกต้อง');
  const offset = q.offset == null || q.offset === '' ? 0 : Number(q.offset);
  if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, 'offset ไม่ถูกต้อง');
  const limit = Math.min(limitRaw, LIST_LIMIT_MAX);

  const filterParams = [user.id, taxEntityId, taxYearFilter, status, documentType, search];
  const filterSql = `
    where user_id = $1 and archived_at is null
      and ($2::bigint is null or tax_entity_id = $2)
      and ($3::int is null or tax_year = $3)
      and ($4::text is null or status = $4)
      and ($5::text is null or document_type = $5)
      and ($6::text is null or issuer_name ilike '%' || $6 || '%' or document_no ilike '%' || $6 || '%')`;

  const { rows } = await query(
    `select ${TAX_DOC_COLUMNS}, count(*) over () as total_count from tax_document ${filterSql}
     order by tax_year desc, issue_date desc nulls last, id desc limit $7 offset $8`,
    [...filterParams, limit, offset],
  );
  const totalCount = rows.length > 0
    ? Number(rows[0]!.total_count)
    : ((await query<{ n: number }>(`select count(*)::int as n from tax_document ${filterSql}`, filterParams)).rows[0]?.n ?? 0);

  res.json({ rows: rows.map(({ total_count: _total_count, ...r }) => r), total_count: totalCount, limit, offset });
}));

// ต้องอยู่ก่อน GET /tax-documents/:id ไม่งั้น express จับ "gmail-attachments" เป็นค่า :id
taxDocumentsRouter.get('/tax-documents/gmail-attachments', requireUser(async (req, res, user) => {
  const emailAccountId = optId(req.query as Record<string, unknown>, 'email_account_id');
  if (!emailAccountId) throw new HttpError(400, 'ต้องเลือก email_account_id');
  const searchTerm = typeof req.query.q === 'string' && req.query.q.trim() !== '' ? req.query.q.trim() : null;

  const acct = await query<{ refresh_token_enc: string }>(
    'select refresh_token_enc from email_account where id = $1 and user_id = $2',
    [emailAccountId, user.id],
  );
  if (!acct.rowCount) throw new HttpError(403, 'กล่องอีเมลนี้ไม่ใช่ของคุณ');

  const accessToken = await refreshAccessToken(decrypt(acct.rows[0]!.refresh_token_enc));
  const gmailQuery = searchTerm ? `has:attachment ${searchTerm}` : 'has:attachment';
  const messageIds = await listMessages(accessToken, gmailQuery, { maxPages: 1 });

  // ponytail: getMessage format=full ทีละข้อความ เพดานอยู่ที่ 20 ข้อความต่อครั้ง (ผู้ใช้รอผลสด ๆ) — ถ้าช้าค่อยเปลี่ยนไป format=metadata
  const candidates: {
    email_account_id: number; gmail_message_id: string; gmail_attachment_id: string;
    filename: string; mime_type: string; size: number;
  }[] = [];
  for (const messageId of messageIds.slice(0, 20)) {
    const msg = await getMessage(accessToken, messageId);
    for (const a of listAttachments(msg.payload)) {
      candidates.push({
        email_account_id: emailAccountId, gmail_message_id: messageId, gmail_attachment_id: a.attachmentId,
        filename: a.filename, mime_type: a.mimeType, size: a.size,
      });
    }
  }
  res.json(candidates);
}));

taxDocumentsRouter.post('/tax-documents', requireUser(async (req, res, user) => {
  const b = req.body as Body;
  const meta = parseTaxDocMeta(b);
  const filename = str(b, 'filename', 200);
  const fileBase64 = str(b, 'file_base64', 15_000_000);
  const buf = Buffer.from(fileBase64, 'base64');
  if (buf.length === 0) throw new HttpError(400, 'file_base64 ไม่ถูกต้อง');

  const doc = await createTaxDocument(user.id, meta, buf, filename);
  res.status(201).json(doc);
}));

taxDocumentsRouter.post('/tax-documents/from-gmail', requireUser(async (req, res, user) => {
  const b = req.body as Body;
  const emailAccountId = id(b, 'email_account_id');
  const gmailMessageId = str(b, 'gmail_message_id', 200);
  const gmailAttachmentId = str(b, 'gmail_attachment_id', 2000);
  const filename = str(b, 'filename', 200);
  const meta = parseTaxDocMeta(b);

  const acct = await query<{ refresh_token_enc: string }>(
    'select refresh_token_enc from email_account where id = $1 and user_id = $2',
    [emailAccountId, user.id],
  );
  if (!acct.rowCount) throw new HttpError(403, 'กล่องอีเมลนี้ไม่ใช่ของคุณ');

  const accessToken = await refreshAccessToken(decrypt(acct.rows[0]!.refresh_token_enc));
  const buf = await getAttachment(accessToken, gmailMessageId, gmailAttachmentId);

  const doc = await createTaxDocument(user.id, meta, buf, filename, { messageId: gmailMessageId, attachmentId: gmailAttachmentId });
  res.status(201).json(doc);
}));

taxDocumentsRouter.get('/tax-documents/:id', requireUser(async (req, res, user) => {
  const docId = pathId(req);
  const { rows } = await query(
    `select ${TAX_DOC_COLUMNS} from tax_document where id = $1 and user_id = $2 and archived_at is null`,
    [docId, user.id],
  );
  const doc = rows[0];
  if (!doc) throw new HttpError(404, 'ไม่พบเอกสาร');

  const { rows: links } = await query(
    `select l.id, l.txn_id, l.linked_amount_satang, t.txn_date, t.description, t.amount_satang, t.direction
     from tax_document_txn_link l join txn t on t.id = l.txn_id
     where l.tax_document_id = $1 order by t.txn_date`,
    [docId],
  );
  res.json({ ...doc, links });
}));

taxDocumentsRouter.patch('/tax-documents/:id', requireUser(async (req, res, user) => {
  const docId = pathId(req);
  const b = req.body as Body;

  let newTaxEntityId: number | null = null;
  if (b.tax_entity_id != null) {
    newTaxEntityId = id(b, 'tax_entity_id');
    await assertOwnsTaxEntity(user.id, newTaxEntityId);
  }

  const has = (field: string) => Object.prototype.hasOwnProperty.call(b, field);
  const documentType = b.document_type == null ? null : enumStr(b, 'document_type', DOCUMENT_TYPES);
  const taxYearValue = optYear(b.tax_year, 'tax_year');
  const issuerName = b.issuer_name == null ? null : str(b, 'issuer_name', 200);
  const issuerTaxIdProvided = has('issuer_tax_id');
  const recipientTaxIdProvided = has('recipient_tax_id');
  const documentNoProvided = has('document_no');
  const issueDateProvided = has('issue_date');
  const subtotalProvided = has('subtotal_satang');
  const vatProvided = has('vat_satang');
  const withholdingProvided = has('withholding_satang');
  const totalSatangValue = b.total_satang == null ? null : satang(b, 'total_satang');
  const status = b.status == null ? null : enumStr(b, 'status', STATUSES);

  const { rows } = await query(
    `update tax_document set
       tax_entity_id = coalesce($3, tax_entity_id),
       document_type = coalesce($4, document_type),
       tax_year = coalesce($5, tax_year),
       issuer_name = coalesce($6, issuer_name),
       issuer_tax_id = case when $7 then $8 else issuer_tax_id end,
       recipient_tax_id = case when $9 then $10 else recipient_tax_id end,
       document_no = case when $11 then $12 else document_no end,
       issue_date = case when $13 then $14 else issue_date end,
       subtotal_satang = case when $15 then $16 else subtotal_satang end,
       vat_satang = case when $17 then $18 else vat_satang end,
       total_satang = coalesce($19, total_satang),
       withholding_satang = case when $20 then $21 else withholding_satang end,
       status = coalesce($22, status),
       verified_at = case when $22 = 'verified' then now() when $22 = 'draft' then null else verified_at end,
       updated_at = now()
     where id = $1 and user_id = $2 and archived_at is null
     returning ${TAX_DOC_COLUMNS}`,
    [
      docId, user.id, newTaxEntityId, documentType, taxYearValue, issuerName,
      issuerTaxIdProvided, issuerTaxIdProvided ? optionalStr(b, 'issuer_tax_id', 20) : null,
      recipientTaxIdProvided, recipientTaxIdProvided ? optionalStr(b, 'recipient_tax_id', 20) : null,
      documentNoProvided, documentNoProvided ? optionalStr(b, 'document_no', 100) : null,
      issueDateProvided, issueDateProvided ? (b.issue_date == null || b.issue_date === '' ? null : isoDate(b, 'issue_date')) : null,
      subtotalProvided, subtotalProvided ? optionalSatang(b, 'subtotal_satang') : null,
      vatProvided, vatProvided ? optionalSatang(b, 'vat_satang') : null,
      totalSatangValue,
      withholdingProvided, withholdingProvided ? optionalSatang(b, 'withholding_satang') : null,
      status,
    ],
  );
  if (!rows[0]) throw new HttpError(404, 'ไม่พบเอกสาร');
  res.json(rows[0]);
}));

// เก็บเข้าคลัง (archive) แทนลบจริง — ไฟล์ยังอยู่บนดิสก์ (เข้ารหัสอยู่) ไม่ลบตาม §17 "Hard Delete ทำลายประวัติ"
taxDocumentsRouter.delete('/tax-documents/:id', requireUser(async (req, res, user) => {
  const docId = pathId(req);
  const { rowCount } = await query(
    'update tax_document set archived_at = now(), updated_at = now() where id = $1 and user_id = $2 and archived_at is null',
    [docId, user.id],
  );
  if (!rowCount) throw new HttpError(404, 'ไม่พบเอกสาร');
  res.status(204).end();
}));

// §10.4: authorization ทุกครั้งก่อนเปิดไฟล์ + audit การดาวน์โหลด — where user_id=$2 กันแม้แต่ admin เปิดของคนอื่นไม่ได้ (404 ไม่ใช่ 403 กันรั่วว่ามีอยู่จริง)
// เขียน audit ให้ commit ก่อนเสมอแล้วค่อยส่งไฟล์ — log ล้ม = ไม่ได้ไฟล์ ห้าม catch เงียบ ๆ ไม่งั้น "audit การดาวน์โหลด" เป็นโมฆะ
taxDocumentsRouter.get('/tax-documents/:id/file', requireUser(async (req, res, user) => {
  const docId = pathId(req);
  const { rows } = await query<{ storage_path: string; file_mime: string; original_filename: string }>(
    `select storage_path, file_mime, original_filename from tax_document
     where id = $1 and user_id = $2 and archived_at is null`,
    [docId, user.id],
  );
  const doc = rows[0];
  if (!doc) throw new HttpError(404, 'ไม่พบเอกสาร');

  await audit(pool, {
    userId: user.id, action: 'tax_document.download', entityType: 'tax_document', entityId: docId, ip: req.ip ?? null,
  });

  const buf = await readStoredFile(doc.storage_path);
  res.setHeader('content-type', doc.file_mime);
  res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.original_filename)}`);
  res.send(buf);
}));

type LinkInput = { txn_id: number; linked_amount_satang: number };

function parseLinks(body: unknown): LinkInput[] {
  if (!Array.isArray(body)) throw new HttpError(400, 'ต้องส่ง array ของรายการเชื่อม transaction');
  return body.map((item, i) => {
    if (typeof item !== 'object' || item === null) throw new HttpError(400, `รายการที่ ${i + 1} ไม่ถูกต้อง`);
    const o = item as Body;
    const amount = satang(o, 'linked_amount_satang');
    if (amount <= 0) throw new HttpError(400, `จำนวนเงินของรายการที่ ${i + 1} ต้องมากกว่า 0`);
    return { txn_id: id(o, 'txn_id'), linked_amount_satang: amount };
  });
}

taxDocumentsRouter.put('/tax-documents/:id/links', requireUser(async (req, res, user) => {
  const docId = pathId(req);
  const links = parseLinks(req.body);

  const result = await tx(async (c) => {
    const doc = await c.query('select id from tax_document where id = $1 and user_id = $2 and archived_at is null', [docId, user.id]);
    if (!doc.rowCount) throw new HttpError(404, 'ไม่พบเอกสาร');

    const txnIds = [...new Set(links.map((l) => l.txn_id))];
    if (txnIds.length) {
      const owned = await c.query(
        `select t.id from txn t join bank_account a on a.id = t.bank_account_id where a.user_id = $1 and t.id = any($2)`,
        [user.id, txnIds],
      );
      if (owned.rowCount !== txnIds.length) throw new HttpError(400, 'มีธุรกรรมที่ไม่ใช่ของคุณ');
    }

    const before = (await c.query(
      'select txn_id, linked_amount_satang from tax_document_txn_link where tax_document_id = $1 order by txn_id',
      [docId],
    )).rows;

    await c.query('delete from tax_document_txn_link where tax_document_id = $1', [docId]);
    for (const l of links) {
      await c.query(
        'insert into tax_document_txn_link (tax_document_id, txn_id, linked_amount_satang) values ($1, $2, $3)',
        [docId, l.txn_id, l.linked_amount_satang],
      );
    }

    const after = (await c.query(
      'select txn_id, linked_amount_satang from tax_document_txn_link where tax_document_id = $1 order by txn_id',
      [docId],
    )).rows;

    await audit(c, {
      userId: user.id, action: 'tax_document.link_txn', entityType: 'tax_document', entityId: docId,
      before, after, ip: req.ip ?? null,
    });

    return after;
  });

  res.json(result);
}));
