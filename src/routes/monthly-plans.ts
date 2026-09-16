import { Router } from 'express';
import type { Request } from 'express';
import { requireUser } from '../auth.js';
import { pool, query, tx } from '../db.js';
import { enumStr, HttpError, id, isoDate, pathId, satang, str, optionalStr, type Body } from '../http.js';
import { generateMonthlyItems } from '../services/recurring-generation.js';
import { reconcilePayments } from '../services/payment-reconciliation.js';
import { declarePayment, generateInstallmentItems } from '../services/installments.js';
import { audit } from '../services/audit.js';
import {
  assertOwnedRefs,
  ITEM_PAID_SQL,
  loadOwnedItem,
  loadOwnedPlanByMonth,
  paymentStatusSummary,
  PAYMENT_STATE_SQL,
  planTotals,
} from '../services/plan-query.js';
import { MONTH_RE } from '../services/report-query.js';

export const monthlyPlansRouter = Router();

const KINDS = ['income', 'payroll_deduction', 'expense', 'reserve'] as const;
const ITEM_STATUSES = ['active', 'skipped', 'cancelled'] as const;
const COVERAGE_NOTE =
  'ข้อมูลเงินจริงคำนวณจาก Bank Statement ที่นำเข้าสู่ระบบเท่านั้น ไม่รวมเงินสดและ e-Wallet';

// วางแผนล่วงหน้าได้ 12 เดือน — GET สร้างแถว monthly_plan ให้เองแบบ lazy เพราะฉะนั้นถ้าไม่จำกัด
// การยิง /monthly-plans/2999-12 จะสร้างแถวขยะได้ไม่จำกัด
const MAX_MONTHS_AHEAD = 12;

function monthFromPath(req: Request): { month: string; monthStart: string } {
  const month = req.params.month;
  if (typeof month !== 'string' || !MONTH_RE.test(month)) {
    throw new HttpError(400, 'month ต้องเป็นรูปแบบ YYYY-MM');
  }
  return { month, monthStart: `${month}-01` };
}

function previousMonthStart(monthStart: string): string {
  const [y, m] = monthStart.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
}

function monthIndexOf(monthStart: string): number {
  const [y, m] = monthStart.split('-').map(Number) as [number, number];
  return y * 12 + (m - 1);
}

// เดือนปัจจุบันตาม local time ของ process (deploy จริงตั้ง TZ=Asia/Bangkok) เหมือน report-query.ts
function assertWithinHorizon(monthStart: string): void {
  const now = new Date();
  const limit = now.getFullYear() * 12 + now.getMonth() + MAX_MONTHS_AHEAD;
  if (monthIndexOf(monthStart) > limit) {
    throw new HttpError(400, `วางแผนล่วงหน้าได้ไม่เกิน ${MAX_MONTHS_AHEAD} เดือน`);
  }
}

function assertDueDateInMonth(dueDate: string | null, monthStart: string): void {
  if (dueDate == null) return;
  if (dueDate.slice(0, 7) !== monthStart.slice(0, 7)) {
    throw new HttpError(400, 'due_date ต้องอยู่ในเดือนของแผนนี้');
  }
}

