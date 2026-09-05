// Slice 5: แผนรายเดือน / รายการประจำ / Payment Declaration / Reconciliation — ต่อ Postgres จริง
// ห้าม static import จาก src/* ที่แตะ src/db.ts (อ่าน env.databaseUrl ตอน import) ก่อน createTestDb()
// ดู comment ใน test/helpers/db.ts
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express, { type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import { createTestDb } from './helpers/db.js';

type Item = {
  id: number;
  name: string;
  kind: string;
  planned_amount_satang: number;
  due_date: string | null;
  explicit_status: string;
  payment_state: string;
  paid_satang: number;
  matched_satang: number;
  needs_review_count: number;
  recurring_rule_id: number | null;
  payments: { id: number; status: string; txn_id: number | null; verified_at: string | null }[];
};

type PlanResponse = {
  month: string;
  month_start: string;
  status: 'open' | 'closed';
  closed_at: string | null;
  closed_snapshot: { totals: { planned_available_satang: number } } | null;
  generated_item_count: number;
  totals: {
    planned_income_satang: number;
    planned_deduction_satang: number;
    planned_expense_satang: number;
    planned_reserve_satang: number;
    planned_available_satang: number;
  };
  payment_status: { total_count: number; unpaid_count: number; overdue_count: number; verified_count: number };
  items: Item[];
};

function shiftMonth(delta: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

test('monthly planning API', async (t) => {
  const db = await createTestDb();
  if (db.skip) {
    t.skip(db.reason);
    return;
  }
  t.after(db.cleanup);
  await db.migrate();

  const { api, HttpError } = await import('../src/api.js');
  const { reconcilePayments } = await import('../src/services/payment-reconciliation.js');
  const { pool } = await import('../src/db.js');

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
    const code = (err as { code?: string }).code;
    if (code === '23505') return void res.status(409).json({ error: 'ซ้ำ' });
    if (code === '23514') return void res.status(400).json({ error: 'ไม่ผ่านเงื่อนไข' });
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
    if (init.body) headers.set('content-type', 'application/json');
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers });
    const setCookie = res.headers.getSetCookie()[0];
    if (setCookie) cookie = setCookie.split(';', 1)[0]!;
    return res;
  };
  const send = (path: string, method: 'POST' | 'PATCH', body: unknown) =>
    request(path, { method, body: JSON.stringify(body) });
  const getPlan = async (month: string): Promise<PlanResponse> => {
    const res = await request(`/api/monthly-plans/${month}`);
    assert.equal(res.status, 200);
    return (await res.json()) as PlanResponse;
  };
  const itemNamed = (plan: PlanResponse, name: string): Item => {
    const found = plan.items.find((i) => i.name === name);
    assert.ok(found, `ไม่พบรายการชื่อ ${name} ใน ${plan.month}`);
    return found;
  };

  const user = await db.pool.query<{ id: number }>(
    `insert into app_user (google_sub, email, display_name, is_admin, status)
     values ('google-sub-1', 'member@example.com', 'Family Member', false, 'approved') returning id`,
  );
  const userId = user.rows[0]!.id;
  await send('/test/login', 'POST', { userId });

  const emailAccountId = (
    await db.pool.query<{ id: number }>(
      `insert into email_account (user_id, email, refresh_token_enc)
       values ($1, 'member@example.com', 'enc:refresh-token') returning id`,
      [userId],
    )
  ).rows[0]!.id;
  const bankId = (await db.pool.query<{ id: number }>(`select id from bank where lower(name) = 'scb'`)).rows[0]!.id;

  const accountId = (
    await db.pool.query<{ id: number }>(
      `insert into bank_account (user_id, bank_id, email_account_id, nickname, account_number, pdf_password_enc)
       values ($1, $2, $3, 'บัญชีหลัก', '111-1-11111-1', 'enc:x') returning id`,
      [userId, bankId, emailAccountId],
    )
  ).rows[0]!.id;
  const statementId = (
    await db.pool.query<{ id: number }>(
      `insert into statement (bank_account_id, gmail_message_id, gmail_attachment_id, period_start, period_end, status)
       values ($1, 'msg-plan-1', 'att-plan-1', '2026-08-01', '2026-08-31', 'parsed') returning id`,
      [accountId],
    )
  ).rows[0]!.id;

  let runningBalance = 1_000_000;
  async function seedTxn(opts: { date: string; amount: number; direction: 'credit' | 'debit' }): Promise<number> {
    runningBalance += 100;
    const row = await db.pool.query<{ id: number }>(
      `insert into txn (statement_id, bank_account_id, txn_date, description, amount_satang, direction, running_balance_satang)
       values ($1, $2, $3, 'รายการทดสอบ', $4, $5, $6) returning id`,
      [statementId, accountId, opts.date, opts.amount, opts.direction, runningBalance],
    );
    return row.rows[0]!.id;
  }
  const txnCount = async (): Promise<number> =>
    (await db.pool.query<{ n: number }>('select count(*)::int as n from txn')).rows[0]!.n;

  // generateMonthlyItems ไม่ generate ย้อนเดือนที่ผ่านไปแล้ว (§9.2) จึงต้องใช้เดือนปัจจุบันขึ้นไป
  // แยกเดือนต่อกลุ่มทดสอบเพื่อไม่ให้ยอดรวมระดับแผนของกลุ่มหนึ่งปนกับอีกกลุ่ม (assert รายรายการปนได้)
  const MONTH_RULES = shiftMonth(0);
  const MONTH_RULES_NEXT = shiftMonth(1);
  const MONTH_COPY_TARGET = shiftMonth(2);
  const MONTH_PAYMENTS = shiftMonth(3);
  const MONTH_RECONCILE = shiftMonth(4);
  const MONTH_TOTALS = shiftMonth(5);
  const MONTH_CLOSING = shiftMonth(6);

  await t.test('รายการประจำ: กางให้เอง idempotent และการแก้กฎไม่ย้อนแก้เดือนที่ generate แล้ว', async () => {
    const created = await send('/api/recurring-rules', 'POST', {
      name: 'ค่าเช่าบ้าน',
      kind: 'expense',
      amount_satang: 1_500_000,
      frequency_unit: 'month',
      frequency_interval: 1,
      anchor_day: 5,
      start_date: `${MONTH_RULES}-01`,
    });
    assert.equal(created.status, 201);
    const ruleId = ((await created.json()) as { id: number }).id;

    const first = await getPlan(MONTH_RULES);
    assert.equal(first.generated_item_count, 1);
    const item = itemNamed(first, 'ค่าเช่าบ้าน');
    assert.equal(item.due_date, `${MONTH_RULES}-05`);
    assert.equal(item.planned_amount_satang, 1_500_000);
    assert.equal(item.recurring_rule_id, ruleId);

    // §16 ข้อ 15: เรียกซ้ำต้องไม่เกิดแถวซ้ำ
    const again = await getPlan(MONTH_RULES);
    assert.equal(again.generated_item_count, 0);
    assert.equal(again.items.filter((i) => i.name === 'ค่าเช่าบ้าน').length, 1);

    // §16 ข้อ 16: แก้กฎแล้วเดือนที่ generate ไปแล้วต้องไม่ขยับ มีผลเฉพาะเดือนที่ยังไม่ generate
    const patched = await send(`/api/recurring-rules/${ruleId}`, 'PATCH', { amount_satang: 1_800_000 });
    assert.equal(patched.status, 200);
    assert.equal(itemNamed(await getPlan(MONTH_RULES), 'ค่าเช่าบ้าน').planned_amount_satang, 1_500_000);
    assert.equal(itemNamed(await getPlan(MONTH_RULES_NEXT), 'ค่าเช่าบ้าน').planned_amount_satang, 1_800_000);

    // เลื่อน due_date ของรายการที่มาจากกฎ แล้ว GET ซ้ำ **ต้องไม่เกิดแถวซ้ำ** — คีย์กันซ้ำคือ
    // occurrence_date ที่ผู้ใช้แก้ไม่ได้ ถ้าใช้ due_date เป็นคีย์ generate รอบหน้าจะสร้างวันที่ 05 กลับมา
    const moved = await send(`/api/monthly-plan-items/${item.id}`, 'PATCH', { due_date: `${MONTH_RULES}-25` });
    assert.equal(moved.status, 200);
    const afterMove = await getPlan(MONTH_RULES);
    assert.equal(afterMove.generated_item_count, 0);
    assert.equal(afterMove.items.filter((i) => i.recurring_rule_id === ruleId).length, 1);
    assert.equal(itemNamed(afterMove, 'ค่าเช่าบ้าน').due_date, `${MONTH_RULES}-25`);

    // เคสเดียวกันแต่ล้าง due_date เป็น null (NULL ไม่ชน unique index ถ้าคีย์เป็น due_date)
    assert.equal((await send(`/api/monthly-plan-items/${item.id}`, 'PATCH', { due_date: null })).status, 200);
    const afterClear = await getPlan(MONTH_RULES);
    assert.equal(afterClear.generated_item_count, 0);
    assert.equal(afterClear.items.filter((i) => i.recurring_rule_id === ruleId).length, 1);

    // เดือนที่ผ่านไปแล้วต้องไม่ถูก generate ย้อนหลัง — กฎที่เพิ่งสร้าง/เพิ่งแก้ห้ามเปลี่ยนอดีต (§9.2)
    const past = await getPlan(shiftMonth(-1));
    assert.equal(past.generated_item_count, 0);
    assert.equal(past.items.length, 0);

    // archive แล้วเดือนใหม่ไม่ generate อีก แต่ของเดิมยังอยู่เป็นประวัติ
    assert.equal((await send(`/api/recurring-rules/${ruleId}/archive`, 'POST', {})).status, 200);
    assert.equal(itemNamed(await getPlan(MONTH_RULES), 'ค่าเช่าบ้าน').planned_amount_satang, 1_500_000);
  });

  await t.test('รายการเฉพาะเดือน: เพิ่ม copy จากเดือนก่อน (ซ้ำไม่ได้) และ skip โดยไม่ลบประวัติ', async () => {
    await getPlan(MONTH_RULES_NEXT);
    const oneOff = await send(`/api/monthly-plans/${MONTH_RULES_NEXT}/items`, 'POST', {
      kind: 'expense',
      name: 'ค่าเน็ต',
      planned_amount_satang: 59_900,
      due_date: `${MONTH_RULES_NEXT}-10`,
    });
    assert.equal(oneOff.status, 201);

    // due_date นอกเดือนของแผนต้องถูกปฏิเสธ
    const wrongMonth = await send(`/api/monthly-plans/${MONTH_RULES_NEXT}/items`, 'POST', {
      kind: 'expense',
      name: 'ผิดเดือน',
      planned_amount_satang: 100,
      due_date: `${MONTH_COPY_TARGET}-10`,
    });
    assert.equal(wrongMonth.status, 400);

    await getPlan(MONTH_COPY_TARGET);
    const copied = await send(`/api/monthly-plans/${MONTH_COPY_TARGET}/copy-previous`, 'POST', {});
    assert.equal(copied.status, 201);
    // copy เฉพาะ one-off — รายการจากกฎเกิดเองตอน GET อยู่แล้ว copy มาอีกจะกลายเป็นแถวซ้ำ
    assert.deepEqual(await copied.json(), { copied_count: 1, from_month_start: `${MONTH_RULES_NEXT}-01` });

    const twice = await send(`/api/monthly-plans/${MONTH_COPY_TARGET}/copy-previous`, 'POST', {});
    assert.equal(((await twice.json()) as { copied_count: number }).copied_count, 0);

    const target = await getPlan(MONTH_COPY_TARGET);
    const net = itemNamed(target, 'ค่าเน็ต');
    assert.equal(net.due_date, `${MONTH_COPY_TARGET}-10`);
    assert.equal(net.recurring_rule_id, null);
    const expenseBefore = target.totals.planned_expense_satang;

    const skipped = await send(`/api/monthly-plan-items/${net.id}/skip`, 'POST', {});
    assert.equal(skipped.status, 200);
    const after = await getPlan(MONTH_COPY_TARGET);
    // แถวยังอยู่ (ประวัติ + กัน generate ซ้ำ) แต่ไม่นับในยอดตามแผนแล้ว
    assert.equal(itemNamed(after, 'ค่าเน็ต').explicit_status, 'skipped');
    assert.equal(itemNamed(after, 'ค่าเน็ต').payment_state, 'skipped');
    assert.equal(after.totals.planned_expense_satang, expenseBefore - 59_900);
  });

  await t.test('mark paid ไม่สร้าง txn และจ่ายบางส่วนคำนวณจากผลรวม payment', async () => {
    await getPlan(MONTH_PAYMENTS);
    const itemId = ((await (
      await send(`/api/monthly-plans/${MONTH_PAYMENTS}/items`, 'POST', {
        kind: 'expense',
        name: 'ค่าไฟ',
        planned_amount_satang: 100_000,
        due_date: `${MONTH_PAYMENTS}-20`,
      })
    ).json()) as { id: number }).id;

    // §3 ข้อ 5 / DoD: mark paid ห้ามสร้าง txn ปลอม — เช็คจำนวนแถวในฐานจริง ไม่ใช่แค่ status 201
    const before = await txnCount();
    const paid = await send(`/api/monthly-plan-items/${itemId}/payments`, 'POST', {
      amount_satang: 40_000,
      paid_date: `${MONTH_PAYMENTS}-20`,
      bank_account_id: accountId,
    });
    assert.equal(paid.status, 201);
    assert.equal(await txnCount(), before);
    assert.equal(((await paid.json()) as { status: string; txn_id: number | null }).status, 'declared');

    const partial = itemNamed(await getPlan(MONTH_PAYMENTS), 'ค่าไฟ');
    assert.equal(partial.payment_state, 'partial');
    assert.equal(partial.paid_satang, 40_000);

    await send(`/api/monthly-plan-items/${itemId}/payments`, 'POST', {
      amount_satang: 60_000,
      paid_date: `${MONTH_PAYMENTS}-21`,
      bank_account_id: accountId,
    });
    const full = itemNamed(await getPlan(MONTH_PAYMENTS), 'ค่าไฟ');
    // จ่ายครบแต่ยัง matched ไม่ครบ = "จ่ายแล้ว รอ statement" ไม่ใช่ verified (§16 ข้อ 6)
    assert.equal(full.payment_state, 'declared');
    assert.equal(full.paid_satang, 100_000);
    assert.equal(full.matched_satang, 0);
    assert.equal(await txnCount(), before);

    // ยกเลิกการประกาศจ่ายแล้วยอดจ่ายต้องลดลง (cancelled ไม่นับเป็นยอดจ่าย)
    const cancelled = await send(`/api/monthly-item-payments/${full.payments[0]!.id}`, 'PATCH', {
      status: 'cancelled',
    });
    assert.equal(cancelled.status, 200);
    assert.equal(itemNamed(await getPlan(MONTH_PAYMENTS), 'ค่าไฟ').paid_satang, 60_000);
  });

  await t.test('รายการยอดประมาณการ 0 บาทที่ประกาศจ่ายแล้วต้องไม่ขึ้นว่า verified', async () => {
    await getPlan(MONTH_PAYMENTS);
    const zeroItemId = ((await (
      await send(`/api/monthly-plans/${MONTH_PAYMENTS}/items`, 'POST', {
        kind: 'expense',
        name: 'ค่าน้ำมัน (ยังไม่รู้ยอด)',
        planned_amount_satang: 0,
      })
    ).json()) as { id: number }).id;
    // ยังไม่จ่ายและไม่มี due_date → unpaid ไม่ใช่ verified จาก 0 >= 0
    assert.equal(itemNamed(await getPlan(MONTH_PAYMENTS), 'ค่าน้ำมัน (ยังไม่รู้ยอด)').payment_state, 'unpaid');
    await send(`/api/monthly-plan-items/${zeroItemId}/payments`, 'POST', {
      amount_satang: 30_000,
      paid_date: `${MONTH_PAYMENTS}-15`,
      bank_account_id: accountId,
    });
    // ประกาศจ่ายแล้วแต่ยังไม่มี txn จับคู่ → declared (§16 ข้อ 6) ไม่ใช่ verified
    assert.equal(itemNamed(await getPlan(MONTH_PAYMENTS), 'ค่าน้ำมัน (ยังไม่รู้ยอด)').payment_state, 'declared');
  });

  await t.test('overdue อ่านจาก current_date และ due_date ที่เป็น null ต้องเป็น unpaid ไม่ใช่ NULL', async () => {
    const plan = await getPlan(MONTH_RECONCILE);
    await db.pool.query(
      `insert into monthly_plan_item (monthly_plan_id, kind, name, planned_amount_satang, due_date)
       values ($1, 'expense', 'เลยกำหนด', 1000, current_date - 1), ($1, 'expense', 'ไม่มีกำหนด', 1000, null)`,
      [
        (
          await db.pool.query<{ id: number }>('select id from monthly_plan where user_id = $1 and month_start = $2', [
            userId,
            plan.month_start,
          ])
        ).rows[0]!.id,
      ],
    );
    const withDates = await getPlan(MONTH_RECONCILE);
    assert.equal(itemNamed(withDates, 'เลยกำหนด').payment_state, 'overdue');
    assert.equal(itemNamed(withDates, 'ไม่มีกำหนด').payment_state, 'unpaid');
  });

  await t.test('reconciliation: candidate เดียวจับให้ สองอันส่งให้ตรวจ และ txn เดิมจับซ้ำไม่ได้', async () => {
    await getPlan(MONTH_RECONCILE);
    const payDate = `${MONTH_RECONCILE}-15`;
    await seedTxn({ date: payDate, amount: 77_000, direction: 'debit' });

    const itemId = ((await (
      await send(`/api/monthly-plans/${MONTH_RECONCILE}/items`, 'POST', {
        kind: 'expense',
        name: 'ค่าน้ำ',
        planned_amount_satang: 77_000,
        due_date: payDate,
      })
    ).json()) as { id: number }).id;

    const paid = await send(`/api/monthly-plan-items/${itemId}/payments`, 'POST', {
      amount_satang: 77_000,
      paid_date: payDate,
      bank_account_id: accountId,
    });
    const payment = (await paid.json()) as { status: string; txn_id: number | null; verified_at: string | null };
    assert.equal(payment.status, 'matched');
    assert.ok(payment.txn_id);
    assert.ok(payment.verified_at);
    const verified = itemNamed(await getPlan(MONTH_RECONCILE), 'ค่าน้ำ');
    assert.equal(verified.payment_state, 'verified');
    assert.equal(verified.matched_satang, 77_000);

    // txn ตัวเดิมถูกจับไปแล้ว รายการอื่นที่ยอด/วันเหมือนกันต้องไม่ถูกจับคู่ซ้ำ (§16 ข้อ 7)
    const secondItemId = ((await (
      await send(`/api/monthly-plans/${MONTH_RECONCILE}/items`, 'POST', {
        kind: 'expense',
        name: 'ค่าน้ำอีกหลัง',
        planned_amount_satang: 77_000,
        due_date: payDate,
      })
    ).json()) as { id: number }).id;
    const second = await send(`/api/monthly-plan-items/${secondItemId}/payments`, 'POST', {
      amount_satang: 77_000,
      paid_date: payDate,
      bank_account_id: accountId,
    });
    assert.equal(((await second.json()) as { status: string }).status, 'declared');

    // candidate สองตัว → needs_review ไม่เดา (§9.5 auto-match เฉพาะ candidate เดียว)
    await seedTxn({ date: `${MONTH_RECONCILE}-18`, amount: 33_000, direction: 'debit' });
    await seedTxn({ date: `${MONTH_RECONCILE}-19`, amount: 33_000, direction: 'debit' });
    const ambiguousItemId = ((await (
      await send(`/api/monthly-plans/${MONTH_RECONCILE}/items`, 'POST', {
        kind: 'expense',
        name: 'ค่าโทรศัพท์',
        planned_amount_satang: 33_000,
        due_date: `${MONTH_RECONCILE}-18`,
      })
    ).json()) as { id: number }).id;
    const ambiguous = await send(`/api/monthly-plan-items/${ambiguousItemId}/payments`, 'POST', {
      amount_satang: 33_000,
      paid_date: `${MONTH_RECONCILE}-18`,
      bank_account_id: accountId,
    });
    const needsReview = (await ambiguous.json()) as { id: number; status: string; txn_id: number | null };
    assert.equal(needsReview.status, 'needs_review');
    assert.equal(needsReview.txn_id, null);

    // needs_review ต้องไม่ทำให้รายการเด้งกลับเป็น "ยังไม่จ่าย" — ผู้ใช้ประกาศจ่ายไปแล้ว
    // ระบบแค่ยังไม่รู้ว่าคู่กับ txn ตัวไหน จึงยังเป็น declared และมีตัวนับให้ผู้ใช้ไปเลือกเอง
    const pending = itemNamed(await getPlan(MONTH_RECONCILE), 'ค่าโทรศัพท์');
    assert.equal(pending.payment_state, 'declared');
    assert.equal(pending.paid_satang, 33_000);
    assert.equal(pending.matched_satang, 0);
    assert.equal(pending.needs_review_count, 1);

    // ผู้ใช้เลือกเองผ่าน PATCH ปิดวง needs_review
    const chosenTxnId = (
      await db.pool.query<{ id: number }>(
        `select id from txn where amount_satang = 33000 and bank_account_id = $1 order by id limit 1`,
        [accountId],
      )
    ).rows[0]!.id;
    const resolved = await send(`/api/monthly-item-payments/${needsReview.id}`, 'PATCH', { txn_id: chosenTxnId });
    assert.equal(resolved.status, 200);
    assert.equal(((await resolved.json()) as { status: string }).status, 'matched');
    assert.equal(itemNamed(await getPlan(MONTH_RECONCILE), 'ค่าโทรศัพท์').payment_state, 'verified');

    // ยืนยันด้วยมือต้องตรวจยอดและทิศทางเหมือน auto-match — ไม่งั้นผูก payment ก้อนใหญ่กับ txn
    // ก้อนเล็กได้แล้วรายการจะขึ้นว่า "ยืนยันจาก statement แล้ว" (matched_satang นับยอดของ payment)
    const wrongAmountTxnId = await seedTxn({ date: `${MONTH_RECONCILE}-18`, amount: 1_000, direction: 'debit' });
    const creditTxnId = await seedTxn({ date: `${MONTH_RECONCILE}-18`, amount: 33_000, direction: 'credit' });
    const stillDeclaredId = (
      await db.pool.query<{ id: number }>(
        `select id from monthly_item_payment where monthly_plan_item_id = $1 and status = 'declared' limit 1`,
        [secondItemId],
      )
    ).rows[0]!.id;
    assert.equal(
      (await send(`/api/monthly-item-payments/${stillDeclaredId}`, 'PATCH', { txn_id: wrongAmountTxnId })).status,
      400,
    );
    assert.equal(
      (await send(`/api/monthly-item-payments/${stillDeclaredId}`, 'PATCH', { txn_id: creditTxnId })).status,
      400,
    );

    // จับคู่ซ้ำกับ txn ที่ถูกจองแล้วต้องไม่ผ่าน (partial unique index เป็นคนบังคับ)
    const dup = await db.pool
      .query(`update monthly_item_payment set status = 'matched', txn_id = $1 where id = $2`, [
        chosenTxnId,
        (
          await db.pool.query<{ id: number }>(
            `select id from monthly_item_payment where monthly_plan_item_id = $1 and status = 'declared' limit 1`,
            [secondItemId],
          )
        ).rows[0]!.id,
      ])
      .then(() => null)
      .catch((e: { code?: string }) => e.code);
    assert.equal(dup, '23505');
  });

  await t.test('reconcile ต้องไม่ดูด txn ไปจองให้รายการที่ skip ไปแล้ว', async () => {
    await getPlan(MONTH_RECONCILE);
    const skippedItemId = ((await (
      await send(`/api/monthly-plans/${MONTH_RECONCILE}/items`, 'POST', {
        kind: 'expense',
        name: 'ยกเลิกไปแล้ว',
        planned_amount_satang: 91_000,
        due_date: `${MONTH_RECONCILE}-10`,
      })
    ).json()) as { id: number }).id;
    await send(`/api/monthly-plan-items/${skippedItemId}/payments`, 'POST', {
      amount_satang: 91_000,
      paid_date: `${MONTH_RECONCILE}-10`,
      bank_account_id: accountId,
    });
    await send(`/api/monthly-plan-items/${skippedItemId}/skip`, 'POST', {});

    // txn จริงมาถึงทีหลัง — ต้องไปไม่ถึง payment ของรายการที่ skip แล้ว ไม่งั้น txn ถูกจอง
    // แล้วรายการที่ถูกต้องจับคู่กับมันไม่ได้อีกเลย (partial unique index)
    await seedTxn({ date: `${MONTH_RECONCILE}-10`, amount: 91_000, direction: 'debit' });
    await reconcilePayments(pool, userId);
    const stale = await db.pool.query<{ status: string; txn_id: number | null }>(
      'select status, txn_id from monthly_item_payment where monthly_plan_item_id = $1',
      [skippedItemId],
    );
    assert.equal(stale.rows[0]!.status, 'declared');
    assert.equal(stale.rows[0]!.txn_id, null);
  });

  await t.test('Reserve ลดเงินเหลือใช้ตามแผนแต่ไม่เป็น Expense ทั้งก่อนและหลังจับคู่ txn จริง', async () => {
    await getPlan(MONTH_TOTALS);
    const add = async (kind: string, name: string, amount: number) =>
      ((await (
        await send(`/api/monthly-plans/${MONTH_TOTALS}/items`, 'POST', {
          kind,
          name,
          planned_amount_satang: amount,
        })
      ).json()) as { id: number }).id;

    await add('income', 'เงินเดือน', 5_000_000);
    await add('payroll_deduction', 'ประกันสังคม', 75_000);
    await add('expense', 'ค่าอาหาร', 800_000);
    const reserveItemId = await add('reserve', 'เก็บเข้ากองทุนฉุกเฉิน', 1_000_000);

    const totals = (await getPlan(MONTH_TOTALS)).totals;
    assert.equal(totals.planned_income_satang, 5_000_000);
    assert.equal(totals.planned_deduction_satang, 75_000);
    // §9.4 / §16 ข้อ 4: reserve ไม่เข้ารายจ่ายตามแผน...
    assert.equal(totals.planned_expense_satang, 800_000);
    assert.equal(totals.planned_reserve_satang, 1_000_000);
    // ...แต่ลดเงินเหลือใช้ตามแผน (สูตร §8.2)
    assert.equal(totals.planned_available_satang, 5_000_000 - 75_000 - 800_000 - 1_000_000);

    // การ์ด Payment Status นับเฉพาะ kind='expense' — income/deduction/reserve ไม่ใช่บิลที่ต้องไปจ่าย
    assert.equal((await getPlan(MONTH_TOTALS)).payment_status.total_count, 1);

    // แม้ผู้ใช้จะ mark paid รายการ reserve แล้วจับคู่กับ txn จริงได้ ยอดรายจ่ายตามแผนก็ต้องไม่ขยับ
    const moneyOutBefore = (
      await db.pool.query<{ n: number }>(
        `select coalesce(sum(amount_satang), 0)::bigint as n from txn where direction = 'debit'`,
      )
    ).rows[0]!.n;
    const reserveDate = `${MONTH_TOTALS}-09`;
    await seedTxn({ date: reserveDate, amount: 1_000_000, direction: 'debit' });
    const reservePaid = await send(`/api/monthly-plan-items/${reserveItemId}/payments`, 'POST', {
      amount_satang: 1_000_000,
      paid_date: reserveDate,
      bank_account_id: accountId,
    });
    assert.equal(((await reservePaid.json()) as { status: string }).status, 'matched');

    const afterTotals = (await getPlan(MONTH_TOTALS)).totals;
    assert.equal(afterTotals.planned_expense_satang, 800_000);
    assert.equal(afterTotals.planned_available_satang, totals.planned_available_satang);
    // ยอดเงินออกจริงขยับเฉพาะเพราะ txn ที่ seed ไว้ ไม่ใช่เพราะ planning เขียนอะไรเพิ่ม
    const moneyOutAfter = (
      await db.pool.query<{ n: number }>(
        `select coalesce(sum(amount_satang), 0)::bigint as n from txn where direction = 'debit'`,
      )
    ).rows[0]!.n;
    assert.equal(moneyOutAfter, moneyOutBefore + 1_000_000);
  });

  await t.test('ปิดเดือนล็อกการแก้ของผู้ใช้ แต่ reconcile ยังจับคู่เข้ามาได้และหน้าจออ่านสถานะสด', async () => {
    // กฎที่ active คลุมเฉพาะเดือนนี้ — ต้องมีของจริงให้ generate ไม่งั้น assert generated_item_count === 0
    // ตอนเดือนปิดจะผ่านฟรีโดยไม่ได้พิสูจน์ §16 ข้อ 16 เลย
    const closingRuleId = ((await (
      await send('/api/recurring-rules', 'POST', {
        name: 'ค่าส่วนกลาง',
        kind: 'expense',
        amount_satang: 300_000,
        frequency_unit: 'month',
        anchor_day: 5,
        start_date: `${MONTH_CLOSING}-01`,
        end_date: `${MONTH_CLOSING}-28`,
      })
    ).json()) as { id: number }).id;

    const opened = await getPlan(MONTH_CLOSING);
    assert.equal(opened.generated_item_count, 1);
    assert.equal(itemNamed(opened, 'ค่าส่วนกลาง').due_date, `${MONTH_CLOSING}-05`);
    const itemId = ((await (
      await send(`/api/monthly-plans/${MONTH_CLOSING}/items`, 'POST', {
        kind: 'expense',
        name: 'ค่าประกัน',
        planned_amount_satang: 250_000,
        due_date: `${MONTH_CLOSING}-25`,
      })
    ).json()) as { id: number }).id;
    await send(`/api/monthly-plan-items/${itemId}/payments`, 'POST', {
      amount_satang: 250_000,
      paid_date: `${MONTH_CLOSING}-25`,
      bank_account_id: accountId,
    });
    const beforeClose = itemNamed(await getPlan(MONTH_CLOSING), 'ค่าประกัน');
    assert.equal(beforeClose.payment_state, 'declared');

    const closed = await send(`/api/monthly-plans/${MONTH_CLOSING}/close`, 'POST', {});
    assert.equal(closed.status, 200);
    const closedPlan = (await closed.json()) as PlanResponse;
    assert.equal(closedPlan.status, 'closed');
    assert.ok(closedPlan.closed_at);
    // ค่าประกัน 250,000 + ค่าส่วนกลางจากกฎ 300,000 (ไม่มีรายได้ในเดือนนี้)
    assert.equal(closedPlan.closed_snapshot?.totals.planned_available_satang, -550_000);

    // §9.6: แก้ได้เฉพาะผ่าน Explicit Reopen
    assert.equal((await send(`/api/monthly-plans/${MONTH_CLOSING}/close`, 'POST', {})).status, 409);
    assert.equal(
      (
        await send(`/api/monthly-plans/${MONTH_CLOSING}/items`, 'POST', {
          kind: 'expense',
          name: 'แทรกทีหลัง',
          planned_amount_satang: 100,
        })
      ).status,
      409,
    );
    assert.equal((await send(`/api/monthly-plan-items/${itemId}`, 'PATCH', { name: 'เปลี่ยนชื่อ' })).status, 409);
    assert.equal((await send(`/api/monthly-plan-items/${itemId}/skip`, 'POST', {})).status, 409);
    assert.equal(
      (
        await send(`/api/monthly-plan-items/${itemId}/payments`, 'POST', {
          amount_satang: 100,
          paid_date: `${MONTH_CLOSING}-26`,
          bank_account_id: accountId,
        })
      ).status,
      409,
    );

    // statement ที่มาช้าต้องจับคู่ payment ในเดือนที่ปิดแล้วได้ (ไม่เปลี่ยนตัวเลขตามแผน)
    await seedTxn({ date: `${MONTH_CLOSING}-26`, amount: 250_000, direction: 'debit' });
    assert.equal(await reconcilePayments(pool, userId), 1);

    const stillClosed = await getPlan(MONTH_CLOSING);
    assert.equal(stillClosed.status, 'closed');
    // อ่านสถานะสด ไม่ใช่จาก closed_snapshot — ถ้าอ่านจาก snapshot การจับคู่นี้จะไม่ปรากฏบนจอเลย
    assert.equal(itemNamed(stillClosed, 'ค่าประกัน').payment_state, 'verified');
    assert.equal(stillClosed.payment_status.verified_count, 1);
    // §16 ข้อ 16: แก้กฎหลังปิดเดือนแล้วห้ามย้อนมาเพิ่มรายการในเดือนที่ปิด
    assert.equal((await send(`/api/recurring-rules/${closingRuleId}`, 'PATCH', { anchor_day: 20 })).status, 200);
    const afterRuleChange = await getPlan(MONTH_CLOSING);
    assert.equal(afterRuleChange.generated_item_count, 0);
    assert.equal(afterRuleChange.items.filter((i) => i.recurring_rule_id === closingRuleId).length, 1);
    assert.equal(itemNamed(afterRuleChange, 'ค่าส่วนกลาง').due_date, `${MONTH_CLOSING}-05`);

    const reopened = await send(`/api/monthly-plans/${MONTH_CLOSING}/reopen`, 'POST', {});
    assert.equal(reopened.status, 200);
    assert.equal(((await reopened.json()) as PlanResponse).status, 'open');
    assert.equal((await send(`/api/monthly-plan-items/${itemId}`, 'PATCH', { name: 'ค่าประกันชีวิต' })).status, 200);
    assert.equal((await send(`/api/monthly-plans/${MONTH_CLOSING}/reopen`, 'POST', {})).status, 404);

    // เปิดเดือนแล้ว gate ปลดจริง: วันที่ 20 ตามกฎที่แก้ไว้เพิ่งเกิดตอนนี้ (พิสูจน์ว่าที่ปิดไว้คือสถานะเดือน
    // ไม่ใช่เพราะไม่มีกฎเหลือ) และของเดิมวันที่ 05 ยังอยู่ ไม่ถูกเขียนทับ
    const afterReopen = await getPlan(MONTH_CLOSING);
    assert.equal(afterReopen.generated_item_count, 1);
    const generated = afterReopen.items.filter((i) => i.recurring_rule_id === closingRuleId);
    assert.deepEqual(generated.map((i) => i.due_date).sort(), [`${MONTH_CLOSING}-05`, `${MONTH_CLOSING}-20`]);
  });

  await t.test('input ที่ใช้ไม่ได้ต้องเป็น 4xx ไม่ใช่ 500', async () => {
    assert.equal((await request('/api/monthly-plans/2026-13')).status, 400);
    assert.equal((await request('/api/monthly-plans/abcd')).status, 400);
    assert.equal((await request(`/api/monthly-plans/${shiftMonth(24)}`)).status, 400);
    // ต้องยิง path ที่มี route จริงถึงจะผ่าน pathId() — GET /monthly-plan-items/:id ไม่มีอยู่
    // express จะคืน 404 default ให้ฟรีโดยไม่ได้ทดสอบอะไร
    assert.equal((await send('/api/monthly-plan-items/abc/skip', 'POST', {})).status, 400);
    assert.equal((await send('/api/monthly-item-payments/abc', 'PATCH', { status: 'cancelled' })).status, 400);
    assert.equal((await send('/api/monthly-plan-items/999999/skip', 'POST', {})).status, 404);
    // จำนวนเงินที่เกิน MAX_SAFE_INTEGER ต้องเป็น 400 ไม่ใช่ 500 จาก Postgres 22P02
    assert.equal(
      (await send(`/api/monthly-plans/${MONTH_RECONCILE}/items`, 'POST', {
        kind: 'expense',
        name: 'ยอดมหาศาล',
        planned_amount_satang: 1e300,
      })).status,
      400,
    );
    assert.equal(
      (await send(`/api/monthly-plans/${MONTH_RECONCILE}/items`, 'POST', { kind: 'ไม่มีจริง', name: 'x', planned_amount_satang: 1 })).status,
      400,
    );
    assert.equal(
      (await send('/api/recurring-rules', 'POST', {
        name: 'ย้อนเวลา',
        kind: 'expense',
        amount_satang: 100,
        frequency_unit: 'month',
        start_date: '2026-05-01',
        end_date: '2026-04-01',
      })).status,
      400,
    );
    // วันที่ผ่าน regex แต่ไม่มีจริง — ต้องได้ 400 ไม่ใช่ 500 จาก Postgres 22008 (out of range)
    // ใช้ ก.พ. ปีที่ไม่ใช่อธิกสุรทินเป็นค่าคงที่ ไม่อ้างเดือนปัจจุบัน (เดือน 31 วันจะทำให้ test นี้หลอน)
    for (const badDate of ['2026-02-29', '2026-02-31', '2026-04-31']) {
      assert.equal(
        (await send('/api/recurring-rules', 'POST', {
          name: `วันที่ไม่มีจริง ${badDate}`,
          kind: 'expense',
          amount_satang: 100,
          frequency_unit: 'month',
          start_date: badDate,
        })).status,
        400,
        `start_date ${badDate} ต้องถูกปฏิเสธ`,
      );
    }
    assert.equal(
      (await send('/api/recurring-rules', 'POST', {
        name: 'วันที่ 32',
        kind: 'expense',
        amount_satang: 100,
        frequency_unit: 'month',
        anchor_day: 32,
        start_date: '2026-05-01',
      })).status,
      400,
    );
  });
  await t.test('Slice 6 income links existing rows, matches net, protects evidence and ownership', async () => {
    await send('/test/login','POST',{userId});
    const month=shiftMonth(8); await getPlan(month);
    const existing=await send(`/api/monthly-plans/${month}/items`,'POST',{kind:'income',name:'Salary',planned_amount_satang:10000});
    const item=(await existing.json()) as {id:number};
    const deduction=await send(`/api/monthly-plans/${month}/items`,'POST',{kind:'payroll_deduction',name:'Tax',planned_amount_satang:1000});
    const deductionItem=(await deduction.json()) as {id:number};
    const before=await txnCount();
    const create=await send('/api/income-records','POST',{month,name:'Salary',gross_amount_satang:10000,monthly_plan_item_id:item.id,bank_account_id:accountId,income_date:`${month}-25`,auto_match:true,deductions:[{deduction_type:'withholding_tax',name:'Tax',amount_satang:1000,monthly_plan_item_id:deductionItem.id}]});
    assert.equal(create.status,201,await create.clone().text());
    const income=await create.json() as {id:number;expected_net_satang:number;match_status:string};
    assert.equal(income.expected_net_satang,9000);assert.equal(income.match_status,'pending');
    assert.equal(await txnCount(),before);
    const plan=await getPlan(month);assert.equal(plan.items.filter(i=>i.id===item.id).length,1);
    assert.equal((await send(`/api/monthly-plan-items/${item.id}`,'PATCH',{planned_amount_satang:1})).status,409);
    assert.equal((await send(`/api/monthly-plan-items/${deductionItem.id}/skip`,'POST',{})).status,409);
    assert.equal((await send(`/api/income-records/${income.id}`,'PATCH',{gross_amount_satang:500})).status,400);
    await send(`/api/monthly-plans/${month}/close`,'POST',{});
    const txnId=await seedTxn({date:`${month}-25`,amount:9000,direction:'credit'});
    const {reconcileIncome}=await import('../src/services/income-records.js');const {tx}=await import('../src/db.js');
    await tx(c=>reconcileIncome(c,userId));
    const list=await (await request(`/api/income-records?month=${month}`)).json() as {rows:{id:number;deposit_txn_id:number;match_status:string}[]};
    assert.equal(list.rows[0]!.deposit_txn_id,txnId);assert.equal(list.rows[0]!.match_status,'matched');
    assert.equal(itemNamed(await getPlan(month),'Salary').payment_state,'verified');
    assert.equal((await send(`/api/income-records/${income.id}/unmatch`,'POST',{})).status,409);
    await send(`/api/monthly-plans/${month}/reopen`,'POST',{});
    assert.equal((await send(`/api/income-records/${income.id}/unmatch`,'POST',{})).status,200);
    await tx(c=>reconcileIncome(c,userId));
    const unmatched=await (await request(`/api/income-records?month=${month}`)).json() as {rows:{auto_match:boolean;deposit_txn_id:null}[]};
    assert.equal(unmatched.rows[0]!.auto_match,false);assert.equal(unmatched.rows[0]!.deposit_txn_id,null);
    const outsider=(await db.pool.query(`insert into app_user(google_sub,email,display_name,is_admin,status) values('slice6-admin','slice6-admin@example.com','Admin',true,'approved') returning id`)).rows[0]!.id;
    await send('/test/login','POST',{userId:outsider});
    assert.equal((await send(`/api/income-records/${income.id}`,'PATCH',{name:'Stolen'})).status,404);
    assert.equal((await request(`/api/income-records/${income.id}/candidates`)).status,404);
    await send('/test/login','POST',{userId});
  });
  await t.test('Slice 6 installment down payment, partial/concurrent/future payments, undo and skipped debt', async () => {
    const month=shiftMonth(9);await getPlan(month);
    const before=await txnCount();
    const created=await send('/api/installment-plans','POST',{name:'Laptop',total_amount_satang:11000,down_payment_satang:1000,interest_satang:0,fee_satang:0,installment_count:3,frequency_unit:'year',frequency_interval:1,first_due_date:`${month}-28`,down_payment_date:`${month}-01`,default_account_id:accountId});
    assert.equal(created.status,201,await created.clone().text());
    const plan=await created.json() as {id:number;dues:{id:number;installment_no:number;amount_satang:number}[];total_payable_satang:number};
    assert.equal(plan.total_payable_satang,11000);assert.deepEqual(plan.dues.map(d=>d.amount_satang),[1000,3333,3333,3334]);
    const first=plan.dues[1]!,future=plan.dues[3]!;
    const paymentBody={amount_satang:2000,paid_date:`${month}-01`,bank_account_id:accountId};
    const payments=await Promise.all([send(`/api/installment-dues/${first.id}/payments`,'POST',paymentBody),send(`/api/installment-dues/${first.id}/payments`,'POST',paymentBody)]);
    assert.deepEqual(payments.map(p=>p.status).sort(),[201,409]);
    const accepted=payments.find(p=>p.status===201)!;const payment=await accepted.json() as {id:number};
    assert.equal((await send(`/api/installment-plans/${plan.id}`,'PATCH',{total_amount_satang:12000})).status,409);
    assert.equal((await send(`/api/installment-dues/${future.id}/payments`,'POST',{...paymentBody,amount_satang:3334})).status,201);
    assert.equal((await send(`/api/installment-dues/${plan.dues[2]!.id}/skip`,'POST',{})).status,200);
    assert.equal((await send(`/api/monthly-item-payments/${payment.id}`,'PATCH',{status:'cancelled'})).status,200);
    const detail=await (await request(`/api/installment-plans/${plan.id}`)).json() as {paid_satang:number;outstanding_satang:number;structural_editable:boolean;dues:{status:string}[]};
    assert.equal(detail.paid_satang,3334);assert.equal(detail.outstanding_satang,7666);assert.equal(detail.structural_editable,false);assert.equal(detail.dues[2]!.status,'skipped');
    assert.equal(await txnCount(),before);
    const generated=(await getPlan(month)).items.filter(i=>i.name.startsWith('Laptop')).length;
    assert.equal((await getPlan(month)).items.filter(i=>i.name.startsWith('Laptop')).length,generated);
    await send(`/api/installment-plans/${plan.id}`,'PATCH',{status:'cancelled'});
    const report=await (await request('/api/installment-plans')).json() as {totals:{outstanding_satang:number}};
    assert.equal(report.totals.outstanding_satang,0);
  });

  await t.test('Slice 6 zero net, duplicate links, ambiguous deposits and excluded transfers', async () => {
    const month=shiftMonth(10);await getPlan(month);
    const body={month,name:'Other income',gross_amount_satang:12345,bank_account_id:accountId,income_date:`${month}-15`,auto_match:true,deductions:[]};
    const zeroRes=await send('/api/income-records','POST',{...body,gross_amount_satang:500,deductions:[{deduction_type:'social_security',name:'Contribution',amount_satang:500}]});
    assert.equal(zeroRes.status,201);
    const zero=await zeroRes.json() as {id:number;match_status:string;monthly_plan_item_id:number;deductions:{monthly_plan_item_id:number}[]};
    assert.equal(zero.match_status,'not_required');
    assert.equal((await getPlan(month)).items.find(i=>i.id===zero.monthly_plan_item_id)!.payment_state,'not_required');
    const duplicate={deduction_type:'other',name:'Duplicate',amount_satang:1,monthly_plan_item_id:zero.deductions[0]!.monthly_plan_item_id};
    assert.equal((await send(`/api/income-records/${zero.id}`,'PATCH',{deductions:[duplicate,duplicate]})).status,400);
    const a=await (await send('/api/income-records','POST',body)).json() as {id:number};
    const b=await (await send('/api/income-records','POST',body)).json() as {id:number};
    const transaction=await seedTxn({date:`${month}-15`,amount:12345,direction:'credit'});
    const {reconcileIncome}=await import('../src/services/income-records.js');const {tx}=await import('../src/db.js');
    await tx(c=>reconcileIncome(c,userId));
    let rows=(await (await request(`/api/income-records?month=${month}`)).json() as {rows:{id:number;match_status:string}[]}).rows;
    assert.equal(rows.find(r=>r.id===a.id)!.match_status,'needs_review');assert.equal(rows.find(r=>r.id===b.id)!.match_status,'needs_review');
    const matches=await Promise.all([send(`/api/income-records/${a.id}/match`,'POST',{txn_id:transaction}),send(`/api/income-records/${b.id}/match`,'POST',{txn_id:transaction})]);
    assert.deepEqual(matches.map(r=>r.status).sort(),[200,409]);
    for(const [index,kind] of ['excluded','internal_transfer','legacy'].entries()) {
      const amount=22345+index;
      const txnId=await seedTxn({date:`${month}-15`,amount,direction:'credit'});
      if(kind==='legacy') await db.pool.query('update txn set is_internal_transfer=true where id=$1',[txnId]);
      else await db.pool.query('insert into txn_annotation(txn_id,classification) values($1,$2)',[txnId,kind]);
      const income=await (await send('/api/income-records','POST',{...body,gross_amount_satang:amount})).json() as {id:number;match_status:string};
      assert.equal(income.match_status,'pending');
      assert.equal((await send(`/api/income-records/${income.id}/match`,'POST',{txn_id:txnId})).status,409);
    }
    const base={name:'Owned schedule',total_amount_satang:900,installment_count:3,frequency_unit:'month',first_due_date:`${month}-20`};
    const installment=await (await send('/api/installment-plans','POST',base)).json() as {id:number;dues:{id:number}[]};
    const foreign=(await db.pool.query(`select id from app_user where google_sub='slice6-admin'`)).rows[0]!.id;
    await send('/test/login','POST',{userId:foreign});
    assert.equal((await request(`/api/installment-plans/${installment.id}`)).status,404);
    assert.equal((await send(`/api/installment-plans/${installment.id}`,'PATCH',{name:'Stolen'})).status,404);
    assert.equal((await send(`/api/installment-dues/${installment.dues[0]!.id}/payments`,'POST',{amount_satang:100,paid_date:`${month}-20`,bank_account_id:accountId})).status,404);
    assert.equal((await send('/api/installment-plans','POST',{...base,default_account_id:accountId})).status,400);
    assert.equal((await send('/api/income-records','POST',body)).status,400);
    await send('/test/login','POST',{userId});
  });

});
