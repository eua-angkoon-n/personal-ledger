import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createTestDb } from './helpers/db.js';

process.env.ENCRYPTION_KEY = '0'.repeat(64);

// Slice 7: end-to-end ผ่าน HTTP จริง (ไม่ใช่เรียก service ตรง ๆ) — ครอบ DoD ทั้งสี่ข้อของ §14:
// เจ้าของ+tax entity ชัดเจน, เข้ารหัส+dedupe, เชื่อม transaction ย้อนกลับได้, และ audit การดาวน์โหลด/เชื่อม
test('tax document vault: upload, dedupe, link, verify, download, audit, archive', async (t) => {
  const db = await createTestDb();
  if (db.skip) {
    t.skip(db.reason);
    return;
  }
  t.after(db.cleanup);
  await db.migrate();

  const dir = await mkdtemp(join(tmpdir(), 'tax-vault-e2e-'));
  process.env.TAX_DOC_STORAGE_DIR = dir;
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { HttpError } = await import('../src/http.js');
  const { taxEntitiesRouter } = await import('../src/routes/tax-entities.js');
  const { taxDocumentsRouter } = await import('../src/routes/tax-documents.js');

  function appFor(userId: number) {
    const app = express();
    // mirror server.ts: limit ใหญ่กว่าสำหรับ /api/tax-documents ต้องมาก่อน limit ทั่วไปเสมอ
    app.use('/api/tax-documents', express.json({ limit: '15mb' }));
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { session: { userId?: number } }).session = { userId };
      next();
    });
    app.use('/api', taxEntitiesRouter);
    app.use('/api', taxDocumentsRouter);
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
      const code = (err as { code?: string }).code;
      if (code === '23505') return void res.status(409).json({ error: 'ซ้ำ' });
      console.error(err);
      res.status(500).json({ error: 'internal' });
    });
    return app;
  }

  async function listen(app: express.Express) {
    const server = app.listen(0);
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not open a TCP port');
    const base = `http://127.0.0.1:${address.port}`;
    return { request: (path: string, init?: RequestInit) => fetch(`${base}${path}`, init), close: () => server.close() };
  }

  const userA = (
    await db.pool.query<{ id: number }>(
      `insert into app_user (google_sub, email, display_name, is_admin, status)
       values ('google-sub-tax-a', 'tax-a@example.com', 'Tax A', false, 'approved') returning id`,
    )
  ).rows[0]!.id;

  const emailAccountId = (
    await db.pool.query<{ id: number }>(
      `insert into email_account (user_id, email, refresh_token_enc)
       values ($1, 'tax-a@example.com', 'enc:refresh-token') returning id`,
      [userA],
    )
  ).rows[0]!.id;

  const bankId = (await db.pool.query<{ id: number }>(`select id from bank where lower(name) = 'scb'`)).rows[0]!.id;

  const bankAccountId = (
    await db.pool.query<{ id: number }>(
      `insert into bank_account (user_id, bank_id, email_account_id, nickname, account_number, pdf_password_enc)
       values ($1, $2, $3, 'บัญชีหลัก', 'xxx-x-x6231-x', 'enc:pdf-password') returning id`,
      [userA, bankId, emailAccountId],
    )
  ).rows[0]!.id;

  const statementId = (
    await db.pool.query<{ id: number }>(
      `insert into statement (bank_account_id, gmail_message_id, gmail_attachment_id, period_start, period_end, status)
       values ($1, 'gmail-msg-1', 'gmail-att-1', '2026-08-01', '2026-08-31', 'parsed') returning id`,
      [bankAccountId],
    )
  ).rows[0]!.id;

  const txnId = (
    await db.pool.query<{ id: number }>(
      `insert into txn (statement_id, bank_account_id, txn_date, description, amount_satang, direction, running_balance_satang)
       values ($1, $2, '2026-08-15', 'ซื้อของใช้สำนักงาน', 10000, 'debit', 490000) returning id`,
      [statementId, bankAccountId],
    )
  ).rows[0]!.id;

  const app = await listen(appFor(userA));
  t.after(app.close);

  const pdfBytes = Buffer.from('%PDF-1.4\n%เอกสารภาษีตัวอย่างสำหรับทดสอบ\n');

  let taxEntityId: number;
  await t.test('สร้าง tax entity', async () => {
    const res = await app.request('/api/tax-entities', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entity_type: 'individual', display_name: 'บุคคลธรรมดา' }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { id: number; has_tax_id: boolean };
    assert.equal(body.has_tax_id, false);
    taxEntityId = body.id;
  });

  let docId: number;
  await t.test('อัปโหลดเอกสารภาษี — ไฟล์บนดิสก์ต้องเข้ารหัสอยู่', async () => {
    const res = await app.request('/api/tax-documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tax_entity_id: taxEntityId,
        document_type: 'receipt',
        tax_year: 2026,
        issuer_name: 'ร้านค้าตัวอย่าง',
        total_satang: 10000,
        filename: 'receipt.pdf',
        file_base64: pdfBytes.toString('base64'),
      }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { id: number; status: string; file_mime: string };
    assert.equal(body.status, 'draft');
    assert.equal(body.file_mime, 'application/pdf');
    docId = body.id;

    const stored = (
      await db.pool.query<{ storage_path: string }>('select storage_path from tax_document where id = $1', [docId])
    ).rows[0]!;
    const onDisk = await readFile(stored.storage_path);
    assert.notEqual(onDisk.toString('latin1').slice(0, 5), '%PDF-');
  });

  await t.test('อัปโหลดไฟล์เดิมซ้ำ → 409', async () => {
    const res = await app.request('/api/tax-documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tax_entity_id: taxEntityId,
        document_type: 'receipt',
        tax_year: 2026,
        issuer_name: 'ร้านค้าตัวอย่าง',
        total_satang: 10000,
        filename: 'receipt-copy.pdf',
        file_base64: pdfBytes.toString('base64'),
      }),
    });
    assert.equal(res.status, 409);
  });

  await t.test('ดาวน์โหลดได้ไบต์เดิมเป๊ะ + header ถูก + มี audit log', async () => {
    const res = await app.request(`/api/tax-documents/${docId}/file`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition') ?? '', /receipt\.pdf/);
    const downloaded = Buffer.from(await res.arrayBuffer());
    assert.ok(downloaded.equals(pdfBytes));

    const auditRows = (
      await db.pool.query<{ ip_address: string | null }>(
        `select ip_address from audit_log where user_id = $1 and action = 'tax_document.download' and entity_id = $2`,
        [userA, docId],
      )
    ).rows;
    assert.equal(auditRows.length, 1);
    assert.ok(auditRows[0]!.ip_address);
  });

  await t.test('เชื่อม transaction — ตรวจย้อนกลับได้และมี audit log', async () => {
    const res = await app.request(`/api/tax-documents/${docId}/links`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ txn_id: txnId, linked_amount_satang: 10000 }]),
    });
    assert.equal(res.status, 200);
    const links = (await res.json()) as { txn_id: number; linked_amount_satang: number }[];
    assert.deepEqual(links, [{ txn_id: txnId, linked_amount_satang: 10000 }]);

    const detail = await (await app.request(`/api/tax-documents/${docId}`)).json() as {
      links: { txn_id: number; description: string }[];
    };
    assert.equal(detail.links.length, 1);
    assert.equal(detail.links[0]!.txn_id, txnId);

    const auditRows = (
      await db.pool.query(`select before_data, after_data from audit_log where action = 'tax_document.link_txn' and entity_id = $1`, [docId])
    ).rows;
    assert.equal(auditRows.length, 1);
    assert.deepEqual(auditRows[0]!.before_data, []);
  });

  await t.test('เปลี่ยนสถานะเป็น verified ตั้ง verified_at', async () => {
    const res = await app.request(`/api/tax-documents/${docId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'verified' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; verified_at: string | null };
    assert.equal(body.status, 'verified');
    assert.ok(body.verified_at);
  });

  await t.test('list กรองด้วย tax_entity_id เห็นเอกสารที่สร้างไว้', async () => {
    const res = await app.request(`/api/tax-documents?tax_entity_id=${taxEntityId}`);
    const body = (await res.json()) as { rows: { id: number }[]; total_count: number };
    assert.equal(body.total_count, 1);
    assert.ok(body.rows.some((r) => r.id === docId));
  });

  await t.test('archive แล้วหายจาก list/detail และอัปโหลด sha เดิมใหม่ได้', async () => {
    const del = await app.request(`/api/tax-documents/${docId}`, { method: 'DELETE' });
    assert.equal(del.status, 204);

    const detail = await app.request(`/api/tax-documents/${docId}`);
    assert.equal(detail.status, 404);

    const list = await app.request(`/api/tax-documents?tax_entity_id=${taxEntityId}`);
    const body = (await list.json()) as { total_count: number };
    assert.equal(body.total_count, 0);

    const reupload = await app.request('/api/tax-documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tax_entity_id: taxEntityId,
        document_type: 'receipt',
        tax_year: 2026,
        issuer_name: 'ร้านค้าตัวอย่าง',
        total_satang: 10000,
        filename: 'receipt-again.pdf',
        file_base64: pdfBytes.toString('base64'),
      }),
    });
    assert.equal(reupload.status, 201);
  });
});