// เอา alias `i` (monthly_plan_item) และ `pay` (จาก ITEM_PAID_SQL) ที่ PAYMENT_STATE_SQL ต้องการ
// $1 = monthly_plan_id, $2 = user_id (ใช้ re-join bank_account เป็นด่านที่สองตาม §6.1)
const ITEMS_SQL = `
  select i.id, i.recurring_rule_id, i.installment_due_id, i.income_record_id, i.kind, i.name,
         i.category_id, c.name as category_name,
         i.planned_amount_satang, i.amount_mode, i.due_date, i.explicit_status, i.note,
         pay.paid_satang, pay.matched_satang, pay.needs_review_count,
         ${PAYMENT_STATE_SQL} as payment_state,
         coalesce(pmts.payments, '[]'::json) as payments
  from monthly_plan_item i
  ${ITEM_PAID_SQL}
  left join category c on c.id = i.category_id
  left join lateral (
    select json_agg(json_build_object(
             'id', p2.id,
             'amount_satang', p2.amount_satang,
             'paid_date', p2.paid_date,
             'bank_account_id', p2.bank_account_id,
             'account_nickname', a2.nickname,
             'txn_id', p2.txn_id,
             'status', p2.status,
             'verified_at', p2.verified_at
           ) order by p2.paid_date, p2.id) as payments
    from monthly_item_payment p2
    join bank_account a2 on a2.id = p2.bank_account_id and a2.user_id = $2
    where p2.monthly_plan_item_id = i.id
  ) pmts on true
  where i.monthly_plan_id = $1
  order by case i.kind when 'income' then 1 when 'payroll_deduction' then 2 when 'expense' then 3 else 4 end,
           i.due_date nulls last, i.id`;

/**
 * แผนของเดือนหนึ่ง — สร้างแถวแผนและกางรายการประจำให้เองถ้ายังไม่มี (§11 ไม่มี endpoint generate
 * แยก และ §9.2 บังคับว่าการสร้างรายการประจำต้อง idempotent ซึ่งมีความหมายเมื่อถูกเรียกซ้ำได้เท่านั้น)
 *
 * `on conflict do nothing` แล้ว select ทีหลัง ทำให้สอง request พร้อมกันไม่ชน 23505
 * เดือนที่ปิดแล้วไม่ generate เพิ่ม (§9.6) แต่ยัง**อ่านสถานะสด**เสมอ ไม่ได้อ่านจาก closed_snapshot
 * ไม่งั้น statement ที่มาช้าแล้วจับคู่ payment สำเร็จจะไม่ปรากฏบนจอ
 */
monthlyPlansRouter.get('/monthly-plans/:month', requireUser(async (req, res, user) => {
  const { month, monthStart } = monthFromPath(req);
  assertWithinHorizon(monthStart);

  const body = await tx(async (c) => {
    await c.query(
      `insert into monthly_plan (user_id, month_start) values ($1, $2)
       on conflict (user_id, month_start) do nothing`,
      [user.id, monthStart],
    );
    const plan = (
      await c.query<{
        id: number;
        month_start: string;
        status: 'open' | 'closed';
        closed_at: string | null;
        closed_snapshot: unknown;
      }>(
        'select id, month_start, status, closed_at, closed_snapshot from monthly_plan where user_id = $1 and month_start = $2 for update',
        [user.id, monthStart],
      )
    ).rows[0]!;

    const generated = plan.status === 'open' ? await generateMonthlyItems(c, user.id, plan.id, monthStart) : 0;
    if (plan.status === 'open') await generateInstallmentItems(c, user.id, plan.id);

    const [totals, paymentStatus, items] = await Promise.all([
      planTotals(c, plan.id),
      paymentStatusSummary(c, plan.id),
      c.query(ITEMS_SQL, [plan.id, user.id]).then((r) => r.rows),
    ]);

    return {
      month,
      month_start: plan.month_start,
      status: plan.status,
      closed_at: plan.closed_at,
      // เก็บไว้เพื่อ audit ว่าตอนปิดเดือนตัวเลขเป็นเท่าไร — ไม่ใช่ค่าที่หน้าจอใช้แสดง
      closed_snapshot: plan.closed_snapshot,
      generated_item_count: generated,
      totals,
      payment_status: paymentStatus,
      items,
      data_coverage_note: COVERAGE_NOTE,
    };
  });

  res.json(body);
}));

