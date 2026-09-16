import type { Pool, PoolClient } from 'pg';
import { HttpError } from '../http.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;

// SQL fragment ที่ใช้ร่วมกันทั้งหน้าแผนและการ์ด Dashboard แบบเดียวกับ report-query.ts —
// ห้ามให้สองที่คำนวณสถานะการจ่ายเองแยกกัน ไม่งั้นเกิด drift ซ้ำรอย classification='excluded'
// ที่ docs/status.md บันทึกไว้ (การ์ดกับตารางให้ตัวเลขไม่ตรงกัน)

/**
 * ยอดจ่ายต่อ item — ผู้เรียกต้องมี `monthly_plan_item i` อยู่ใน FROM แล้ว และได้ alias `pay` กลับไป
 *
 * `paid_satang` = ยอดที่ผู้ใช้ประกาศว่าจ่ายแล้ว นับ declared + matched + **needs_review** ด้วย:
 * needs_review หมายถึงระบบเจอ txn เข้าเกณฑ์หลายรายการจึงไม่เดาให้ ไม่ได้หมายความว่าผู้ใช้ไม่ได้จ่าย
 * ถ้าไม่นับ รายการที่เพิ่ง mark paid แล้วเจอคู่กำกวมจะเด้งกลับเป็น "ยังไม่จ่าย/เกินกำหนด" ทันที
 * ซึ่งขัดกับสิ่งที่ผู้ใช้เพิ่งบันทึก มีแต่ `cancelled` ที่ไม่นับ (ยกเลิกไปแล้ว)
 * `matched_satang` นับเฉพาะ matched — เป็นตัวแยก "จ่ายแล้ว รอ statement" ออกจาก "ยืนยันแล้ว" (§17)
 */
export const ITEM_PAID_SQL = `
  left join lateral (
    select coalesce(sum(pm.amount_satang) filter (where pm.status <> 'cancelled'), 0)::bigint as paid_satang,
           coalesce(sum(pm.amount_satang) filter (where pm.status = 'matched'), 0)::bigint as matched_satang,
           count(*) filter (where pm.status = 'needs_review')::int as needs_review_count
    from monthly_item_payment pm
    where pm.monthly_plan_item_id = i.id
  ) pay on true`;

/**
 * สถานะการจ่ายที่ derive สดทุกครั้ง ไม่เก็บซ้ำในตาราง (§7.2) ให้ 6 ถังตาม §8.2
 * ต้องใช้คู่กับ ITEM_PAID_SQL (alias `i` และ `pay`)
 *
 * ใช้ current_date ฝั่ง SQL ไม่ใช่ JS และ `due_date` เป็น nullable (รายการเฉพาะเดือนส่วนใหญ่ไม่กรอก) —
 * `due_date < current_date` ให้ NULL ไม่ใช่ false เพราะฉะนั้นต้องเช็ค `is not null` ก่อน ไม่งั้น
 * CASE จะตกทั้งสาขาแล้วคืน NULL ออกไปเป็นสถานะ
 *
 * สาขา verified ของยอดคงที่ต้องมี `matched_satang > 0` ด้วย ไม่ใช่แค่ `>= planned`: รายการยอด 0 บาท
 * ที่ไม่ได้ตั้งเป็นยอดประมาณการ จะเข้าเงื่อนไข `0 >= 0` แล้วขึ้นว่า "ยืนยันจาก statement แล้ว" ทั้งที่
 * ไม่มี txn ผูกอยู่เลย ขัด §16 ข้อ 6 (ยอดประมาณการออกทางสาขาของตัวเองก่อนถึงบรรทัดนั้นไปแล้ว)
 *
 * ยอดประมาณการ (`amount_mode` ที่ copy ลง item ตอนกาง — migration 011) **ไม่มีสถานะ partial**:
 * ยอดตามแผนเป็นการเดา บิลจริงสูงหรือต่ำกว่าก็ได้ ถ้าเทียบ `paid < planned` ตามปกติ เดือนที่บิลมาน้อย
 * กว่าที่เดาไว้จะค้าง "จ่ายบางส่วน" ตลอดโดยผู้ใช้แก้ให้หายไม่ได้ ทั้งที่บิลปิดและจับคู่ statement แล้ว
 * ส่วนต่างไปแสดงบนหน้าจอโดยคิดสดจาก `paid_satang − planned_amount_satang` ไม่เก็บซ้ำ (§7.2)
 *
 * เงื่อนไข verified ของยอดประมาณการคือ `matched = paid` ไม่ใช่ `matched > 0` — ประกาศจ่ายหลายแถวแล้ว
 * จับคู่ได้บางแถวต้องยังเป็น "จ่ายแล้ว รอ statement" ตาม §16 ข้อ 6 (เทียบเท่า `matched >= planned`
 * ของยอดคงที่) `matched` เป็น subset ของ `paid` จึงเทียบเท่า `>=` และ `paid > 0` การันตีมาจากสาขาก่อนแล้ว
 */
