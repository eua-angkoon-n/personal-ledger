import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createTestDb } from './helpers/db.js';

process.env.ENCRYPTION_KEY = '0'.repeat(64);

type LoanResponse = {
  loan: { id: number; monthly_saving_satang: number; payoff_discount_bp: number } | null;
  input: { monthly_saving_satang: number } | null;
  projections: Record<
    'lump_sum' | 'extra_monthly' | 'minimum_only',
    { payoff_date: string | null; total_payment_satang: number; discount_satang: number; installments: unknown[] }
  > | null;
};

// แผนปลดหนี้ กยศ. ฝั่ง API — migration roll-forward, upsert หนึ่งแถวต่อ user, กันข้าม user และ what-if override
test('student loan API: upsert, projection, what-if override, cross-user isolation', async (t) => {
  const db = await createTestDb();
  if (db.skip) {
    t.skip(db.reason);
    return;
  }
  t.after(db.cleanup);
  await db.migrate();

  const { HttpError } = await import('../src/http.js');
  const { studentLoanRouter } = await import('../src/routes/student-loan.js');

  function appFor(userId: number) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { session: { userId?: number } }).session = { userId };
      next();
    });
    app.use('/api', studentLoanRouter);
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
      const code = (err as { code?: string }).code;
      if (code === '23505') return void res.status(409).json({ error: 'ซ้ำ' });
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

  const mkUser = async (suffix: string) =>
    (
      await db.pool.query<{ id: number }>(
        `insert into app_user (google_sub, email, display_name, is_admin, status)
         values ($1, $2, $3, false, 'approved') returning id`,
        [`google-sub-loan-${suffix}`, `loan-${suffix}@example.com`, `Loan ${suffix}`],
      )
    ).rows[0]!.id;

  const userA = await mkUser('a');
  const userB = await mkUser('b');

  const a = await listen(appFor(userA));
  const b = await listen(appFor(userB));
  t.after(() => {
    a.close();
    b.close();
  });

  const payload = {
    principal_original_satang: 200_000 * 100,
    first_due_date: '2020-07-05',
    as_of_date: '2026-09-17',
    principal_remaining_satang: 120_000 * 100,
    interest_accrued_satang: 350 * 100,
    monthly_payment_satang: 750 * 100,
    monthly_saving_satang: 8_000 * 100,
    savings_balance_satang: 0,
    app_annual_due_satang: 8_814 * 100 + 96,
    payoff_discount_bp: 300,
    payment_day: 5,
  };

  const put = (path: string, body: unknown) =>
    a.request(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  await t.test('ยังไม่มีข้อมูล → คืน null ทั้งชุด ไม่ใช่ 404', async () => {
    const res = await a.request('/api/student-loan');
    assert.equal(res.status, 200);
    const body = (await res.json()) as LoanResponse;
    assert.equal(body.loan, null);
    assert.equal(body.projections, null);
  });

  await t.test('สร้างครั้งแรกได้ 201 พร้อม projection ครบสามฉาก', async () => {
    const res = await put('/api/student-loan', payload);
    assert.equal(res.status, 201);
    const body = (await res.json()) as LoanResponse;
    assert.notEqual(body.loan, null);
    assert.notEqual(body.projections, null);
    for (const s of ['lump_sum', 'extra_monthly', 'minimum_only'] as const) {
      assert.notEqual(body.projections![s].payoff_date, null, `ฉาก ${s} ต้องคำนวณวันปิดหนี้ได้`);
      assert.ok(body.projections![s].installments.length > 0);
    }
    // เก็บออม 8,000/เดือน ต้องปิดได้ก่อนการจ่ายขั้นต่ำอย่างเดียวเสมอ
    assert.ok(body.projections!.lump_sum.payoff_date! < body.projections!.minimum_only.payoff_date!);
    assert.ok(body.projections!.lump_sum.discount_satang > 0);
    assert.equal(body.projections!.minimum_only.discount_satang, 0);
  });

  await t.test('บันทึกซ้ำเป็น upsert ไม่สร้างแถวที่สอง', async () => {
    const res = await put('/api/student-loan', { ...payload, monthly_saving_satang: 10_000 * 100 });
    assert.equal(res.status, 200);
    const body = (await res.json()) as LoanResponse;
    assert.equal(body.loan!.monthly_saving_satang, 10_000 * 100);
    // src/db.ts แปลง BIGINT เป็น number ให้แล้ว count(*) จึงกลับมาเป็นตัวเลข ไม่ใช่ string
    const { rows } = await db.pool.query<{ n: number }>(
      'select count(*)::int as n from student_loan where user_id = $1',
      [userA],
    );
    assert.equal(rows[0]!.n, 1);
  });

  await t.test('what-if override เปลี่ยนผลลัพธ์แต่ไม่แตะค่าที่บันทึกไว้', async () => {
    const saved = (await (await a.request('/api/student-loan')).json()) as LoanResponse;
    const whatIf = (await (
      await a.request('/api/student-loan?monthly_saving_satang=' + 20_000 * 100)
    ).json()) as LoanResponse;

    assert.ok(whatIf.projections!.lump_sum.payoff_date! < saved.projections!.lump_sum.payoff_date!);
    assert.equal(whatIf.input!.monthly_saving_satang, 20_000 * 100);
    assert.equal(whatIf.loan!.monthly_saving_satang, 10_000 * 100, 'ค่าที่บันทึกไว้ต้องไม่ถูกแก้');
  });

  await t.test('override ที่ไม่ใช่จำนวนเต็มสตางค์ → 400 ไม่ใช่ 500', async () => {
    const res = await a.request('/api/student-loan?monthly_saving_satang=abc');
    assert.equal(res.status, 400);
  });

  await t.test('เงินต้นคงเหลือมากกว่ายอดกู้ตามสัญญา → 400', async () => {
    const res = await put('/api/student-loan', { ...payload, principal_remaining_satang: 999_999 * 100 });
    assert.equal(res.status, 400);
  });

  await t.test('วันที่ไม่มีจริง → 400 ไม่ใช่ 500', async () => {
    const res = await put('/api/student-loan', { ...payload, first_due_date: '2020-02-31' });
    assert.equal(res.status, 400);
  });

  await t.test('ผู้ใช้อีกคนไม่เห็นหนี้ของคนแรก', async () => {
    const res = await b.request('/api/student-loan');
    const body = (await res.json()) as LoanResponse;
    assert.equal(body.loan, null);
  });

  await t.test('เขียน audit_log ทั้งตอนสร้างและตอนแก้', async () => {
    const { rows } = await db.pool.query<{ action: string }>(
      `select action from audit_log where user_id = $1 and entity_type = 'student_loan' order by id`,
      [userA],
    );
    assert.deepEqual(
      rows.map((r) => r.action),
      ['student_loan.create', 'student_loan.update'],
    );
  });
});