// รายการเฉพาะเดือน (§9.3) — recurring_rule_id เป็น null จึงไม่ถูก generateMonthlyItems แตะ
monthlyPlansRouter.post('/monthly-plans/:month/items', requireUser(async (req, res, user) => {
  const { monthStart } = monthFromPath(req);
  const b = req.body as Body;
  const plan = await loadOwnedPlanByMonth(pool, user.id, monthStart, { requireOpen: true });

  const dueDate = b.due_date == null || b.due_date === '' ? null : isoDate(b, 'due_date');
  assertDueDateInMonth(dueDate, monthStart);
  const categoryId = b.category_id == null || b.category_id === '' ? null : id(b, 'category_id');
  await assertOwnedRefs(pool, user.id, { categoryId });

  const created = await tx(async (c) => {
    const { rows } = await c.query(
      `insert into monthly_plan_item
         (monthly_plan_id, kind, name, category_id, planned_amount_satang, due_date, note)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning *`,
      [
        plan.id,
        enumStr(b, 'kind', KINDS),
        str(b, 'name', 120),
        categoryId,
        satang(b, 'planned_amount_satang'),
        dueDate,
        optionalStr(b, 'note', 500),
      ],
    );
    const after = rows[0];
    await audit(c, { userId: user.id, action: 'monthly_plan_item.create', entityType: 'monthly_plan_item', entityId: after.id, after, ip: req.ip ?? null });
    return after;
  });
  res.status(201).json(created);
}));

/**
 * Copy จากเดือนก่อน (§9.3) — copy เฉพาะรายการเฉพาะเดือนที่ยัง active
 * รายการที่มาจาก recurring_rule เกิดเองอยู่แล้วตอน GET จึงไม่ต้อง copy (จะกลายเป็นแถวซ้ำทันที)
 *
 * unique index กัน generate ซ้ำครอบแค่ `where recurring_rule_id is not null` — one-off ที่ copy มา
 * ไม่ถูกคุม ถ้าไม่ guard เอง กดสองครั้งได้ทั้งเดือนซ้ำ
 * ponytail: กันซ้ำด้วย (kind, name) เท่านั้น ผลข้างเคียงที่ยอมรับคือถ้าเดือนก่อนมีสองรายการชื่อเดียวกัน
 * (เช่น "ค่าน้ำ" สองหลัง) จะ copy มาแค่ใบเดียว — ผู้ใช้เพิ่มอีกใบเองได้ ถ้าเจอบ่อยค่อยเทียบ due_date ด้วย
 */
monthlyPlansRouter.post('/monthly-plans/:month/copy-previous', requireUser(async (req, res, user) => {
  const { monthStart } = monthFromPath(req);
  const plan = await loadOwnedPlanByMonth(pool, user.id, monthStart, { requireOpen: true });
  const prev = previousMonthStart(monthStart);

  const { rows } = await query<{ id: number }>(
    `insert into monthly_plan_item
       (monthly_plan_id, kind, name, category_id, planned_amount_satang, due_date, note)
     select $1, s.kind, s.name, s.category_id, s.planned_amount_satang,
            case when s.due_date is null then null
                 else $2::date + (least(
                        extract(day from s.due_date)::int,
                        extract(day from ($2::date + interval '1 month' - interval '1 day'))::int
                      ) - 1)
            end,
            s.note
     from monthly_plan_item s
     join monthly_plan sp on sp.id = s.monthly_plan_id
     where sp.user_id = $3
       and sp.month_start = $4
       and s.explicit_status = 'active'
       and s.recurring_rule_id is null
       and s.income_record_id is null
       and s.installment_due_id is null
       and not exists (
         select 1 from monthly_plan_item t
         where t.monthly_plan_id = $1 and t.kind = s.kind and t.name = s.name
       )
     returning id`,
    [plan.id, monthStart, user.id, prev],
  );
  res.status(201).json({ copied_count: rows.length, from_month_start: prev });
}));