export const PAYMENT_STATE_SQL = `
  case
    when i.explicit_status <> 'active' then i.explicit_status
    when i.kind = 'payroll_deduction' and i.income_record_id is not null then 'deducted'
    when i.kind = 'income' and i.income_record_id is not null and
      (select r.expected_net_satang from income_record r where r.id=i.income_record_id)=0 then 'not_required'
    when i.kind = 'income' and i.income_record_id is not null and pay.matched_satang >=
      (select r.expected_net_satang from income_record r where r.id=i.income_record_id) then 'verified'
    when pay.paid_satang = 0 and i.due_date is not null and i.due_date < current_date then 'overdue'
    when pay.paid_satang = 0 then 'unpaid'
    when i.amount_mode = 'estimated' and pay.matched_satang = pay.paid_satang then 'verified'
    when i.amount_mode = 'estimated' then 'declared'
    when pay.paid_satang < i.planned_amount_satang then 'partial'
    when pay.matched_satang > 0 and pay.matched_satang >= i.planned_amount_satang then 'verified'
    else 'declared'
  end`;

export type PlanTotals = {
  planned_income_satang: number;
  planned_deduction_satang: number;
  planned_expense_satang: number;
  planned_reserve_satang: number;
  planned_available_satang: number;
};

/**
 * สูตร §8.2: เงินเหลือใช้ตามแผน = รายได้เต็ม − รายการหักจากรายได้ − รายจ่ายตามแผน − เงินกันไว้
 *
 * เงินกันไว้ (reserve) ลดเงินเหลือใช้แต่ **ไม่เข้า planned_expense_satang** (§9.4, §16 ข้อ 4)
 * นับเฉพาะ explicit_status='active' — รายการที่ skip/cancel ไว้ไม่อยู่ในแผนแล้วแต่ยังเก็บประวัติไว้
 */
export async function planTotals(db: Queryable, planId: number): Promise<PlanTotals> {
  const { rows } = await db.query<PlanTotals>(
    `select
       coalesce(sum(planned_amount_satang) filter (where kind = 'income'), 0)::bigint as planned_income_satang,
       coalesce(sum(planned_amount_satang) filter (where kind = 'payroll_deduction'), 0)::bigint as planned_deduction_satang,
       coalesce(sum(planned_amount_satang) filter (where kind = 'expense'), 0)::bigint as planned_expense_satang,
       coalesce(sum(planned_amount_satang) filter (where kind = 'reserve'), 0)::bigint as planned_reserve_satang,
       coalesce(sum(planned_amount_satang) filter (where kind = 'income'), 0)::bigint
         - coalesce(sum(planned_amount_satang) filter (where kind = 'payroll_deduction'), 0)::bigint
         - coalesce(sum(planned_amount_satang) filter (where kind = 'expense'), 0)::bigint
         - coalesce(sum(planned_amount_satang) filter (where kind = 'reserve'), 0)::bigint
         as planned_available_satang
     from monthly_plan_item
     where monthly_plan_id = $1 and explicit_status = 'active'`,
    [planId],
  );
  return rows[0]!;
}

export type PaymentStatusSummary = {
  total_count: number;
  total_due_satang: number;
  paid_satang: number;
  unpaid_count: number;
  overdue_count: number;
  partial_count: number;
  declared_count: number;
  verified_count: number;
  needs_review_count: number;
};

/**
 * การ์ด Payment Status (§8.2) — นับเฉพาะ kind='expense' เพราะเป็น "รายการที่ต้องจ่าย" จริง ๆ
 * income คือเงินเข้า, payroll_deduction ถูกหักที่ต้นทาง, reserve เป็นการกันงบที่ไม่เคลื่อนเงิน (§9.4)
 * ทั้งสามไม่ใช่บิลที่ผู้ใช้ต้องไปจ่าย (สถานะรายตัวยังคำนวณให้ทุก kind ในรายการ item)
 */
export async function paymentStatusSummary(db: Queryable, planId: number): Promise<PaymentStatusSummary> {
  const { rows } = await db.query<PaymentStatusSummary>(
    `select
       count(*)::int as total_count,
       coalesce(sum(i.planned_amount_satang), 0)::bigint as total_due_satang,
       coalesce(sum(pay.paid_satang), 0)::bigint as paid_satang,
       count(*) filter (where state = 'unpaid')::int as unpaid_count,
       count(*) filter (where state = 'overdue')::int as overdue_count,
       count(*) filter (where state = 'partial')::int as partial_count,
       count(*) filter (where state = 'declared')::int as declared_count,
       count(*) filter (where state = 'verified')::int as verified_count,
       coalesce(sum(pay.needs_review_count), 0)::int as needs_review_count
     from monthly_plan_item i
     ${ITEM_PAID_SQL}
     cross join lateral (select ${PAYMENT_STATE_SQL} as state) s
     where i.monthly_plan_id = $1 and i.explicit_status = 'active' and i.kind = 'expense'`,
    [planId],
  );
  return rows[0]!;
}

