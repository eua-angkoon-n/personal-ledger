// Slice 4A T7: cross-user authorization — User A ห้ามเข้าถึง/แก้ไขข้อมูลของ User B ผ่าน endpoint
// ใดที่เพิ่มมาใน Slice 4A เลย (accounts, transactions annotation/splits, transfer-matches, categories)
// และ admin ห้ามอ่าน txn/category/annotation ของผู้ใช้คนอื่นผ่าน endpoint ใด ๆ
//
// ห้าม static import จาก src/* ที่แตะ src/db.ts ก่อน createTestDb() — ดู comment ใน test/helpers/db.ts
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express, { type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import { createTestDb } from './helpers/db.js';

test('cross-user authorization: Slice 4A endpoints', async (t) => {
  const db = await createTestDb();
  if (db.skip) {
    t.skip(db.reason);
    return;
  }
  t.after(db.cleanup);
  await db.migrate();

  const { api, HttpError } = await import('../src/api.js');
  const { adminRouter } = await import('../src/routes/admin.js');

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret-test-secret-test-secret', resave: false, saveUninitialized: false }));
  app.post('/test/login', (req, res) => {
    req.session.userId = Number((req.body as { userId: number }).userId);
    res.json({ ok: true });
  });
  app.use('/api', api);
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
  const loginAs = (userId: number) =>
    request('/test/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
  const json = (init: Record<string, unknown> = {}) => ({
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(init),
  });

  // ---- seed: User A, User B, Admin — คนละ email_account, bank_account, txn, category ----
  async function seedUser(googleSub: string, email: string, isAdmin: boolean): Promise<number> {
    const row = await db.pool.query<{ id: number }>(
      `insert into app_user (google_sub, email, display_name, is_admin, status)
       values ($1, $2, $2, $3, 'approved') returning id`,
      [googleSub, email, isAdmin],
    );
    return row.rows[0]!.id;
  }
  const userA = await seedUser('google-sub-a', 'a@example.com', false);
  const userB = await seedUser('google-sub-b', 'b@example.com', false);
  const admin = await seedUser('google-sub-admin', 'admin@example.com', true);

  async function seedEmailAccount(userId: number, email: string): Promise<number> {
    const row = await db.pool.query<{ id: number }>(
      `insert into email_account (user_id, email, refresh_token_enc) values ($1, $2, 'enc:refresh-token') returning id`,
      [userId, email],
    );
    return row.rows[0]!.id;
  }
  const bank = await db.pool.query<{ id: number }>(`select id from bank where lower(name) = 'scb'`);
  const bankId = bank.rows[0]!.id;

  async function seedAccount(userId: number, emailAccountId: number, accountNumber: string): Promise<number> {
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
    opts: { amount: number; direction: 'credit' | 'debit'; runningBalance: number },
  ): Promise<number> {
    const row = await db.pool.query<{ id: number }>(
      `insert into txn (statement_id, bank_account_id, txn_date, description, amount_satang, direction, running_balance_satang)
       values ($1, $2, '2026-08-15', 'ทดสอบ', $3, $4, $5) returning id`,
      [statementId, bankAccountId, opts.amount, opts.direction, opts.runningBalance],
    );
    return row.rows[0]!.id;
  }

  const emailA = await seedEmailAccount(userA, 'a@example.com');
  const emailB = await seedEmailAccount(userB, 'b@example.com');
  const accountA = await seedAccount(userA, emailA, '111-1-11111-1');
  const accountB = await seedAccount(userB, emailB, '222-2-22222-2');
  const stmtA = await seedStatement(accountA, 'msg-a-1');
  const stmtB = await seedStatement(accountB, 'msg-b-1');
  const txnA = await seedTxn(stmtA, accountA, { amount: 10000, direction: 'debit', runningBalance: 90000 });
  const txnB = await seedTxn(stmtB, accountB, { amount: 20000, direction: 'debit', runningBalance: 80000 });
  const txnB2 = await seedTxn(stmtB, accountB, { amount: 20000, direction: 'credit', runningBalance: 100000 });

  const catA = await db.pool.query<{ id: number }>(
    `insert into category (user_id, name, kind, is_system) values ($1, 'หมวดของ A', 'expense', false) returning id`,
    [userA],
  );
  const categoryA = catA.rows[0]!.id;
  const catB = await db.pool.query<{ id: number }>(
    `insert into category (user_id, name, kind, is_system) values ($1, 'หมวดของ B', 'expense', false) returning id`,
    [userB],
  );
  const categoryB = catB.rows[0]!.id;

  const transferB = await db.pool.query<{ id: number }>(
    `insert into transfer_match (user_id, debit_txn_id, credit_txn_id, status, matched_by, confidence)
     values ($1, $2, $3, 'suggested', 'system', 0.8) returning id`,
    [userB, txnB, txnB2],
  );
  const matchB = transferB.rows[0]!.id;

  await t.test('1. GET /api/accounts — A ไม่เห็นบัญชีของ B', async () => {
    await loginAs(userA);
    const res = await request('/api/accounts');
    assert.equal(res.status, 200);
    const rows = (await res.json()) as { id: number }[];
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes(accountA));
    assert.ok(!ids.includes(accountB));
  });

  await t.test('1b. GET /api/accounts?user_id=B — query string สวมรอยไม่ได้ผล', async () => {
    await loginAs(userA);
    const res = await request(`/api/accounts?user_id=${userB}`);
    const rows = (await res.json()) as { id: number }[];
    const ids = rows.map((r) => r.id);
    assert.ok(!ids.includes(accountB));
  });

  await t.test('2. PATCH /api/accounts/:id — A แก้บัญชีของ B ไม่ได้', async () => {
    await loginAs(userA);
    const res = await request(`/api/accounts/${accountB}`, json({ nickname: 'ยึดบัญชี B' }));
    assert.equal(res.status, 404);
    const row = (await db.pool.query('select nickname from bank_account where id = $1', [accountB])).rows[0]!;
    assert.equal(row.nickname, 'บัญชีทดสอบ');
  });

  // หมายเหตุ: เคสนี้ PATCH สำเร็จจริง จะเห็น stderr "[worker] reprocess account=... ล้มเหลว" เพราะ
  // backfill แบบ fire-and-forget ถอดรหัส 'enc:x' (ไม่ใช่ ciphertext จริง) ไม่ได้ — ถูก .catch() ดักไว้แล้ว
  // ไม่ทำให้ test fail แค่ noise ที่คาดไว้ ไม่ต้องตามไล่
  await t.test('2b. PATCH /api/accounts/:id — ส่ง user_id ของ B มาในตัว ก็ยังแก้บัญชีตัวเองไม่เปลี่ยนเจ้าของ', async () => {
    await loginAs(userA);
    const res = await request(`/api/accounts/${accountA}`, json({ user_id: userB, nickname: 'ชื่อใหม่ A' }));
    assert.equal(res.status, 200);
    const row = (await db.pool.query('select user_id, nickname from bank_account where id = $1', [accountA])).rows[0]!;
    assert.equal(row.user_id, userA);
    assert.equal(row.nickname, 'ชื่อใหม่ A');
  });

  await t.test('2c. PATCH /api/accounts/:id — ชี้ email_account_id ไปกล่องของ B ไม่ได้ (403)', async () => {
    // ถ้า guard นี้หาย A จะเปลี่ยนบัญชีตัวเองให้ผูกกล่องอีเมลของ B แล้ว syncEmailAccount จะดึง
    // statement ของ B เข้ามาที่บัญชี A ได้ — รั่วเนื้อหาอีเมลของ B ข้ามผู้ใช้ หนักกว่ากรณี 404 ทั่วไป
    await loginAs(userA);
    const res = await request(`/api/accounts/${accountA}`, json({ email_account_id: emailB }));
    assert.equal(res.status, 403);
    const row = (await db.pool.query('select email_account_id from bank_account where id = $1', [accountA])).rows[0]!;
    assert.equal(row.email_account_id, emailA);
  });

  await t.test('3. DELETE /api/accounts/:id — A archive บัญชีของ B ไม่ได้', async () => {
    await loginAs(userA);
    const res = await request(`/api/accounts/${accountB}`, { method: 'DELETE' });
    assert.equal(res.status, 404);
    const row = (await db.pool.query('select archived_at from bank_account where id = $1', [accountB])).rows[0]!;
    assert.equal(row.archived_at, null);
  });

  await t.test('4. PATCH /api/transactions/:id/annotation — A annotate txn ของ B ไม่ได้', async () => {
    await loginAs(userA);
    const res = await request(`/api/transactions/${txnB}/annotation`, json({ classification: 'expense' }));
    assert.equal(res.status, 404);
    const count = await db.pool.query('select count(*)::int as n from txn_annotation where txn_id = $1', [txnB]);
    assert.equal(count.rows[0]!.n, 0);
  });

  await t.test('4b. annotation — ส่ง user_id ของ B มาด้วย ก็ยังไม่มีผล (404 เหมือนเดิม)', async () => {
    await loginAs(userA);
    const res = await request(
      `/api/transactions/${txnB}/annotation`,
      json({ classification: 'expense', user_id: userB }),
    );
    assert.equal(res.status, 404);
  });

  await t.test('5. PUT /api/transactions/:id/splits — A แยกยอด txn ของ B ไม่ได้', async () => {
    await loginAs(userA);
    const res = await request(`/api/transactions/${txnB}/splits`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ category_id: categoryA, amount_satang: 20000 }]),
    });
    assert.equal(res.status, 404);
    const count = await db.pool.query('select count(*)::int as n from txn_split where txn_id = $1', [txnB]);
    assert.equal(count.rows[0]!.n, 0);
  });

  await t.test('5b. splits — แยกยอด txn ของตัวเองด้วยหมวดของ B ไม่ได้ (400) และไม่ทิ้งร่องรอย', async () => {
    // txnA เป็นของ A จริง (ผ่าน ownership gate) แต่ categoryB เป็นของ B — ต้องชนด่านตรวจหมวดใน tx()
    // insert เกิดก่อนเช็คผลรวม ต้อง rollback ทั้ง delete+insert เมื่อหมวดไม่ผ่านเช่นกัน
    await loginAs(userA);
    const res = await request(`/api/transactions/${txnA}/splits`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ category_id: categoryB, amount_satang: 10000 }]),
    });
    assert.equal(res.status, 400);
    const count = await db.pool.query('select count(*)::int as n from txn_split where txn_id = $1', [txnA]);
    assert.equal(count.rows[0]!.n, 0);
  });

  await t.test('6. POST /api/transfer-matches/:id/confirm — A ยืนยัน transfer_match ของ B ไม่ได้', async () => {
    await loginAs(userA);
    const res = await request(`/api/transfer-matches/${matchB}/confirm`, { method: 'POST' });
    assert.equal(res.status, 404);
    const row = (await db.pool.query('select status from transfer_match where id = $1', [matchB])).rows[0]!;
    assert.equal(row.status, 'suggested');
    const flags = await db.pool.query<{ is_internal_transfer: boolean }>(
      'select is_internal_transfer from txn where id = any($1)',
      [[txnB, txnB2]],
    );
    assert.ok(flags.rows.every((r) => r.is_internal_transfer === false));
  });

  await t.test('6b. confirm — transfer_match.user_id เป็น A แต่ txn จริงเป็นของ B ก็ยังพลิกไม่ได้ (guard ชั้นสอง join bank_account)', async () => {
    // ไม่มี FK บังคับว่า debit_txn_id/credit_txn_id ต้องเป็นของ transfer_match.user_id —
    // จำลองแถวเพี้ยน/ถูกยัด user_id ผิด แล้วพิสูจน์ว่า UPDATE txn ที่สอง (join bank_account.user_id) กันไว้อีกชั้น
    const crossMatch = await db.pool.query<{ id: number }>(
      `insert into transfer_match (user_id, debit_txn_id, credit_txn_id, status, matched_by, confidence)
       values ($1, $2, $3, 'suggested', 'system', 0.8) returning id`,
      [userA, txnB, txnB2],
    );
    const crossMatchId = crossMatch.rows[0]!.id;

    await loginAs(userA);
    const res = await request(`/api/transfer-matches/${crossMatchId}/confirm`, { method: 'POST' });
    assert.equal(res.status, 404);

    const row = (await db.pool.query('select status from transfer_match where id = $1', [crossMatchId])).rows[0]!;
    assert.equal(row.status, 'suggested'); // rollback: ไม่ถูกพลิกเป็น confirmed ทั้งที่ user_id ผ่าน
    const flags = await db.pool.query<{ is_internal_transfer: boolean }>(
      'select is_internal_transfer from txn where id = any($1)',
      [[txnB, txnB2]],
    );
    assert.ok(flags.rows.every((r) => r.is_internal_transfer === false));
  });

  await t.test('6c. GET /api/transfer-matches?status=suggested — A ไม่เห็นคู่ของ B แม้แต่แถวที่ user_id เพี้ยนมาชี้ txn ของ B', async () => {
    await loginAs(userA);
    const res = await request('/api/transfer-matches?status=suggested');
    assert.equal(res.status, 200);
    const rows = (await res.json()) as { id: number; debit_txn_id: number; credit_txn_id: number }[];
    assert.ok(!rows.some((r) => r.id === matchB));
    // crossMatch จาก 6b: user_id = A แต่ debit/credit txn เป็นของ B จริง — ถ้า re-join bank_account.user_id
    // หายไป แถวนี้จะหลุดมาพร้อมวันที่/ยอด/ชื่อบัญชีของ B ให้ A เห็น
    assert.ok(!rows.some((r) => r.debit_txn_id === txnB || r.credit_txn_id === txnB2));
  });

  await t.test('7. POST /api/transfer-matches/:id/reject — A reject transfer_match ของ B ไม่ได้', async () => {
    await loginAs(userA);
    const res = await request(`/api/transfer-matches/${matchB}/reject`, { method: 'POST' });
    assert.equal(res.status, 404);
    const row = (await db.pool.query('select status from transfer_match where id = $1', [matchB])).rows[0]!;
    assert.equal(row.status, 'suggested');
  });

  await t.test('8. PATCH /api/categories/:id — A แก้หมวดของ B ไม่ได้', async () => {
    await loginAs(userA);
    const res = await request(`/api/categories/${categoryB}`, json({ name: 'ยึดหมวด B' }));
    assert.equal(res.status, 404);
    const row = (await db.pool.query('select name from category where id = $1', [categoryB])).rows[0]!;
    assert.equal(row.name, 'หมวดของ B');
  });

  await t.test('8b. POST /api/categories — ส่ง user_id ของ B มาด้วย หมวดใหม่ก็ยังเป็นของผู้ login (A)', async () => {
    await loginAs(userA);
    const res = await request('/api/categories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: userB, name: 'หมวดสวมรอย', kind: 'expense' }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { user_id: number };
    assert.equal(body.user_id, userA);
  });

  // 9. Admin อ่าน/แก้ txn, category, txn_annotation ของผู้ใช้คนอื่นไม่ได้เลย — ไม่มี endpoint ไหน
  // ที่ requireAdmin ครอบกลุ่มตารางนี้ (เช็คระดับโค้ด) และของจริงตอนยิง (เช็ค runtime)
  await t.test('9a. adminRouter ไม่มี route ที่แตะ txn/category/annotation/split/transfer-match', () => {
    const routerWithStack = adminRouter as unknown as { stack: { route?: { path: string } }[] };
    const paths = routerWithStack.stack
      .map((layer) => layer.route?.path)
      .filter((p): p is string => typeof p === 'string');
    assert.deepEqual(paths.sort(), ['/admin/parser-keys', '/admin/users', '/admin/users/:id'].sort());
    for (const p of paths) {
      assert.ok(
        !/txn|categor|annotation|split|transfer-match/.test(p),
        `admin route ${p} ไม่ควรแตะตารางของผู้ใช้`,
      );
    }
  });

  await t.test('9b. admin เห็นเฉพาะหมวดของตัวเอง+ระบบ ไม่เห็นหมวดของ A หรือ B', async () => {
    await loginAs(admin);
    const res = await request('/api/categories');
    assert.equal(res.status, 200);
    const rows = (await res.json()) as { id: number }[];
    const ids = rows.map((r) => r.id);
    assert.ok(!ids.includes(categoryA));
    assert.ok(!ids.includes(categoryB));
  });

  await t.test('9c. admin แก้หมวด/annotate/split/confirm/archive ของ A ไม่ได้เหมือนผู้ใช้ทั่วไป (ไม่มีสิทธิพิเศษ)', async () => {
    await loginAs(admin);

    const catRes = await request(`/api/categories/${categoryA}`, json({ name: 'admin ยึดหมวด A' }));
    assert.equal(catRes.status, 404);

    const annoRes = await request(`/api/transactions/${txnA}/annotation`, json({ classification: 'expense' }));
    assert.equal(annoRes.status, 404);

    const splitRes = await request(`/api/transactions/${txnA}/splits`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ category_id: categoryA, amount_satang: 10000 }]),
    });
    assert.equal(splitRes.status, 404);

    const archiveRes = await request(`/api/accounts/${accountA}`, { method: 'DELETE' });
    assert.equal(archiveRes.status, 404);

    const accountsRes = await request('/api/accounts');
    const accountIds = ((await accountsRes.json()) as { id: number }[]).map((a) => a.id);
    assert.ok(!accountIds.includes(accountA));
    assert.ok(!accountIds.includes(accountB));
  });

  // 10-16: Slice 4B รายงาน + transaction list/detail — ระบุ month=2026-08 เจาะจงเสมอ (ไม่พึ่ง default
  // "เดือนปัจจุบัน" ของ parseRange) เพราะ seed ทั้งหมดข้างบนเป็นข้อมูลเดือนสิงหาคม 2026 ถ้าไม่ระบุเดือน
  // การทดสอบ "?user_id=B ไม่มีผล" จะเทียบ list ว่างกับ list ว่าง พิสูจน์อะไรไม่ได้เลย ทุกเคสด้านล่างต้อง
  // assert ค่าที่เป็นบวกของ A ก่อน (baseline) แล้วค่อยพิสูจน์ว่าไม่ใช่ค่าของ B
  await t.test('10. GET /api/reports/summary?month=2026-08&user_id=B — user_id ใน query ไม่มีผล เห็นเฉพาะยอดของ A', async () => {
    await loginAs(userA);
    const res = await request(`/api/reports/summary?month=2026-08&user_id=${userB}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { money_in_satang: number; money_out_satang: number };
    assert.equal(body.money_out_satang, 10000); // baseline บวก: เฉพาะ txnA (debit) ของ A เอง
    assert.equal(body.money_in_satang, 0);
    assert.notEqual(body.money_out_satang, 20000); // ไม่ใช่ยอด txnB ของ B
  });

  await t.test('11. GET /api/reports/category-breakdown?month=2026-08&user_id=B — เห็นเฉพาะของ A', async () => {
    await loginAs(userA);
    const res = await request(`/api/reports/category-breakdown?month=2026-08&user_id=${userB}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rows: { total_satang: number }[] };
    const total = body.rows.reduce((s, r) => s + r.total_satang, 0);
    assert.equal(total, 10000); // เฉพาะ txnA (ไม่มี split → ตกไปกลุ่ม "ไม่ได้จัดหมวด")
  });

  await t.test('12. GET /api/reports/cash-flow?from=2026-08-01&to=2026-08-31&user_id=B — เดือน ส.ค. ของ A เท่านั้น', async () => {
    await loginAs(userA);
    const res = await request(`/api/reports/cash-flow?from=2026-08-01&to=2026-08-31&user_id=${userB}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rows: { month: string; money_out_satang: number }[] };
    const aug = body.rows.find((r) => r.month === '2026-08');
    assert.equal(aug?.money_out_satang, 10000);
  });

  await t.test('13. GET /api/reports/account-balances?month=2026-08&user_id=B — เห็นเฉพาะบัญชี A', async () => {
    await loginAs(userA);
    const res = await request(`/api/reports/account-balances?month=2026-08&user_id=${userB}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rows: { bank_account_id: number }[] };
    assert.ok(body.rows.some((r) => r.bank_account_id === accountA));
    assert.ok(!body.rows.some((r) => r.bank_account_id === accountB));
  });

  await t.test('14. GET /api/reports/data-coverage?user_id=B — เห็นเฉพาะบัญชี A', async () => {
    await loginAs(userA);
    const res = await request(`/api/reports/data-coverage?user_id=${userB}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rows: { bank_account_id: number }[] };
    assert.ok(body.rows.some((r) => r.bank_account_id === accountA));
    assert.ok(!body.rows.some((r) => r.bank_account_id === accountB));
  });

  await t.test('15. GET /api/transactions?month=2026-08&user_id=B — เห็นเฉพาะธุรกรรมของ A', async () => {
    await loginAs(userA);
    const res = await request(`/api/transactions?month=2026-08&user_id=${userB}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rows: { id: number }[]; total_count: number };
    const ids = body.rows.map((r) => r.id);
    assert.ok(ids.includes(txnA));
    assert.ok(!ids.includes(txnB));
    assert.ok(!ids.includes(txnB2));
  });

  await t.test('16. GET /api/transactions/:id — A เปิดธุรกรรมของ B ไม่ได้ (404)', async () => {
    await loginAs(userA);
    const res = await request(`/api/transactions/${txnB}`);
    assert.equal(res.status, 404);
  });

  await t.test('16b. GET /api/transactions/:id?user_id=B — เปิดธุรกรรมของตัวเอง user_id ใน query ไม่เปลี่ยนอะไร', async () => {
    await loginAs(userA);
    const res = await request(`/api/transactions/${txnA}?user_id=${userB}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: number };
    assert.equal(body.id, txnA);
  });

  // ---- Slice 5: monthly planning / recurring rules — ADR-0002 ข้อ 7 บังคับให้ทุก endpoint ใหม่มี test นี้ ----
  const post = (init: Record<string, unknown> = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(init),
  });
  const now = new Date();
  const PLAN_MONTH = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const PLAN_MONTH_START = `${PLAN_MONTH}-01`;

  const planB = (
    await db.pool.query<{ id: number }>(
      `insert into monthly_plan (user_id, month_start) values ($1, $2) returning id`,
      [userB, PLAN_MONTH_START],
    )
  ).rows[0]!.id;
  const itemB = (
    await db.pool.query<{ id: number }>(
      `insert into monthly_plan_item (monthly_plan_id, kind, name, planned_amount_satang, category_id)
       values ($1, 'expense', 'ค่าไฟของ B', 50000, $2) returning id`,
      [planB, categoryB],
    )
  ).rows[0]!.id;
  const paymentB = (
    await db.pool.query<{ id: number }>(
      `insert into monthly_item_payment (monthly_plan_item_id, amount_satang, paid_date, bank_account_id)
       values ($1, 50000, $2, $3) returning id`,
      [itemB, `${PLAN_MONTH}-05`, accountB],
    )
  ).rows[0]!.id;
  const ruleB = (
    await db.pool.query<{ id: number }>(
      `insert into recurring_rule (user_id, name, kind, amount_satang, frequency_unit, start_date)
       values ($1, 'ค่าเช่าของ B', 'expense', 100000, 'month', $2) returning id`,
      [userB, PLAN_MONTH_START],
    )
  ).rows[0]!.id;

  await t.test('17. GET /api/monthly-plans/:month — A ไม่เห็นแผนหรือรายการของ B แม้เดือนเดียวกัน', async () => {
    await loginAs(userA);
    const res = await request(`/api/monthly-plans/${PLAN_MONTH}?user_id=${userB}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: { id: number }[]; totals: { planned_expense_satang: number } };
    assert.ok(!body.items.some((i) => i.id === itemB));
    assert.equal(body.totals.planned_expense_satang, 0);
  });

  await t.test('18. POST /api/monthly-plans/:month/items — รายการใหม่เข้าแผนของผู้ login ไม่ใช่ของ B', async () => {
    await loginAs(userA);
    const res = await request(
      `/api/monthly-plans/${PLAN_MONTH}/items`,
      post({ kind: 'expense', name: 'ของ A', planned_amount_satang: 1000, monthly_plan_id: planB, user_id: userB }),
    );
    assert.equal(res.status, 201);
    const created = (await res.json()) as { monthly_plan_id: number };
    assert.notEqual(created.monthly_plan_id, planB);
    const bItems = await db.pool.query<{ n: number }>(
      'select count(*)::int as n from monthly_plan_item where monthly_plan_id = $1',
      [planB],
    );
    assert.equal(bItems.rows[0]!.n, 1);
  });

  await t.test('19. PATCH/skip/payments บน monthly_plan_item ของ B — A แตะไม่ได้ (404)', async () => {
    await loginAs(userA);
    assert.equal((await request(`/api/monthly-plan-items/${itemB}`, json({ name: 'แก้ของ B' }))).status, 404);
    assert.equal((await request(`/api/monthly-plan-items/${itemB}/skip`, post())).status, 404);
    assert.equal(
      (
        await request(
          `/api/monthly-plan-items/${itemB}/payments`,
          post({ amount_satang: 100, paid_date: `${PLAN_MONTH}-06`, bank_account_id: accountA }),
        )
      ).status,
      404,
    );
    const untouched = await db.pool.query<{ name: string; explicit_status: string }>(
      'select name, explicit_status from monthly_plan_item where id = $1',
      [itemB],
    );
    assert.equal(untouched.rows[0]!.name, 'ค่าไฟของ B');
    assert.equal(untouched.rows[0]!.explicit_status, 'active');
  });

  await t.test('20. mark paid ด้วย bank_account ของ B บนรายการของตัวเองไม่ได้ (400 — กัน IDOR)', async () => {
    await loginAs(userA);
    const ownItem = (await request(
      `/api/monthly-plans/${PLAN_MONTH}/items`,
      post({ kind: 'expense', name: 'ค่าไฟของ A', planned_amount_satang: 50000 }),
    ).then((r) => r.json())) as { id: number };
    const res = await request(
      `/api/monthly-plan-items/${ownItem.id}/payments`,
      post({ amount_satang: 50000, paid_date: `${PLAN_MONTH}-05`, bank_account_id: accountB }),
    );
    assert.equal(res.status, 400);
    const leaked = await db.pool.query<{ n: number }>(
      'select count(*)::int as n from monthly_item_payment where bank_account_id = $1',
      [accountB],
    );
    assert.equal(leaked.rows[0]!.n, 1); // มีแต่ paymentB ที่ seed ไว้
  });

  await t.test('21. PATCH /api/monthly-item-payments/:id — ของ B แตะไม่ได้ และผูก txn ของ B ไม่ได้', async () => {
    await loginAs(userA);
    assert.equal((await request(`/api/monthly-item-payments/${paymentB}`, json({ status: 'cancelled' }))).status, 404);
    assert.equal((await request(`/api/monthly-item-payments/${paymentB}`, json({ txn_id: txnB }))).status, 404);

    const ownItem = (await request(
      `/api/monthly-plans/${PLAN_MONTH}/items`,
      post({ kind: 'expense', name: 'ค่าน้ำของ A', planned_amount_satang: 20000 }),
    ).then((r) => r.json())) as { id: number };
    const ownPayment = (await request(
      `/api/monthly-plan-items/${ownItem.id}/payments`,
      post({ amount_satang: 20000, paid_date: `${PLAN_MONTH}-07`, bank_account_id: accountA }),
    ).then((r) => r.json())) as { id: number };
    // txn ของ B ยอดเท่ากันพอดี (20000) — ต้องถูกปฏิเสธเพราะเป็นของคนอื่นและอยู่คนละบัญชี
    assert.equal((await request(`/api/monthly-item-payments/${ownPayment.id}`, json({ txn_id: txnB }))).status, 400);
    const stillUnmatched = await db.pool.query<{ status: string; txn_id: number | null }>(
      'select status, txn_id from monthly_item_payment where id = $1',
      [ownPayment.id],
    );
    assert.equal(stillUnmatched.rows[0]!.txn_id, null);
  });

  await t.test('22. reconcilePayments ของ A ไม่แตะ payment ของ B ที่ยอด/วันตรงกับ txn ของ B', async () => {
    const { reconcilePayments } = await import('../src/services/payment-reconciliation.js');
    const { pool } = await import('../src/db.js');
    // txnB เป็น debit 20000 วันที่ 2026-08-15 — ปรับ payment ของ B ให้ตรงเป๊ะ เพื่อให้จับคู่ได้ถ้า scope รั่ว
    await db.pool.query(
      `update monthly_item_payment set amount_satang = 20000, paid_date = '2026-08-15' where id = $1`,
      [paymentB],
    );
    await reconcilePayments(pool, userA);
    const b = await db.pool.query<{ status: string; txn_id: number | null }>(
      'select status, txn_id from monthly_item_payment where id = $1',
      [paymentB],
    );
    assert.equal(b.rows[0]!.status, 'declared');
    assert.equal(b.rows[0]!.txn_id, null);
  });

  await t.test('23. close/reopen มีผลเฉพาะแผนของผู้ login', async () => {
    await loginAs(userA);
    assert.equal((await request(`/api/monthly-plans/${PLAN_MONTH}/close`, post())).status, 200);
    const bStatus = await db.pool.query<{ status: string }>('select status from monthly_plan where id = $1', [planB]);
    assert.equal(bStatus.rows[0]!.status, 'open');
    assert.equal((await request(`/api/monthly-plans/${PLAN_MONTH}/reopen`, post())).status, 200);
  });

  await t.test('24. recurring rules — A ไม่เห็น/แก้/archive ของ B และอ้างบัญชีหรือหมวดของ B ไม่ได้', async () => {
    await loginAs(userA);
    const list = (await request('/api/recurring-rules').then((r) => r.json())) as { id: number }[];
    assert.ok(!list.some((r) => r.id === ruleB));
    assert.equal((await request(`/api/recurring-rules/${ruleB}`, json({ name: 'แก้ของ B' }))).status, 404);
    assert.equal((await request(`/api/recurring-rules/${ruleB}/archive`, post())).status, 404);

    const base = { kind: 'expense', amount_satang: 100, frequency_unit: 'month', start_date: PLAN_MONTH_START };
    assert.equal(
      (await request('/api/recurring-rules', post({ ...base, name: 'อ้างบัญชีคนอื่น', default_account_id: accountB })))
        .status,
      400,
    );
    assert.equal(
      (await request('/api/recurring-rules', post({ ...base, name: 'อ้างหมวดคนอื่น', category_id: categoryB }))).status,
      400,
    );

    const untouched = await db.pool.query<{ name: string; is_active: boolean }>(
      'select name, is_active from recurring_rule where id = $1',
      [ruleB],
    );
    assert.equal(untouched.rows[0]!.name, 'ค่าเช่าของ B');
    assert.equal(untouched.rows[0]!.is_active, true);
  });

  // Slice 7 — ตาม ADR-0002 ข้อ 7: ทุก endpoint ใหม่ต้องมี integration test กัน cross-user access
  const entityA = (
    await db.pool.query<{ id: number }>(
      `insert into tax_entity (user_id, entity_type, display_name) values ($1, 'individual', 'A ธรรมดา') returning id`,
      [userA],
    )
  ).rows[0]!.id;
  const entityB = (
    await db.pool.query<{ id: number }>(
      `insert into tax_entity (user_id, entity_type, display_name) values ($1, 'individual', 'B ธรรมดา') returning id`,
      [userB],
    )
  ).rows[0]!.id;
  const taxDocB = (
    await db.pool.query<{ id: number }>(
      `insert into tax_document (
         user_id, tax_entity_id, document_type, tax_year, issuer_name, total_satang,
         storage_path, file_sha256, file_mime, file_size_bytes, original_filename
       ) values ($1, $2, 'receipt', 2026, 'ร้านของ B', 5000, '/tmp/b-doc.enc', 'sha-b-doc', 'application/pdf', 10, 'b.pdf')
       returning id`,
      [userB, entityB],
    )
  ).rows[0]!.id;

  await t.test('25. GET/PATCH /api/tax-entities/:id — A แตะ tax entity ของ B ไม่ได้ (404)', async () => {
    await loginAs(userA);
    const list = (await request('/api/tax-entities').then((r) => r.json())) as { id: number }[];
    assert.ok(!list.some((e) => e.id === entityB));
    const patchRes = await request(`/api/tax-entities/${entityB}`, json({ display_name: 'ยึด' }));
    assert.equal(patchRes.status, 404);
    const row = (await db.pool.query('select display_name from tax_entity where id = $1', [entityB])).rows[0]!;
    assert.equal(row.display_name, 'B ธรรมดา');
  });

  await t.test('26. GET /api/tax-documents/:id และ /file — A เปิดเอกสารของ B ไม่ได้ (404)', async () => {
    await loginAs(userA);
    assert.equal((await request(`/api/tax-documents/${taxDocB}`)).status, 404);
    assert.equal((await request(`/api/tax-documents/${taxDocB}/file`)).status, 404);
  });

  await t.test('27. admin ดาวน์โหลด/เปิดเอกสารของ B ไม่ได้เหมือนกัน (404 ไม่ใช่สิทธิพิเศษ)', async () => {
    await loginAs(admin);
    assert.equal((await request(`/api/tax-documents/${taxDocB}/file`)).status, 404);
    assert.equal((await request(`/api/tax-documents/${taxDocB}`)).status, 404);
  });

  await t.test('28. POST /api/tax-documents — ใช้ tax_entity_id ของ B ไม่ได้ (403)', async () => {
    await loginAs(userA);
    const res = await request(
      '/api/tax-documents',
      post({
        tax_entity_id: entityB,
        document_type: 'receipt',
        tax_year: 2026,
        issuer_name: 'ทดสอบ',
        total_satang: 1000,
        filename: 'x.pdf',
        file_base64: Buffer.from('%PDF-1.4\ntest').toString('base64'),
      }),
    );
    assert.equal(res.status, 403);
  });

  await t.test('29. PUT /api/tax-documents/:id/links — ชี้ธุรกรรมของ B ไม่ได้ (400)', async () => {
    await loginAs(userA);
    const own = (
      await db.pool.query<{ id: number }>(
        `insert into tax_document (
           user_id, tax_entity_id, document_type, tax_year, issuer_name, total_satang,
           storage_path, file_sha256, file_mime, file_size_bytes, original_filename
         ) values ($1, $2, 'receipt', 2026, 'ของฉัน', 1000, '/tmp/a-doc.enc', 'sha-a-doc', 'application/pdf', 10, 'a.pdf')
         returning id`,
        [userA, entityA],
      )
    ).rows[0]!.id;
    const res = await request(`/api/tax-documents/${own}/links`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ txn_id: txnB, linked_amount_satang: 1000 }]),
    });
    assert.equal(res.status, 400);
    const count = await db.pool.query(
      'select count(*)::int as n from tax_document_txn_link where tax_document_id = $1',
      [own],
    );
    assert.equal(count.rows[0]!.n, 0);
  });

  await t.test('30. PATCH /api/accounts/:id — default_tax_entity_id ของ B ไม่ได้ (403)', async () => {
    await loginAs(userA);
    const res = await request(`/api/accounts/${accountA}`, json({ default_tax_entity_id: entityB }));
    assert.equal(res.status, 403);
    const row = (
      await db.pool.query('select default_tax_entity_id from bank_account where id = $1', [accountA])
    ).rows[0]!;
    assert.equal(row.default_tax_entity_id, null);
  });

  await t.test('31. GET /api/tax-documents — A ไม่เห็นเอกสารของ B ในรายการ', async () => {
    await loginAs(userA);
    const res = await request('/api/tax-documents');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rows: { id: number }[] };
    assert.ok(!body.rows.some((r) => r.id === taxDocB));
  });

  await t.test('32. PATCH /api/tax-documents/:id — A แก้เอกสารของ B ไม่ได้ (404)', async () => {
    await loginAs(userA);
    const res = await request(`/api/tax-documents/${taxDocB}`, json({ issuer_name: 'ยึดเอกสาร B' }));
    assert.equal(res.status, 404);
    const row = (await db.pool.query('select issuer_name from tax_document where id = $1', [taxDocB])).rows[0]!;
    assert.equal(row.issuer_name, 'ร้านของ B');
  });

  await t.test('33. DELETE /api/tax-documents/:id — A archive เอกสารของ B ไม่ได้ (404)', async () => {
    await loginAs(userA);
    const res = await request(`/api/tax-documents/${taxDocB}`, { method: 'DELETE' });
    assert.equal(res.status, 404);
    const row = (await db.pool.query('select archived_at from tax_document where id = $1', [taxDocB])).rows[0]!;
    assert.equal(row.archived_at, null);
  });

  await t.test('34. PUT /api/tax-documents/:id/links — A เชื่อม transaction เข้าเอกสารของ B ไม่ได้ (404)', async () => {
    await loginAs(userA);
    const res = await request(`/api/tax-documents/${taxDocB}/links`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ txn_id: txnA, linked_amount_satang: 5000 }]),
    });
    assert.equal(res.status, 404);
    const count = await db.pool.query(
      'select count(*)::int as n from tax_document_txn_link where tax_document_id = $1',
      [taxDocB],
    );
    assert.equal(count.rows[0]!.n, 0);
  });

  await t.test('35. GET /api/tax-documents/gmail-attachments — A ค้นด้วยกล่องอีเมลของ B ไม่ได้ (403)', async () => {
    await loginAs(userA);
    const res = await request(`/api/tax-documents/gmail-attachments?email_account_id=${emailB}`);
    assert.equal(res.status, 403);
  });

  await t.test('35b. PATCH /api/transactions/:id/annotation — override ด้วย tax_entity_id ของ B ไม่ได้ (403)', async () => {
    await loginAs(userA);
    const res = await request(`/api/transactions/${txnA}/annotation`, json({ classification: 'expense', tax_entity_id: entityB }));
    assert.equal(res.status, 403);
    const row = (await db.pool.query('select tax_entity_id from txn_annotation where txn_id = $1', [txnA])).rows[0];
    assert.equal(row?.tax_entity_id ?? null, null);
  });

  await t.test('36. POST /api/tax-documents/from-gmail — A นำเข้าด้วยกล่องอีเมลของ B ไม่ได้ (403)', async () => {
    await loginAs(userA);
    const res = await request(
      '/api/tax-documents/from-gmail',
      post({
        email_account_id: emailB,
        gmail_message_id: 'msg-x',
        gmail_attachment_id: 'att-x',
        filename: 'x.pdf',
        tax_entity_id: entityA,
        document_type: 'receipt',
        tax_year: 2026,
        issuer_name: 'ทดสอบ',
        total_satang: 1000,
      }),
    );
    assert.equal(res.status, 403);
  });
});