// แก้เฉพาะเดือนนี้ (§9.2) — แก้ที่ item ไม่แตะ recurring_rule กฎยังใช้ค่าเดิมกับเดือนถัดไป
// category_id / due_date / note เป็น nullable จึงใช้ท่า hasOwnProperty แบบ routes/accounts.ts
monthlyPlansRouter.patch('/monthly-plan-items/:id', requireUser(async (req, res, user) => {
  const itemId = pathId(req);
  const b = req.body as Body;
  const has = (field: string) => Object.prototype.hasOwnProperty.call(b, field);

  const updated = await tx(async (c) => {
    const item = await loadOwnedItem(c, user.id, itemId, { requireOpen: true });
    if (item.income_record_id != null || item.installment_due_id != null) throw new HttpError(409, 'แก้รายการนี้ผ่านหน้ารายได้หรือแผนผ่อน');
    const monthStart = (
      await c.query<{ month_start: string }>('select month_start from monthly_plan where id = $1', [
        item.monthly_plan_id,
      ])
    ).rows[0]!.month_start;

    const dueDate = b.due_date == null || b.due_date === '' ? null : isoDate(b, 'due_date');
    assertDueDateInMonth(dueDate, monthStart);
    const categoryId = b.category_id == null || b.category_id === '' ? null : id(b, 'category_id');
    await assertOwnedRefs(c, user.id, { categoryId });

    const { rows } = await c.query(
      `update monthly_plan_item set
         name = coalesce($2, name),
         planned_amount_satang = coalesce($3, planned_amount_satang),
         explicit_status = coalesce($4, explicit_status),
         category_id = case when $5 then $6 else category_id end,
         due_date = case when $7 then $8 else due_date end,
         note = case when $9 then $10 else note end,
         updated_at = now()
       where id = $1
       returning *`,
      [
        itemId,
        b.name == null ? null : str(b, 'name', 120),
        b.planned_amount_satang == null ? null : satang(b, 'planned_amount_satang'),
        b.explicit_status == null ? null : enumStr(b, 'explicit_status', ITEM_STATUSES),
        has('category_id'),
        categoryId,
        has('due_date'),
        dueDate,
        has('note'),
        has('note') ? optionalStr(b, 'note', 500) : null,
      ],
    );
    const after = rows[0];
    await audit(c, { userId: user.id, action: 'monthly_plan_item.update', entityType: 'monthly_plan_item', entityId: itemId, before: item, after, ip: req.ip ?? null });
    return after;
  });
  res.json(updated);
}));

/**
 * ลบทิ้งจริง (§9.3) — ต่างจาก `skip` ที่เก็บแถวไว้เป็นประวัติแต่ไม่นับยอด ใช้เก็บกวาดแถวที่ไม่ควรมี
 * ตั้งแต่แรก เช่น รายการค้างจากการแก้ `anchor_day` ของกฎ ซึ่งเดิมผู้ใช้เอาออกจากหน้าจอไม่ได้เลย
 *
 * generateMonthlyItems ข้ามกฎที่มีแถวอยู่ในเดือนนั้นแล้ว ลบแถวเดียวจึงไม่ถูก insert กลับมา
 * ลบของกฎเดียวกันออก**หมดทั้งเดือน**ต่างหากที่จะกางใหม่ตามกฎปัจจุบันตอน GET รอบถัดไป
 * ซึ่งเป็นท่าที่ตั้งใจให้ใช้ "รีเซ็ตเดือนนี้ให้ตรงกับกฎที่เพิ่งแก้"
 *
 * monthly_item_payment ผูก `on delete cascade` — มีประกาศจ่ายที่ยังไม่ยกเลิกห้ามลบ ไม่งั้นประวัติ
 * การจ่ายและการจับคู่ statement หายเงียบ ๆ ให้ยกเลิกการจ่ายก่อน หรือใช้ `skip` แทน
 */