export type OwnedPlan = { id: number; month_start: string; status: 'open' | 'closed' };

export type OwnedItem = {
  id: number;
  income_record_id: number | null;
  installment_due_id: number | null;
  monthly_plan_id: number;
  kind: 'income' | 'payroll_deduction' | 'expense' | 'reserve';
  planned_amount_satang: number;
  plan_status: 'open' | 'closed';
};

const CLOSED_MONTH_ERROR = 'เดือนนี้ปิดแล้ว ต้องเปิดเดือนก่อนจึงแก้ได้';

/**
 * ด่าน ownership + ด่านเดือนปิด ที่ทุก route ใช้ตัวเดียวกัน
 *
 * `monthly_plan_item` ไม่มี `user_id` ของตัวเอง (ตาม §7.2) จึงต้อง join ขึ้นไปถึง `monthly_plan.user_id`
 * ทุกครั้งตามกติกาใน docs/plans/phases/README.md — ไม่พบ = 404 ไม่ใช่ 403 ตาม idiom ที่ใช้อยู่
 * `requireOpen` รวมไว้ที่นี่เพราะ 5 route ต้องใช้ ถ้าให้แต่ละ route เช็คเองจะมีอันลืม (§9.6)
 */
export async function loadOwnedItem(
  db: Queryable,
  userId: number,
  itemId: number,
  opts: { requireOpen?: boolean } = {},
): Promise<OwnedItem> {
  const { rows } = await db.query<OwnedItem>(
    `select i.id, i.income_record_id, i.installment_due_id, i.monthly_plan_id, i.kind, i.planned_amount_satang, p.status as plan_status
     from monthly_plan_item i
     join monthly_plan p on p.id = i.monthly_plan_id
     where i.id = $1 and p.user_id = $2${opts.requireOpen ? ' for update of p, i' : ''}`,
    [itemId, userId],
  );
  const item = rows[0];
  if (!item) throw new HttpError(404, 'ไม่พบรายการในแผน');
  if (opts.requireOpen && item.plan_status !== 'open') throw new HttpError(409, CLOSED_MONTH_ERROR);
  return item;
}

export async function loadOwnedPlanByMonth(
  db: Queryable,
  userId: number,
  monthStart: string,
  opts: { requireOpen?: boolean } = {},
): Promise<OwnedPlan> {
  const { rows } = await db.query<OwnedPlan>(
    `select id, month_start, status from monthly_plan where user_id = $1 and month_start = $2${opts.requireOpen ? ' for update' : ''}`,
    [userId, monthStart],
  );
  const plan = rows[0];
  if (!plan) throw new HttpError(404, 'ยังไม่มีแผนของเดือนนี้');
  if (opts.requireOpen && plan.status !== 'open') throw new HttpError(409, CLOSED_MONTH_ERROR);
  return plan;
}

/**
 * ตรวจว่า bank_account / category ที่อ้างถึงเป็นของ user จริง — ไม่เช็คแล้วเป็น IDOR ตรง ๆ
 * (ผูกรายการในแผนของตัวเองไปยังบัญชีของคนอื่นได้) หมวดระบบ (user_id is null) ใช้ร่วมกันได้ทุกคน
 * ตามกฎเดิมใน routes/categories.ts และบัญชีที่ archive แล้วอ้างใหม่ไม่ได้
 */
export async function assertOwnedRefs(
  db: Queryable,
  userId: number,
  refs: { bankAccountId?: number | null; categoryId?: number | null },
): Promise<void> {
  if (refs.bankAccountId != null) {
    const owns = await db.query(
      'select 1 from bank_account where id = $1 and user_id = $2 and archived_at is null',
      [refs.bankAccountId, userId],
    );
    if (!owns.rowCount) throw new HttpError(400, 'บัญชีธนาคารนี้ไม่มีอยู่จริงหรือไม่ใช่ของคุณ');
  }
  if (refs.categoryId != null) {
    const owns = await db.query('select 1 from category where id = $1 and (user_id is null or user_id = $2)', [
      refs.categoryId,
      userId,
    ]);
    if (!owns.rowCount) throw new HttpError(400, 'หมวดนี้ไม่มีอยู่จริงหรือไม่ใช่ของคุณ');
  }
}
