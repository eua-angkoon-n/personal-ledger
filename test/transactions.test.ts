// Slice 4A T4: category/annotation/split/transfer-match — ต่อ Postgres จริงผ่าน test/helpers/db.ts
// ห้าม static import จาก src/* ที่แตะ src/db.ts (อ่าน env.databaseUrl ตอน import) ก่อน createTestDb()
// ตั้ง DATABASE_URL ให้ชี้ scratch database เสียก่อน — ดู comment ใน test/helpers/db.ts
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express, { type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import { createTestDb } from './helpers/db.js';

test('ledger classification API: category / annotation / split / transfer-match', async (t) => {
  const db = await createTestDb();
  if (db.skip) {
    t.skip(db.reason);
    return;
  }
  t.after(db.cleanup);
  await db.migrate();

  const { api, HttpError } = await import('../src/api.js');
  const { reconcileTransfers } = await import('../src/services/transfer-matching.js');

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret-test-secret-test-secret', resave: false, saveUninitialized: false }));
  app.post('/test/login', (req, res) => {
    req.session.userId = Number((req.body as { userId: number }).userId);
    res.json({ ok: true });
  });
  app.use('/api', api);
  // ก็อปพฤติกรรมย่อของ error handler กลางใน src/server.ts (ไม่ export ให้ import ตรง ๆ)
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
    if ((err as { code?: string }).code === '23505') return void res.status(409).json({ error: 'ซ้ำ' });
    console.error(err);
    res.status(500).json({ error: 'internal' });
  });

  const server = app.listen(0);
  t.after(() => server.close());
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server ไม่ได้เปิดพอร์ต');

  let cookie = '';
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('cookie', cookie);
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers });
    const setCookie = res.headers.getSetCookie()[0];
    if (setCookie) cookie = setCookie.split(';', 1)[0]!;
    return res;
  };

  // ผู้ใช้คนเดียวตลอดไฟล์ — cross-user authorization เป็น T7 แยกต่างหาก ที่นี่แค่ต้อง scope ด้วย user.id ให้ถูก
  const user = await db.pool.query<{ id: number }>(
    `insert into app_user (google_sub, email, display_name, is_admin, status)
     values ('google-sub-1', 'member@example.com', 'Family Member', false, 'approved') returning id`,
  );
  const userId = user.rows[0]!.id;
  await request('/test/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });

  const emailAccount = await db.pool.query<{ id: number }>(
    `insert into email_account (user_id, email, refresh_token_enc)
     values ($1, 'member@example.com', 'enc:refresh-token') returning id`,
    [userId],
  );
  const emailAccountId = emailAccount.rows[0]!.id;

  const bank = await db.pool.query<{ id: number }>(`select id from bank where lower(name) = 'scb'`);
  const bankId = bank.rows[0]!.id;

  async function seedAccount(accountNumber: string): Promise<number> {
    const row = await db.pool.query<{ id: number }>(
      `insert into bank_account (user_id, bank_id, email_account_id, nickname, account_number, pdf_password_enc)
       values ($1, $2, $3, 'บัญชีทดสอบ', $4, 'enc:x') returning id`,
      [userId, bankId, emailAccountId, accountNumber],
    );
    return row.rows[0]!.id;
  }

  async function seedStatement(bankAccountId: number, gmailMessageId: string): Promise<number> {
    const row = await db.pool.query<{ id: number }>(
      `insert into statement (bank_account_id, gmail_message_id, gmail_attachment_id, period_start, period_end, status)
       values ($1, $2, $2, '2026-08-01', '2026-08-31', 'parsed') returning id`,
      [bankAccountId, gmailMessageId],
    );
    return row.rows[0]!.id;
  }

  async function seedTxn(
    statementId: number,
    bankAccountId: number,
    opts: {
      txnDate: string;
      txnTime?: string;
      description?: string;
      amount: number;
      direction: 'credit' | 'debit';
      runningBalance: number;
    },
  ): Promise<number> {
    const row = await db.pool.query<{ id: number }>(
      `insert into txn (statement_id, bank_account_id, txn_date, txn_time, description, amount_satang, direction, running_balance_satang)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        statementId,
        bankAccountId,
        opts.txnDate,
        opts.txnTime ?? null,
        opts.description ?? '',
        opts.amount,
        opts.direction,
        opts.runningBalance,
      ],
    );
    return row.rows[0]!.id;
  }

  await t.test('annotation: upsert สร้างครั้งแรกแล้วแก้ซ้ำได้', async () => {
    const accountId = await seedAccount('111-1-11111-1');
    const statementId = await seedStatement(accountId, 'msg-anno-1');
    const txnId = await seedTxn(statementId, accountId, {
      txnDate: '2026-08-05',
      amount: 10000,
      direction: 'debit',
      runningBalance: 90000,
    });

    const first = await request(`/api/transactions/${txnId}/annotation`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ classification: 'expense', note: 'ค่ากาแฟ' }),
    });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { classification: string; review_status: string; reviewed_at: string };
    assert.equal(firstBody.classification, 'expense');
    assert.equal(firstBody.review_status, 'reviewed');
    assert.ok(firstBody.reviewed_at);

    const second = await request(`/api/transactions/${txnId}/annotation`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ classification: 'excluded' }),
    });
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as { classification: string; note: string | null };
    assert.equal(secondBody.classification, 'excluded');
    assert.equal(secondBody.note, null);

    const count = await db.pool.query('select count(*)::int as n from txn_annotation where txn_id = $1', [txnId]);
    assert.equal(count.rows[0]!.n, 1);

    const invalid = await request(`/api/transactions/${txnId}/annotation`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ classification: 'nope' }),
    });
    assert.equal(invalid.status, 400);
  });

  // §10.1: transaction override tax entity ของ bank account ได้ — ไม่ส่ง field นี้มา = ไม่แตะค่าเดิม
  // (ต่างจาก classification/note ที่ full-replace ทุกครั้งตามเทสต์ด้านบน)
  await t.test('annotation: ตั้ง tax_entity_id override ได้, ไม่ส่งมา = ไม่แตะ, ส่ง null มา = ล้าง', async () => {
    const accountId = await seedAccount('131-3-13131-3');
    const statementId = await seedStatement(accountId, 'msg-anno-tax-entity');
    const txnId = await seedTxn(statementId, accountId, {
      txnDate: '2026-08-06', amount: 15000, direction: 'debit', runningBalance: 85000,
    });
    const entity = await db.pool.query<{ id: number }>(
      `insert into tax_entity (user_id, entity_type, display_name) values ($1, 'individual', 'บุคคลธรรมดา') returning id`,
      [userId],
    );
    const entityId = entity.rows[0]!.id;

    const withEntity = await request(`/api/transactions/${txnId}/annotation`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ classification: 'expense', tax_entity_id: entityId }),
    });
    assert.equal(withEntity.status, 200);
    assert.equal((await withEntity.json() as { tax_entity_id: number }).tax_entity_id, entityId);

    const omitted = await request(`/api/transactions/${txnId}/annotation`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ classification: 'excluded' }),
    });
    assert.equal((await omitted.json() as { tax_entity_id: number }).tax_entity_id, entityId);

    const cleared = await request(`/api/transactions/${txnId}/annotation`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ classification: 'expense', tax_entity_id: null }),
    });
    assert.equal((await cleared.json() as { tax_entity_id: number | null }).tax_entity_id, null);

    const detail = await (await request(`/api/transactions/${txnId}`)).json() as { tax_entity_id: number | null };
    assert.equal(detail.tax_entity_id, null);
  });

  await t.test('transaction: จำแนก credit/debit เป็นรายรับ/รายจ่ายและถือว่าตรวจแล้วโดยอัตโนมัติ', async () => {
    const accountId = await seedAccount('121-2-12121-2');
    const statementId = await seedStatement(accountId, 'msg-auto-classify');
    const creditTxn = await seedTxn(statementId, accountId, {
      txnDate: '2026-08-05',
      amount: 11001,
      direction: 'credit',
      runningBalance: 111001,
    });
    const debitTxn = await seedTxn(statementId, accountId, {
      txnDate: '2026-08-06',
      amount: 12002,
      direction: 'debit',
      runningBalance: 98999,
    });

    const income = (await (await request(`/api/transactions/${creditTxn}`)).json()) as {
      classification: string;
      review_status: string;
    };
    const expense = (await (await request(`/api/transactions/${debitTxn}`)).json()) as {
      classification: string;
      review_status: string;
    };
    assert.equal(income.classification, 'income');
    assert.equal(income.review_status, 'reviewed');
    assert.equal(expense.classification, 'expense');
    assert.equal(expense.review_status, 'reviewed');
  });

  await t.test('category: system + own, สร้างของตัวเองได้, PATCH is_active กรองได้', async () => {
    const list = await request('/api/categories');
    assert.equal(list.status, 200);
    const systemRows = (await list.json()) as { id: number; is_system: boolean; user_id: number | null }[];
    assert.equal(systemRows.filter((c) => c.is_system && c.user_id === null).length, 13);

    const created = await request('/api/categories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ของใช้ทดสอบ', kind: 'expense' }),
    });
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as { id: number; is_system: boolean; user_id: number };
    assert.equal(createdBody.is_system, false);
    assert.equal(createdBody.user_id, userId);

    const patched = await request(`/api/categories/${createdBody.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ is_active: false }),
    });
    assert.equal(patched.status, 200);

    const activeOnly = await request('/api/categories?is_active=true');
    const activeIds = ((await activeOnly.json()) as { id: number }[]).map((c) => c.id);
    assert.ok(!activeIds.includes(createdBody.id));

    const everything = await request('/api/categories');
    const allIds = ((await everything.json()) as { id: number }[]).map((c) => c.id);
    assert.ok(allIds.includes(createdBody.id));
  });

  await t.test('splits: รวมเท่าผ่านและอ่านกลับได้ / รวมไม่เท่าถูกปฏิเสธและไม่ทิ้งร่องรอย', async () => {
    const accountId = await seedAccount('222-2-22222-2');
    const statementId = await seedStatement(accountId, 'msg-split-1');
    const txnId = await seedTxn(statementId, accountId, {
      txnDate: '2026-08-06',
      amount: 15000,
      direction: 'debit',
      runningBalance: 75000,
    });

    const categories = await db.pool.query<{ id: number }>(
      `select id from category where is_system = true and kind = 'expense' order by id limit 2`,
    );
    const [cat1, cat2] = categories.rows;

    const good = await request(`/api/transactions/${txnId}/splits`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([
        { category_id: cat1!.id, amount_satang: 10000 },
        { category_id: cat2!.id, amount_satang: 5000, note: 'ส่วนที่สอง' },
      ]),
    });
    assert.equal(good.status, 200);
    const goodRows = (await good.json()) as { category_id: number; amount_satang: number }[];
    assert.equal(goodRows.length, 2);

    // รวมไม่เท่ายอด txn (15000) — ต้อง 400 และแถวเดิม 2 แถวต้องยังอยู่ครบ (พิสูจน์ rollback ทั้ง delete และ insert)
    const bad = await request(`/api/transactions/${txnId}/splits`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ category_id: cat1!.id, amount_satang: 5000 }]),
    });
    assert.equal(bad.status, 400);

    const persisted = await db.pool.query<{ amount_satang: number }>(
      'select amount_satang from txn_split where txn_id = $1 order by amount_satang',
      [txnId],
    );
    assert.deepEqual(persisted.rows.map((r) => r.amount_satang), [5000, 10000]);

    // array ว่าง = ล้าง split กลับเป็นศูนย์ (deferred item จาก 4A postmortem)
    const cleared = await request(`/api/transactions/${txnId}/splits`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([]),
    });
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), []);

    const afterClear = await db.pool.query('select count(*)::int as n from txn_split where txn_id = $1', [txnId]);
    assert.equal(afterClear.rows[0]!.n, 0);
  });

  await t.test('transfer-match: คู่หนึ่งต่อหนึ่งถูกยืนยันอัตโนมัติและพลิก is_internal_transfer ทั้งสองฝั่ง', async () => {
    const accountA = await seedAccount('333-3-33333-3');
    const accountB = await seedAccount('444-4-44444-4');
    const stmtA = await seedStatement(accountA, 'msg-tx-a');
    const stmtB = await seedStatement(accountB, 'msg-tx-b');

    const debitTxn = await seedTxn(stmtA, accountA, {
      txnDate: '2026-08-07',
      txnTime: '10:00:00',
      description: 'โอนเงินไปบัญชีตนเอง',
      amount: 20000,
      direction: 'debit',
      runningBalance: 100000,
    });
    const creditTxn = await seedTxn(stmtB, accountB, {
      txnDate: '2026-08-07',
      txnTime: '10:02:00',
      description: 'รับโอนเงิน',
      amount: 20000,
      direction: 'credit',
      runningBalance: 300000,
    });

    assert.deepEqual(await reconcileTransfers(db.pool, userId), { confirmed: 1, suggested: 0 });
    // เรียกซ้ำต้องไม่ insert หรือยืนยันคู่เดิมซ้ำ
    assert.deepEqual(await reconcileTransfers(db.pool, userId), { confirmed: 0, suggested: 0 });

    const matchRow = await db.pool.query<{ id: number; status: string }>(
      'select id, status from transfer_match where debit_txn_id = $1 and credit_txn_id = $2',
      [debitTxn, creditTxn],
    );
    assert.equal(matchRow.rows[0]!.status, 'confirmed');

    const flipped = await db.pool.query<{ is_internal_transfer: boolean }>(
      'select is_internal_transfer from txn where id = any($1)',
      [[debitTxn, creditTxn]],
    );
    assert.ok(flipped.rows.every((r) => r.is_internal_transfer === true));

    const detail = (await (await request(`/api/transactions/${debitTxn}`)).json()) as { classification: string };
    assert.equal(detail.classification, 'internal_transfer');

    // คู่ที่สองผูก debitTxn เดิมกับ credit อีกใบ — ยืนยันแล้วต้องชน partial unique index (23505) → 409
    const otherCreditTxn = await seedTxn(stmtB, accountB, {
      txnDate: '2026-08-08',
      amount: 20000,
      direction: 'credit',
      runningBalance: 320000,
    });
    const otherMatch = await db.pool.query<{ id: number }>(
      `insert into transfer_match (user_id, debit_txn_id, credit_txn_id, status, matched_by, confidence)
       values ($1, $2, $3, 'suggested', 'system', 0.8) returning id`,
      [userId, debitTxn, otherCreditTxn],
    );
    const conflict = await request(`/api/transfer-matches/${otherMatch.rows[0]!.id}/confirm`, { method: 'POST' });
    assert.equal(conflict.status, 409);

    // otherMatch ผูก debitTxn เดิมที่ confirm ไปแล้วกับคู่แรก — list ต้องกรองออก ไม่งั้นกดแล้วเจอ 409 ซ้ำ
    const list = (await (await request('/api/transfer-matches?status=suggested')).json()) as { id: number }[];
    assert.ok(!list.some((m) => m.id === otherMatch.rows[0]!.id));
  });

  await t.test('transfer-match: ยอดบังเอิญตรงกันแต่ไม่มีสัญญาณการโอนต้องไม่ auto-confirm', async () => {
    const accountA = await seedAccount('343-4-34343-4');
    const accountB = await seedAccount('454-5-45454-5');
    const stmtA = await seedStatement(accountA, 'msg-weak-a');
    const stmtB = await seedStatement(accountB, 'msg-weak-b');
    const debitTxn = await seedTxn(stmtA, accountA, {
      txnDate: '2026-08-20',
      txnTime: '12:00:00',
      description: 'ซื้อของใช้',
      amount: 23456,
      direction: 'debit',
      runningBalance: 76544,
    });
    const creditTxn = await seedTxn(stmtB, accountB, {
      txnDate: '2026-08-20',
      txnTime: '12:01:00',
      description: 'เงินเดือน',
      amount: 23456,
      direction: 'credit',
      runningBalance: 123456,
    });

    const result = await reconcileTransfers(db.pool, userId);
    assert.equal(result.confirmed, 0);
    const match = await db.pool.query<{ status: string }>(
      'select status from transfer_match where debit_txn_id = $1 and credit_txn_id = $2',
      [debitTxn, creditTxn],
    );
    assert.equal(match.rows[0]!.status, 'suggested');
  });

  await t.test('transfer-match: reject ไม่แตะ is_internal_transfer', async () => {
    const accountA = await seedAccount('555-5-55555-5');
    const accountB = await seedAccount('666-6-66666-6');
    const stmtA = await seedStatement(accountA, 'msg-rej-a');
    const stmtB = await seedStatement(accountB, 'msg-rej-b');
    const debitTxn = await seedTxn(stmtA, accountA, {
      txnDate: '2026-08-09',
      amount: 30000,
      direction: 'debit',
      runningBalance: 70000,
    });
    const creditTxn = await seedTxn(stmtB, accountB, {
      txnDate: '2026-08-09',
      amount: 30000,
      direction: 'credit',
      runningBalance: 350000,
    });

    const match = await db.pool.query<{ id: number }>(
      `insert into transfer_match (user_id, debit_txn_id, credit_txn_id, status, matched_by, confidence)
       values ($1, $2, $3, 'suggested', 'system', 0.8) returning id`,
      [userId, debitTxn, creditTxn],
    );

    const rejected = await request(`/api/transfer-matches/${match.rows[0]!.id}/reject`, { method: 'POST' });
    assert.equal(rejected.status, 200);

    const status = await db.pool.query<{ status: string }>('select status from transfer_match where id = $1', [
      match.rows[0]!.id,
    ]);
    assert.equal(status.rows[0]!.status, 'rejected');

    const untouched = await db.pool.query<{ is_internal_transfer: boolean }>(
      'select is_internal_transfer from txn where id = any($1)',
      [[debitTxn, creditTxn]],
    );
    assert.ok(untouched.rows.every((r) => r.is_internal_transfer === false));
  });

  await t.test('transfer-match: reject หลัง confirm ต้องล้าง is_internal_transfer กลับ', async () => {
    const accountA = await seedAccount('777-7-77777-7');
    const accountB = await seedAccount('888-8-88888-8');
    const stmtA = await seedStatement(accountA, 'msg-unconfirm-a');
    const stmtB = await seedStatement(accountB, 'msg-unconfirm-b');
    const debitTxn = await seedTxn(stmtA, accountA, {
      txnDate: '2026-08-10',
      amount: 40000,
      direction: 'debit',
      runningBalance: 60000,
    });
    const creditTxn = await seedTxn(stmtB, accountB, {
      txnDate: '2026-08-10',
      amount: 40000,
      direction: 'credit',
      runningBalance: 400000,
    });

    const match = await db.pool.query<{ id: number }>(
      `insert into transfer_match (user_id, debit_txn_id, credit_txn_id, status, matched_by, confidence)
       values ($1, $2, $3, 'suggested', 'system', 0.8) returning id`,
      [userId, debitTxn, creditTxn],
    );
    const matchId = match.rows[0]!.id;

    const confirmed = await request(`/api/transfer-matches/${matchId}/confirm`, { method: 'POST' });
    assert.equal(confirmed.status, 200);
    const afterConfirm = await db.pool.query<{ is_internal_transfer: boolean }>(
      'select is_internal_transfer from txn where id = any($1)',
      [[debitTxn, creditTxn]],
    );
    assert.ok(afterConfirm.rows.every((r) => r.is_internal_transfer === true));

    // ยกเลิกคู่ที่เคย confirmed แล้ว — flag ต้องถูกล้างกลับเป็น false ทั้งสองฝั่ง ไม่ค้างเป็น true ถาวร
    const rejected = await request(`/api/transfer-matches/${matchId}/reject`, { method: 'POST' });
    assert.equal(rejected.status, 200);
    const afterReject = await db.pool.query<{ is_internal_transfer: boolean }>(
      'select is_internal_transfer from txn where id = any($1)',
      [[debitTxn, creditTxn]],
    );
    assert.ok(afterReject.rows.every((r) => r.is_internal_transfer === false));
  });

  await t.test('transfer-match: GET ?status=suggested คืน shape ทั้งสองฝั่ง และ txn_date เป็น string ธรรมดา', async () => {
    const accountC = await seedAccount('999-9-99999-9');
    const accountD = await seedAccount('000-0-00000-0');
    const accountE = await seedAccount('010-1-01010-1');
    const stmtC = await seedStatement(accountC, 'msg-list-c');
    const stmtD = await seedStatement(accountD, 'msg-list-d');
    const stmtE = await seedStatement(accountE, 'msg-list-e');
    const debitTxn = await seedTxn(stmtC, accountC, {
      txnDate: '2026-08-11',
      amount: 50000,
      direction: 'debit',
      runningBalance: 50000,
    });
    const creditTxn = await seedTxn(stmtD, accountD, {
      txnDate: '2026-08-11',
      amount: 50000,
      direction: 'credit',
      runningBalance: 500000,
    });
    await seedTxn(stmtE, accountE, {
      txnDate: '2026-08-11',
      amount: 50000,
      direction: 'credit',
      runningBalance: 550000,
    });

    // debit เดียวมี credit ที่เป็นไปได้สองรายการ จึงยังไม่ auto-confirm และส่งให้ผู้ใช้ตัดสินใจ
    assert.ok((await reconcileTransfers(db.pool, userId)).suggested >= 2);

    const res = await request('/api/transfer-matches?status=suggested');
    assert.equal(res.status, 200);
    const rows = (await res.json()) as {
      id: number;
      status: string;
      confidence: number;
      debit_txn_id: number;
      debit_txn_date: string;
      debit_amount_satang: number;
      debit_direction: string;
      debit_account_nickname: string;
      credit_txn_id: number;
      credit_txn_date: string;
      credit_amount_satang: number;
      credit_direction: string;
      credit_account_nickname: string;
    }[];
    const match = rows.find((r) => r.debit_txn_id === debitTxn && r.credit_txn_id === creditTxn);
    assert.ok(match, 'ต้องเจอคู่ที่เพิ่ง suggest ใน response');
    assert.equal(match!.status, 'suggested');
    assert.equal(typeof match!.confidence, 'number'); // confidence เป็น numeric ใน DB, pg คืน string ต้องถูก cast ที่ query
    assert.equal(match!.debit_amount_satang, 50000);
    assert.equal(match!.debit_direction, 'debit');
    assert.equal(match!.debit_account_nickname, 'บัญชีทดสอบ');
    assert.equal(match!.credit_amount_satang, 50000);
    assert.equal(match!.credit_direction, 'credit');
    assert.equal(match!.credit_account_nickname, 'บัญชีทดสอบ');
    // ปักหมุด DATE type parser (src/db.ts): ต้องเป็น 'YYYY-MM-DD' ตรงตัว ไม่ใช่ ISO timestamp ที่ถูกเลื่อนวันจาก UTC conversion
    assert.equal(match!.debit_txn_date, '2026-08-11');
    assert.equal(match!.credit_txn_date, '2026-08-11');

    // status อื่นที่ผู้ใช้ไม่ได้ขอต้องไม่หลุดมา (คู่ confirmed จากเทสต์ก่อนหน้าต้องไม่โผล่ใน suggested)
    const confirmedRows = (await (await request('/api/transfer-matches?status=confirmed')).json()) as {
      id: number;
      status: string;
    }[];
    assert.ok(confirmedRows.every((r) => r.status === 'confirmed'));
    assert.ok(!rows.some((r) => r.status !== 'suggested'));
  });
});