monthlyPlansRouter.delete('/monthly-plan-items/:id', requireUser(async (req, res, user) => {
  const itemId = pathId(req);
  await tx(async (c) => {
    const item = await loadOwnedItem(c, user.id, itemId, { requireOpen: true });
    if (item.income_record_id != null || item.installment_due_id != null) throw new HttpError(409, 'จัดการรายการนี้ผ่านหน้ารายได้หรือแผนผ่อน');
    const { rows: pay } = await c.query<{ n: string }>(
      `select count(*) as n from monthly_item_payment where monthly_plan_item_id = $1 and status <> 'cancelled'`,
      [itemId],
    );
    if (Number(pay[0]!.n) > 0) throw new HttpError(409, 'รายการนี้มีการประกาศจ่ายอยู่ ยกเลิกการจ่ายก่อน หรือใช้ "ข้าม" แทน');
    const before = (await c.query('delete from monthly_plan_item where id = $1 returning *', [itemId])).rows[0];
    await audit(c, { userId: user.id, action: 'monthly_plan_item.delete', entityType: 'monthly_plan_item', entityId: itemId, before, ip: req.ip ?? null });
  });
  res.status(204).end();
}));

// skip โดยไม่ลบประวัติ (§9.3) — เก็บแถวไว้ให้เห็นว่าเดือนนี้ตั้งใจไม่จ่าย ต่างจาก DELETE ด้านบนที่เอาออกเลย
monthlyPlansRouter.post('/monthly-plan-items/:id/skip', requireUser(async (req, res, user) => {
  const itemId = pathId(req);
  const updated = await tx(async (c) => {
    const item = await loadOwnedItem(c, user.id, itemId, { requireOpen: true });
    if (item.income_record_id != null || item.installment_due_id != null) throw new HttpError(409, 'จัดการรายการนี้ผ่านหน้ารายได้หรือแผนผ่อน');
    const { rows } = await c.query(
      `update monthly_plan_item set explicit_status = 'skipped', updated_at = now() where id = $1 returning *`,
      [itemId],
    );
    const after = rows[0];
    await audit(c, { userId: user.id, action: 'monthly_plan_item.skip', entityType: 'monthly_plan_item', entityId: itemId, before: item, after, ip: req.ip ?? null });
    return after;
  });
  res.json(updated);
}));

/**
 * Mark paid (§9.5) — **ไม่สร้างหรือแก้ `txn` ใด ๆ** (§3 ข้อ 5, §5.2, ADR-0002 ข้อ 3)
 * สร้างแถว Payment Declaration สถานะ `declared` แล้วพยายามจับคู่กับ statement ที่นำเข้ามาแล้วทันที
 *
 * เรียก reconcile ที่นี่ด้วย ไม่ใช่แค่ตอน worker sync: เคสที่พบบ่อยคือ statement เข้ามาก่อนแล้วผู้ใช้
 * เพิ่ง mark paid ตามหลัง ถ้ารอ sync รอบใหม่ payment จะค้าง declared ทั้งที่คู่ที่ตรงกันมีอยู่ในฐานแล้ว
 * reconcile ล้มไม่ควรทำให้การประกาศจ่ายล้ม — แถวถูกบันทึกแล้ว จับคู่รอบหน้าได้
 *
 * จ่ายบางส่วนคือการมีหลายแถว ไม่มีสถานะ partial เก็บในตาราง (คำนวณจากผลรวมตอนอ่าน — §7.2)
 */
monthlyPlansRouter.post('/monthly-plan-items/:id/payments', requireUser(async (req, res, user) => {
  const itemId = pathId(req);
  const b = req.body as Body;
  const inserted = await tx(async (c) => {
    const row = await declarePayment(c, user.id, itemId, b);
    await audit(c, { userId: user.id, action: 'monthly_item_payment.declare', entityType: 'monthly_item_payment', entityId: row.id, after: row, ip: req.ip ?? null });
    return row;
  });

  try {
    await reconcilePayments(pool, user.id);
  } catch (e) {
    console.error(`[planning] reconcilePayments user=${user.id} ล้มเหลว:`, e);
  }

  const { rows } = await query('select * from monthly_item_payment where id = $1', [inserted.id]);
  res.status(201).json(rows[0]);
}));

