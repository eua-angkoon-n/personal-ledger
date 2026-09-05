import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createTestDb } from './helpers/db.js';

process.env.ENCRYPTION_KEY = '0'.repeat(64);

// Slice 8: ประมาณการภาษี, ค่าลดหย่อน, missing-document report, export, audit log — ครอบ DoD ทั้งสี่ข้อของ §14
test('tax calculation: summary, snapshot, deduction claims, export, audit', async (t) => {
  const db = await createTestDb();
  if (db.skip) {
    t.skip(db.reason);
    return;
  }
  t.after(db.cleanup);
  await db.migrate();

  const { HttpError } = await import('../src/http.js');
  const { taxEntitiesRouter } = await import('../src/routes/tax-entities.js');
  const { taxCalculationsRouter } = await import('../src/routes/tax-calculations.js');
  const { transactionsRouter } = await import('../src/routes/transactions.js');
  const { auditLogRouter } = await import('../src/routes/audit-log.js');
  const { incomeRecordsRouter } = await import('../src/routes/income-records.js');

  function appFor(userId: number) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { session: { userId?: number } }).session = { userId };
      next();
    });
    app.use('/api', taxEntitiesRouter);
    app.use('/api', taxCalculationsRouter);
    app.use('/api', transactionsRouter);
    app.use('/api', auditLogRouter);
    app.use('/api', incomeRecordsRouter);
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
      const code = (err as { code?: string }).code;
      if (code === '23505') return void res.status(409).json({ error: 'ซ้ำ' });
      if (code === '23503') return void res.status(409).json({ error: 'ยังมีข้อมูลอื่นอ้างถึงอยู่' });
      if (code === '23514') return void res.status(400).json({ error: 'ข้อมูลไม่ผ่านเงื่อนไข' });
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
       values ('google-sub-tax8-a', 'tax8-a@example.com', 'Tax8 A', false, 'approved') returning id`,
    )
  ).rows[0]!.id;

  const emailAccountId = (
    await db.pool.query<{ id: number }>(
      `insert into email_account (user_id, email, refresh_token_enc) values ($1, 'tax8-a@example.com', 'enc:x') returning id`,
      [userA],
    )
  ).rows[0]!.id;

  const bankId = (await db.pool.query<{ id: number }>(`select id from bank where lower(name) = 'scb'`)).rows[0]!.id;

  const bankAccountId = (
    await db.pool.query<{ id: number }>(
      `insert into bank_account (user_id, bank_id, email_account_id, nickname, account_number, pdf_password_enc)
       values ($1, $2, $3, 'บัญชีธุรกิจ', 'xxx-x-x9001-x', 'enc:pw') returning id`,
      [userA, bankId, emailAccountId],
    )
  ).rows[0]!.id;

  const statementId = (
    await db.pool.query<{ id: number }>(
      `insert into statement (bank_account_id, gmail_message_id, gmail_attachment_id, period_start, period_end, status)
       values ($1, 'gmail-msg-tax8', 'gmail-att-tax8', '2026-01-01', '2026-12-31', 'parsed') returning id`,
      [bankAccountId],
    )
  ).rows[0]!.id;

  const entityA = (
    await db.pool.query<{ id: number }>(
      `insert into tax_entity (user_id, entity_type, display_name) values ($1, 'individual', 'บุคคลธรรมดา 8') returning id`,
      [userA],
    )
  ).rows[0]!.id;
  const entityCompany = (
    await db.pool.query<{ id: number }>(
      `insert into tax_entity (user_id, entity_type, display_name) values ($1, 'company', 'บริษัท 8') returning id`,
      [userA],
    )
  ).rows[0]!.id;

  await db.pool.query('update bank_account set default_tax_entity_id = $1 where id = $2', [entityA, bankAccountId]);

  // เงินได้งานประจำ ผ่าน income_record (ต้องมี monthly_plan + monthly_plan_item ก่อนตาม FK ของ 008)
  const planId = (
    await db.pool.query<{ id: number }>(
      `insert into monthly_plan (user_id, month_start) values ($1, '2026-03-01') returning id`,
      [userA],
    )
  ).rows[0]!.id;
  const incomeItemId = (
    await db.pool.query<{ id: number }>(
      `insert into monthly_plan_item (monthly_plan_id, kind, name, planned_amount_satang) values ($1, 'income', 'เงินเดือน', 50000000) returning id`,
      [planId],
    )
  ).rows[0]!.id;
  const incomeRecordId = (
    await db.pool.query<{ id: number }>(
      `insert into income_record (user_id, monthly_plan_id, monthly_plan_item_id, name, gross_amount_satang, expected_net_satang, bank_account_id, income_date)
       values ($1, $2, $3, 'เงินเดือน', 50000000, 49000000, $4, '2026-03-25') returning id`,
      [userA, planId, incomeItemId, bankAccountId],
    )
  ).rows[0]!.id;
  await db.pool.query(
    `insert into income_deduction (income_record_id, monthly_plan_item_id, deduction_type, name, amount_satang)
     values ($1, $2, 'withholding_tax', 'หัก ณ ที่จ่าย', 1000000)`,
    [incomeRecordId, incomeItemId],
  );

  // รายได้ที่ resolve entity ไม่ได้ (bank_account_id null) — ต้องโผล่ใน unresolved_income_satang
  const unresolvedItemId = (
    await db.pool.query<{ id: number }>(
      `insert into monthly_plan_item (monthly_plan_id, kind, name, planned_amount_satang) values ($1, 'income', 'รายได้พิเศษ', 2000000) returning id`,
      [planId],
    )
  ).rows[0]!.id;
  await db.pool.query(
    `insert into income_record (user_id, monthly_plan_id, monthly_plan_item_id, name, gross_amount_satang, expected_net_satang, income_date)
     values ($1, $2, $3, 'รายได้พิเศษ', 2000000, 2000000, '2026-05-01')`,
    [userA, planId, unresolvedItemId],
  );

  async function insertTxn(amountSatang: number, direction: 'credit' | 'debit', txnDate: string) {
    return (
      await db.pool.query<{ id: number }>(
        `insert into txn (statement_id, bank_account_id, txn_date, description, amount_satang, direction, running_balance_satang)
         values ($1, $2, $3, 'รายการทดสอบ', $4, $5, 100000000) returning id`,
        [statementId, bankAccountId, txnDate, amountSatang, direction],
      )
    ).rows[0]!.id;
  }
  async function annotate(txnId: number, taxTreatment: string | null) {
    await db.pool.query(
      `insert into txn_annotation (txn_id, classification, review_status, tax_treatment) values ($1, 'expense', 'reviewed', $2)`,
      [txnId, taxTreatment],
    );
  }

  const businessIncomeTxn = await insertTxn(20000000, 'credit', '2026-04-10');
  await annotate(businessIncomeTxn, 'business_income');
  const businessExpenseTxn = await insertTxn(5000000, 'debit', '2026-04-11');
  await annotate(businessExpenseTxn, 'business_expense');
  const untreatedTxn = await insertTxn(3000000, 'debit', '2026-04-12');
  await annotate(untreatedTxn, null);
  // ธุรกรรมปีอื่น ต้องไม่ถูกนับ
  const otherYearTxn = await insertTxn(99999999, 'credit', '2025-01-01');
  await annotate(otherYearTxn, 'business_income');

  const withholdingDocId = (
    await db.pool.query<{ id: number }>(
      `insert into tax_document (user_id, tax_entity_id, document_type, tax_year, issuer_name, total_satang, withholding_satang, storage_path, file_sha256, file_mime, file_size_bytes, original_filename, status)
       values ($1, $2, 'withholding_certificate', 2026, 'นายจ้าง', 50000000, 1000000, '/tmp/wh.enc', 'sha-wh-tax8', 'application/pdf', 100, 'wh.pdf', 'verified') returning id`,
      [userA, entityA],
    )
  ).rows[0]!.id;
  // ผูก business income txn กับเอกสาร ให้เหลือ unlinked แค่ business expense (ทดสอบ missing_document แยกสองเส้น)
  await db.pool.query(
    `insert into tax_document_txn_link (tax_document_id, txn_id, linked_amount_satang) values ($1, $2, $3)`,
    [withholdingDocId, businessIncomeTxn, 20000000],
  );
  await db.pool.query(
    `insert into tax_document (user_id, tax_entity_id, document_type, tax_year, issuer_name, total_satang, storage_path, file_sha256, file_mime, file_size_bytes, original_filename, status)
     values ($1, $2, 'receipt', 2026, 'ร้านค้า', 5000000, '/tmp/r.enc', 'sha-r-tax8', 'application/pdf', 100, 'r.pdf', 'draft')`,
    [userA, entityA],
  );

  const app = await listen(appFor(userA));
  t.after(app.close);

  let summary: any;
  await t.test('GET summary รวมยอดถูกต้อง และไม่มี side effect', async () => {
    const before = (await db.pool.query('select count(*)::int as n from tax_calculation_snapshot')).rows[0]!.n;

    const res = await app.request(`/api/tax/2026/summary?tax_entity_id=${entityA}`);
    assert.equal(res.status, 200);
    summary = await res.json();

    assert.equal(summary.inputs.employmentIncomeSatang, 50000000);
    assert.equal(summary.inputs.withholdingSatang, 1000000);
    assert.equal(summary.inputs.otherIncomeSatang, 20000000);
    assert.equal(summary.inputs.deductibleExpenseSatang, 5000000);
    assert.equal(summary.inputs.unresolvedIncomeSatang, 2000000);
    assert.equal(summary.missing_document.untreated_txn_count, 1);
    assert.equal(summary.missing_document.unlinked_business_txn_count, 1);
    assert.equal(summary.missing_document.draft_document_count, 1);
    assert.ok(summary.estimate != null);
    assert.equal(summary.estimate.ruleVersion, summary.rule_version);

    const after = (await db.pool.query('select count(*)::int as n from tax_calculation_snapshot')).rows[0]!.n;
    assert.equal(after, before, 'GET summary ต้องไม่เขียน snapshot');
  });

  await t.test('DoD: drill-down ของการ์ดต้องรวมยอดตรงกับตัวเลขบนการ์ดเป๊ะ', async () => {
    for (const [card, expectedSatang] of [
      ['other_income', summary.inputs.otherIncomeSatang],
      ['deductible_expense', summary.inputs.deductibleExpenseSatang],
    ] as const) {
      const params = summary.drilldown_params[card];
      const qs = new URLSearchParams(params as Record<string, string>).toString();
      const res = await app.request(`/api/transactions?${qs}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { rows: { amount_satang: number }[] };
      const total = body.rows.reduce((sum, r) => sum + r.amount_satang, 0);
      assert.equal(total, expectedSatang, `การ์ด ${card} ต้อง drill-down ได้ยอดตรงกัน`);
    }
    // untreated_txn เป็น "จำนวนรายการ" ไม่ใช่ยอดเงิน — ต้องนับได้เท่ากับ missing_document.untreated_txn_count เป๊ะ
    // เดิม (ก่อนแก้) tax_treatment='none' ไม่มีความหมายใน filter เลย ทำให้ query คืน superset ของทุกธุรกรรม
    {
      const qs = new URLSearchParams(summary.drilldown_params.untreated_txn as Record<string, string>).toString();
      const res = await app.request(`/api/transactions?${qs}`);
      const body = (await res.json()) as { total_count: number };
      assert.equal(body.total_count, summary.missing_document.untreated_txn_count, 'การ์ด untreated_txn ต้อง drill-down ได้จำนวนแถวตรงกัน');
    }
  });

  let claimId: number;
  await t.test('สร้างค่าลดหย่อน — deduction_type ที่ไม่รู้จักต้อง 400, claimed เกิน eligible ต้อง 400', async () => {
    const bad = await app.request('/api/tax/deduction-claims', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tax_entity_id: entityA, tax_year: 2026, deduction_type: 'ไม่มีจริง', eligible_amount_satang: 10000, claimed_amount_satang: 10000 }),
    });
    assert.equal(bad.status, 400);

    const overClaim = await app.request('/api/tax/deduction-claims', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tax_entity_id: entityA, tax_year: 2026, deduction_type: 'donation', eligible_amount_satang: 10000, claimed_amount_satang: 20000 }),
    });
    assert.equal(overClaim.status, 400);

    const res = await app.request('/api/tax/deduction-claims', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tax_entity_id: entityA, tax_year: 2026, deduction_type: 'donation', eligible_amount_satang: 100000, claimed_amount_satang: 100000 }),
    });
    assert.equal(res.status, 201);
    claimId = (await res.json()).id;
  });

  await t.test('summary รวมค่าลดหย่อนที่ยื่นแล้ว', async () => {
    const res = await app.request(`/api/tax/2026/summary?tax_entity_id=${entityA}`);
    const body = await res.json();
    assert.equal(body.inputs.deductionClaimSatang, 100000);
  });

  await t.test('แก้ค่าลดหย่อนให้ claimed เกิน eligible ต้อง 400', async () => {
    const res = await app.request(`/api/tax/deduction-claims/${claimId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claimed_amount_satang: 999999999 }),
    });
    assert.equal(res.status, 400);
  });

  await t.test('ลบค่าลดหย่อน — ลบจริง (ไม่ archive) + audit log มี before_data', async () => {
    const res = await app.request(`/api/tax/deduction-claims/${claimId}`, { method: 'DELETE' });
    assert.equal(res.status, 204);
    const row = await db.pool.query('select 1 from tax_deduction_claim where id = $1', [claimId]);
    assert.equal(row.rowCount, 0);

    const auditRow = (
      await db.pool.query<{ before_data: unknown }>(
        `select before_data from audit_log where action = 'tax_deduction_claim.delete' and entity_id = $1`,
        [claimId],
      )
    ).rows[0]!;
    assert.ok(auditRow.before_data != null);
  });

  await t.test('POST calculate เขียน snapshot 1 แถวต่อ entity พร้อม rule version', async () => {
    const res = await app.request('/api/tax/2026/calculate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tax_entity_id: entityA }),
    });
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.equal(created.tax_entity_id, entityA);
    assert.ok(created.rule_version.startsWith('th-pit-'));

    const list = await app.request(`/api/tax/2026/snapshots?tax_entity_id=${entityA}`);
    const listBody = (await list.json()) as { rows: unknown[] };
    assert.equal(listBody.rows.length, 1);
  });

  await t.test('company entity → ไม่มีประมาณการ แต่สรุปยอดได้', async () => {
    const res = await app.request(`/api/tax/2026/summary?tax_entity_id=${entityCompany}`);
    const body = await res.json();
    assert.equal(body.estimate, null);
    assert.ok(body.estimate_unavailable_reason);
    assert.ok(body.rule_version.startsWith('not-applicable:'));
  });

  await t.test('export CSV — ใช้คำว่า "ประมาณการภาษี" และ audit ก่อนส่ง', async () => {
    const res = await app.request(`/api/tax/2026/export.csv?tax_entity_id=${entityA}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
    const text = await res.text();
    assert.match(text, /ประมาณการภาษี/);

    const auditRow = await db.pool.query(
      `select 1 from audit_log where user_id = $1 and action = 'tax.export' and entity_id = $2`,
      [userA, entityA],
    );
    assert.equal(auditRow.rowCount, 1);
  });

  await t.test('GET /api/audit-log เห็นเหตุการณ์ที่บันทึกไว้ครบ', async () => {
    const res = await app.request('/api/audit-log?entity_type=tax_deduction_claim');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rows: { action: string }[]; total_count: number };
    assert.ok(body.rows.some((r) => r.action === 'tax_deduction_claim.create'));
    assert.ok(body.rows.some((r) => r.action === 'tax_deduction_claim.delete'));
  });

  await t.test('income_record ที่มี withholding_tax deduction สองแถว ต้องไม่ถูกนับ gross ซ้ำ (join fan-out)', async () => {
    const plan2027 = (
      await db.pool.query<{ id: number }>(`insert into monthly_plan (user_id, month_start) values ($1, '2027-02-01') returning id`, [userA])
    ).rows[0]!.id;
    const item2027 = (
      await db.pool.query<{ id: number }>(
        `insert into monthly_plan_item (monthly_plan_id, kind, name, planned_amount_satang) values ($1, 'income', 'เงินเดือน 2027', 30000000) returning id`,
        [plan2027],
      )
    ).rows[0]!.id;
    const income2027 = (
      await db.pool.query<{ id: number }>(
        `insert into income_record (user_id, monthly_plan_id, monthly_plan_item_id, name, gross_amount_satang, expected_net_satang, bank_account_id, income_date)
         values ($1, $2, $3, 'เงินเดือน 2027', 30000000, 28000000, $4, '2027-03-01') returning id`,
        [userA, plan2027, item2027, bankAccountId],
      )
    ).rows[0]!.id;
    // สองแถว withholding_tax บน income_record เดียวกัน — schema ไม่มี unique คุม (พบจริงได้)
    await db.pool.query(
      `insert into income_deduction (income_record_id, monthly_plan_item_id, deduction_type, name, amount_satang) values ($1, $2, 'withholding_tax', 'หัก 1', 500000)`,
      [income2027, item2027],
    );
    const item2027b = (
      await db.pool.query<{ id: number }>(
        `insert into monthly_plan_item (monthly_plan_id, kind, name, planned_amount_satang) values ($1, 'payroll_deduction', 'หัก ณ ที่จ่าย 2', 500000) returning id`,
        [plan2027],
      )
    ).rows[0]!.id;
    await db.pool.query(
      `insert into income_deduction (income_record_id, monthly_plan_item_id, deduction_type, name, amount_satang) values ($1, $2, 'withholding_tax', 'หัก 2', 500000)`,
      [income2027, item2027b],
    );

    const res = await app.request(`/api/tax/2027/summary?tax_entity_id=${entityA}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.inputs.employmentIncomeSatang, 30000000, 'gross ต้องนับครั้งเดียว ไม่ fan-out ตามจำนวนแถว withholding');
    assert.equal(body.inputs.withholdingSatang, 1000000, 'withholding ต้องรวมทั้งสองแถว');
  });

  // กดปุ่ม "บันทึกเป็นรายได้เต็ม" ซ้ำบนธุรกรรมเดิม ต้องไม่ได้รายได้สองก้อนจากเงินเข้าก้อนเดียว
  await t.test('บันทึกธุรกรรมเดิมเป็นรายได้ซ้ำไม่ได้ — เงินเข้าก้อนเดียวต้องนับครั้งเดียว', async () => {
    const salaryTxn = await insertTxn(3000000, 'credit', '2026-11-28');
    const body = {
      month: '2026-11',
      name: 'เงินเดือน พ.ย.',
      gross_amount_satang: 3000000,
      bank_account_id: bankAccountId,
      income_date: '2026-11-28',
      auto_match: true,
      deductions: [],
      source_txn_id: salaryTxn,
    };

    const first = await app.request('/api/income-records', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(first.status, 201);

    const beforeSecond = (await (await app.request(`/api/tax/2026/summary?tax_entity_id=${entityA}`)).json()) as any;

    const second = await app.request('/api/income-records', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(second.status, 409, 'กดซ้ำต้องถูกปฏิเสธ ไม่ใช่สร้างรายได้ก้อนที่สอง');

    const afterSecond = (await (await app.request(`/api/tax/2026/summary?tax_entity_id=${entityA}`)).json()) as any;
    assert.equal(
      afterSecond.inputs.employmentIncomeSatang,
      beforeSecond.inputs.employmentIncomeSatang,
      'ยอดเงินได้ต้องไม่เพิ่มจากการกดซ้ำ',
    );

    // ธุรกรรมที่บันทึกไปแล้วต้องบอกได้ว่าผูกกับรายได้ไหน (หน้าเว็บจะได้ซ่อนปุ่มแทนที่จะให้กดแล้ว error)
    const detail = (await (await app.request(`/api/transactions/${salaryTxn}`)).json()) as any;
    assert.ok(detail.income_record_id != null, 'GET /transactions/:id ต้องบอกว่าธุรกรรมนี้เป็นรายได้แล้ว');
  });

  // เกณฑ์ต้องแคบพอ: บนข้อมูลจริงถ้าเสนอ "ทุกเงินเข้าที่ยังไม่มี income_record" จะได้ 53 รายการ
  // (เงินโอนจากญาติ ฝากเงินสด ดอกเบี้ย เศษ EDC ปนหมด) กดยืนยันทีเดียวคือได้รายได้ปลอมเต็มฐาน
  await t.test('เสนอเฉพาะเงินเข้าที่เข้าสม่ำเสมอและยอดใกล้เคียงกัน ไม่ใช่ทุกเงินเข้า', async () => {
    const before = (await (await app.request(`/api/tax/2026/summary?tax_entity_id=${entityA}`)).json()) as any;
    const beforeIds = before.unrecorded_income_txns.map((r: { id: number }) => r.id);
    assert.ok(!beforeIds.includes(businessIncomeTxn), 'รายการที่ tag business_income แล้วต้องไม่ถูกเสนอ');
    assert.ok(!beforeIds.includes(businessExpenseTxn), 'เงินออกต้องไม่ถูกเสนอเป็นรายได้');

    // เงินโอนครั้งเดียว ยอดสูง — ต้องไม่ถูกเสนอ (ไม่ใช่รายได้ประจำ)
    const oneOff = await insertTxn(5000000, 'credit', '2026-10-05');
    // เงินโอนจากคนรู้จักที่เข้าหลายเดือนแต่ยอดสะเปะสะปะ — ต้องไม่ถูกเสนอ
    const erratic = [
      await insertTxn(200000, 'credit', '2026-01-15'),
      await insertTxn(3000000, 'credit', '2026-02-15'),
      await insertTxn(150000, 'credit', '2026-03-15'),
    ];
    // เงินเดือนจริง: เข้า 3 เดือน ยอดใกล้เคียงกัน description ต่างแค่เลข ref
    const payroll: number[] = [];
    for (const [i, date] of ['2026-01-31', '2026-02-28', '2026-03-31'].entries()) {
      payroll.push(
        (
          await db.pool.query<{ id: number }>(
            `insert into txn (statement_id, bank_account_id, txn_date, description, amount_satang, direction, running_balance_satang)
             values ($1, $2, $3, $4, $5, 'credit', 100000000) returning id`,
            [statementId, bankAccountId, date, `รับโอนเงิน: จาก X0993 บจก.ตัวอย่าง PAYROLL Ref 2026${i}00111`, 4000000 + i * 1000],
          )
        ).rows[0]!.id,
      );
    }

    const res = (await (await app.request(`/api/tax/2026/summary?tax_entity_id=${entityA}`)).json()) as any;
    const ids = res.unrecorded_income_txns.map((r: { id: number }) => r.id);
    assert.ok(!ids.includes(oneOff), 'เงินเข้าครั้งเดียวต้องไม่ถูกเสนอ');
    for (const id of erratic) assert.ok(!ids.includes(id), 'เงินเข้าหลายเดือนแต่ยอดสะเปะสะปะต้องไม่ถูกเสนอ');
    for (const id of payroll) assert.ok(ids.includes(id), 'เงินเดือนที่เข้าทุกเดือนยอดใกล้เคียงกันต้องถูกเสนอ');

    // จับคู่ income_record กับเงินเดือนงวดหนึ่งแล้ว → งวดนั้นต้องหายจากรายการที่เสนอ
    const employmentBefore = res.inputs.employmentIncomeSatang as number;
    const plan = (
      await db.pool.query<{ id: number }>(`insert into monthly_plan (user_id, month_start) values ($1, '2026-01-01') returning id`, [userA])
    ).rows[0]!.id;
    const item = (
      await db.pool.query<{ id: number }>(
        `insert into monthly_plan_item (monthly_plan_id, kind, name, planned_amount_satang) values ($1, 'income', 'เงินเดือน ม.ค.', 4000000) returning id`,
        [plan],
      )
    ).rows[0]!.id;
    await db.pool.query(
      `insert into income_record (user_id, monthly_plan_id, monthly_plan_item_id, name, gross_amount_satang, expected_net_satang, bank_account_id, income_date)
       values ($1, $2, $3, 'เงินเดือน ม.ค.', 4000000, 4000000, $4, '2026-01-31')`,
      [userA, plan, item, bankAccountId],
    );
    await db.pool.query(
      `insert into monthly_item_payment (monthly_plan_item_id, amount_satang, paid_date, bank_account_id, txn_id, status, verified_at)
       values ($1, 4000000, '2026-01-31', $2, $3, 'matched', now())`,
      [item, bankAccountId, payroll[0]],
    );

    const done = (await (await app.request(`/api/tax/2026/summary?tax_entity_id=${entityA}`)).json()) as any;
    const doneIds = done.unrecorded_income_txns.map((r: { id: number }) => r.id);
    assert.ok(!doneIds.includes(payroll[0]), 'บันทึกเป็นรายได้แล้วต้องเลิกเสนอ');
    assert.equal(done.inputs.employmentIncomeSatang - employmentBefore, 4000000, 'ยอดต้องเข้าเงินได้จากงานประจำ');

    for (const id of [oneOff, ...erratic]) {
      await db.pool.query('delete from txn where id = $1', [id]);
    }
  });

  // ผู้ใช้ส่วนใหญ่มี Tax Entity เดียว — ไม่ควรบังคับให้ไปตั้ง default ที่หน้าบัญชีก่อนตัวเลขถึงจะขึ้น
  await t.test('มี Tax Entity เดียว → ธุรกรรม/รายได้ที่ไม่ได้ผูก entity ไว้ต้องตกมาที่ entity นั้นเอง', async () => {
    const soloUser = (
      await db.pool.query<{ id: number }>(
        `insert into app_user (google_sub, email, display_name, is_admin, status)
         values ('google-sub-tax8-solo', 'tax8-solo@example.com', 'Tax8 Solo', false, 'approved') returning id`,
      )
    ).rows[0]!.id;
    const soloEmail = (
      await db.pool.query<{ id: number }>(
        `insert into email_account (user_id, email, refresh_token_enc) values ($1, 'tax8-solo@example.com', 'enc:x') returning id`,
        [soloUser],
      )
    ).rows[0]!.id;
    // บัญชีนี้ "ไม่ได้ตั้ง" default_tax_entity_id ไว้เลย และธุรกรรมก็ไม่ได้ override entity
    const soloAccount = (
      await db.pool.query<{ id: number }>(
        `insert into bank_account (user_id, bank_id, email_account_id, nickname, account_number, pdf_password_enc)
         values ($1, $2, $3, 'บัญชีเดียว', 'xxx-x-x7777-x', 'enc:pw') returning id`,
        [soloUser, bankId, soloEmail],
      )
    ).rows[0]!.id;
    const soloStatement = (
      await db.pool.query<{ id: number }>(
        `insert into statement (bank_account_id, gmail_message_id, gmail_attachment_id, period_start, period_end, status)
         values ($1, 'gmail-solo', 'att-solo', '2026-01-01', '2026-12-31', 'parsed') returning id`,
        [soloAccount],
      )
    ).rows[0]!.id;
    const soloEntity = (
      await db.pool.query<{ id: number }>(
        `insert into tax_entity (user_id, entity_type, display_name) values ($1, 'individual', 'คนเดียว') returning id`,
        [soloUser],
      )
    ).rows[0]!.id;

    const soloTxn = (
      await db.pool.query<{ id: number }>(
        `insert into txn (statement_id, bank_account_id, txn_date, description, amount_satang, direction, running_balance_satang)
         values ($1, $2, '2026-06-01', 'ค่าจ้างฟรีแลนซ์', 7000000, 'credit', 9000000) returning id`,
        [soloStatement, soloAccount],
      )
    ).rows[0]!.id;
    await db.pool.query(
      `insert into txn_annotation (txn_id, classification, review_status, tax_treatment) values ($1, 'income', 'reviewed', 'business_income')`,
      [soloTxn],
    );

    // income_record ที่ไม่ได้ผูกบัญชีเลย ก็ต้อง resolve มาที่ entity เดียวนี้ ไม่ใช่ตกไปเป็น unresolved
    const soloPlan = (
      await db.pool.query<{ id: number }>(`insert into monthly_plan (user_id, month_start) values ($1, '2026-06-01') returning id`, [soloUser])
    ).rows[0]!.id;
    const soloItem = (
      await db.pool.query<{ id: number }>(
        `insert into monthly_plan_item (monthly_plan_id, kind, name, planned_amount_satang) values ($1, 'income', 'เงินเดือน', 4000000) returning id`,
        [soloPlan],
      )
    ).rows[0]!.id;
    await db.pool.query(
      `insert into income_record (user_id, monthly_plan_id, monthly_plan_item_id, name, gross_amount_satang, expected_net_satang, income_date)
       values ($1, $2, $3, 'เงินเดือน', 4000000, 4000000, '2026-06-25')`,
      [soloUser, soloPlan, soloItem],
    );

    const soloApp = await listen(appFor(soloUser));
    t.after(soloApp.close);
    const res = await soloApp.request(`/api/tax/2026/summary?tax_entity_id=${soloEntity}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.inputs.otherIncomeSatang, 7000000, 'ธุรกรรมที่ไม่ได้ผูก entity ต้องตกมาที่ entity เดียวที่มี');
    assert.equal(body.inputs.employmentIncomeSatang, 4000000, 'income_record ที่ไม่ได้ผูกบัญชีก็ต้อง resolve ได้');
    assert.equal(body.inputs.unresolvedIncomeSatang, 0, 'ไม่ควรเหลือรายได้ที่ resolve ไม่ได้อีก');

    // drill-down ต้องยังตรงกับการ์ดเป๊ะ (fallback ต้องอยู่ใน fragment ร่วม ไม่ใช่แค่ฝั่งคำนวณ)
    const qs = new URLSearchParams(body.drilldown_params.other_income as Record<string, string>).toString();
    const drill = await soloApp.request(`/api/transactions?${qs}`);
    const drillBody = (await drill.json()) as { rows: { amount_satang: number }[] };
    assert.equal(drillBody.rows.reduce((s, r) => s + r.amount_satang, 0), 7000000);
  });

  // ผู้ใช้ที่มีหลาย entity ต้องไม่เปลี่ยนพฤติกรรม — ของที่ไม่ได้ผูกไว้ต้องไม่ถูกเดาให้
  await t.test('มีหลาย Tax Entity → ธุรกรรมที่ไม่ได้ผูก entity ต้องไม่ถูกเดาเข้า entity ใดเลย', async () => {
    const unlinkedTxn = await insertTxn(1234500, 'credit', '2026-09-09');
    await annotate(unlinkedTxn, 'business_income');
    // userA มีสอง entity (entityA + entityCompany) และบัญชีนี้ default = entityA อยู่แล้ว จึงต้องเข้า entityA ตามเดิม
    const res = await app.request(`/api/tax/2026/summary?tax_entity_id=${entityCompany}`);
    const body = (await res.json()) as any;
    assert.equal(body.inputs.otherIncomeSatang, 0, 'บริษัทต้องไม่ได้รับยอดของบัญชีที่ผูกกับบุคคลธรรมดา');
    await db.pool.query('delete from txn_annotation where txn_id = $1', [unlinkedTxn]);
    await db.pool.query('delete from txn where id = $1', [unlinkedTxn]);
  });

  await t.test('ownership: tax_entity ของคนอื่นเข้าไม่ได้ (403/404) — ครบทุก endpoint ใหม่', async () => {
    const userB = (
      await db.pool.query<{ id: number }>(
        `insert into app_user (google_sub, email, display_name, is_admin, status)
         values ('google-sub-tax8-b', 'tax8-b@example.com', 'Tax8 B', false, 'approved') returning id`,
      )
    ).rows[0]!.id;
    const appB = await listen(appFor(userB));
    t.after(appB.close);

    const summaryRes = await appB.request(`/api/tax/2026/summary?tax_entity_id=${entityA}`);
    assert.equal(summaryRes.status, 403);

    const snapshotsRes = await appB.request(`/api/tax/2026/snapshots?tax_entity_id=${entityA}`);
    assert.equal(snapshotsRes.status, 403);

    const exportRes = await appB.request(`/api/tax/2026/export.csv?tax_entity_id=${entityA}`);
    assert.equal(exportRes.status, 403);

    // list ไม่รับ tax_entity_id ที่ไม่ใช่ของตัวเองเป็น error เพราะ scope ด้วย c.user_id เสมออยู่แล้ว —
    // ยืนยันว่า "ปลอดภัยโดยไม่ error" จริง: ต้องไม่เห็นค่าลดหย่อนของ A แม้ระบุ tax_entity_id ของ A มาตรง ๆ
    const claimsRes = await appB.request(`/api/tax/deduction-claims?tax_entity_id=${entityA}`);
    assert.equal(claimsRes.status, 200);
    const claimsBody = (await claimsRes.json()) as { rows: unknown[] };
    assert.equal(claimsBody.rows.length, 0);
  });
});