/**
 * ปิดวง `needs_review` (§9.5 — auto-match ทำได้เฉพาะเมื่อมี candidate เดียว)
 *
 * ส่ง `txn_id` = ยืนยันคู่ด้วยมือ อนุญาตแม้เดือนปิดแล้ว เพราะเป็นการ reconcile ให้เสร็จ ไม่ได้เปลี่ยน
 * ตัวเลขตามแผน ส่ง `status: 'cancelled'` = ยกเลิกการประกาศจ่าย ซึ่งเปลี่ยนยอดจ่าย จึงต้องเปิดเดือนก่อน
 */
monthlyPlansRouter.patch('/monthly-item-payments/:id', requireUser(async (req, res, user) => {
  const paymentId = pathId(req);
  const b = req.body as Body;
  const cancelling = b.status != null;
  if (cancelling && enumStr(b, 'status', ['cancelled'] as const) !== 'cancelled') {
    throw new HttpError(400, 'status ตั้งได้เฉพาะ cancelled');
  }
  const txnId = b.txn_id == null || b.txn_id === '' ? null : id(b, 'txn_id');
  if (cancelling === (txnId != null)) throw new HttpError(400, 'ต้องส่ง txn_id หรือ status อย่างใดอย่างหนึ่ง');

  const updated = await tx(async (c) => {
    const owned = await c.query<{
      monthly_plan_item_id: number;
      bank_account_id: number;
      status: string;
      amount_satang: number;
      kind: string;
      income_record_id: number | null;
    }>(
      `select p.monthly_plan_item_id, p.bank_account_id, p.status, p.amount_satang, i.kind, i.income_record_id
       from monthly_item_payment p
       join monthly_plan_item i on i.id = p.monthly_plan_item_id
       join monthly_plan mp on mp.id = i.monthly_plan_id
       where p.id = $1 and mp.user_id = $2
       for update of p`,
      [paymentId, user.id],
    );
    const payment = owned.rows[0];
    if (!payment) throw new HttpError(404, 'ไม่พบรายการจ่าย');
    if (payment.income_record_id != null) throw new HttpError(409, 'จัดการคู่เงินเข้าผ่านรายได้');
    if (!cancelling && payment.status === 'cancelled') throw new HttpError(409, 'รายการจ่ายถูกยกเลิกแล้ว');

    if (cancelling) {
      await loadOwnedItem(c, user.id, payment.monthly_plan_item_id, { requireOpen: true });
      const { rows } = await c.query(
        `update monthly_item_payment set status = 'cancelled', txn_id = null, verified_at = null
         where id = $1 returning *`,
        [paymentId],
      );
      const after = rows[0];
      await audit(c, { userId: user.id, action: 'monthly_item_payment.cancel', entityType: 'monthly_item_payment', entityId: paymentId, before: payment, after, ip: req.ip ?? null });
      return after;
    }

    if (payment.status === 'matched') throw new HttpError(409, 'รายการจ่ายนี้จับคู่ไว้แล้ว');

    // ต้องตรวจเกณฑ์ §9.5 ข้อ 1–3 ให้ครบเหมือน auto-match ไม่ใช่แค่ "เป็นบัญชีของ user"
    // ยอดใน matched_satang นับจากยอดของ payment ไม่ใช่ของ txn — ถ้าไม่บังคับให้ยอดตรงกัน
    // ผู้ใช้ผูก payment 100,000 บาทกับ txn 10 บาทได้ แล้วรายการจะขึ้นว่า "ยืนยันจาก statement แล้ว"
    // ไม่บังคับกรอบ ±3 วัน (เกณฑ์ข้อ 4) เพราะขั้นตอนนี้คือให้คนตัดสินสิ่งที่ระบบตัดสินไม่ได้
    // — วันที่คลาดกันได้จริงเวลาธนาคารลงรายการช้า แต่ยอดกับทิศทางเป็นข้อเท็จจริงที่ต่อรองไม่ได้
    const txn = await c.query(
      `select 1 from txn t
       join bank_account a on a.id = t.bank_account_id and a.user_id = $2
       where t.id = $1
         and t.bank_account_id = $3
         and t.amount_satang = $4
         and t.direction = $5`,
      [
        txnId,
        user.id,
        payment.bank_account_id,
        payment.amount_satang,
        payment.kind === 'income' ? 'credit' : 'debit',
      ],
    );
    if (!txn.rowCount) {
      throw new HttpError(400, 'ธุรกรรมนี้ไม่ใช่ของคุณ อยู่คนละบัญชี ยอดไม่ตรง หรือทิศทางเงินไม่ตรงกับรายการ');
    }

    const { rows } = await c.query(
      `update monthly_item_payment set status = 'matched', txn_id = $2, verified_at = now()
       where id = $1 returning *`,
      [paymentId, txnId],
    );
    const after = rows[0];
    await audit(c, { userId: user.id, action: 'monthly_item_payment.confirm', entityType: 'monthly_item_payment', entityId: paymentId, before: payment, after, ip: req.ip ?? null });
    return after;
  });
  res.json(updated);
}));

// ปิดเดือน (§9.6) — เก็บ snapshot ตอนปิดไว้เพื่อ audit แล้วล็อกการแก้ของผู้ใช้
// reconcile ยังเข้ามาจับคู่ payment ในเดือนนี้ได้ (ไม่เปลี่ยนตัวเลขตามแผน) หน้าจอจึงต้องอ่านสถานะสด
monthlyPlansRouter.post('/monthly-plans/:month/close', requireUser(async (req, res, user) => {
  const { monthStart } = monthFromPath(req);
  const closed = await tx(async (c) => {
    const plan = await loadOwnedPlanByMonth(c, user.id, monthStart, { requireOpen: true });
    const snapshot = {
      totals: await planTotals(c, plan.id),
      payment_status: await paymentStatusSummary(c, plan.id),
    };
    const { rows } = await c.query(
      `update monthly_plan set status = 'closed', closed_at = now(), closed_snapshot = $2
       where id = $1 returning id, month_start, status, closed_at, closed_snapshot`,
      [plan.id, JSON.stringify(snapshot)],
    );
    const after = rows[0];
    await audit(c, { userId: user.id, action: 'monthly_plan.close', entityType: 'monthly_plan', entityId: plan.id, before: plan, after, ip: req.ip ?? null });
    return after;
  });
  res.json(closed);
}));

// Explicit Reopen (§9.6) — เก็บ closed_snapshot ครั้งล่าสุดไว้ ไม่ล้าง เพื่อให้ยังตรวจย้อนได้ว่า
// ตอนปิดครั้งก่อนตัวเลขเป็นเท่าไร ปิดอีกครั้งจะเขียนทับ
monthlyPlansRouter.post('/monthly-plans/:month/reopen', requireUser(async (req, res, user) => {
  const { monthStart } = monthFromPath(req);
  const reopened = await tx(async (c) => {
    const { rows } = await c.query(
      `update monthly_plan set status = 'open', closed_at = null
       where user_id = $1 and month_start = $2 and status = 'closed'
       returning id, month_start, status, closed_at, closed_snapshot`,
      [user.id, monthStart],
    );
    const after = rows[0];
    if (!after) throw new HttpError(404, 'ไม่พบเดือนที่ปิดอยู่');
    await audit(c, { userId: user.id, action: 'monthly_plan.reopen', entityType: 'monthly_plan', entityId: after.id, after, ip: req.ip ?? null });
    return after;
  });
  res.json(reopened);
}));
