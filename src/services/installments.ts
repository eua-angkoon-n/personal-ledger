import type { Pool, PoolClient } from "pg";
import {
  HttpError,
  enumStr,
  id,
  satang,
  str,
  isoDate,
  type Body,
} from "../http.js";
import { assertOwnedRefs, loadOwnedItem } from "./plan-query.js";
import {
  installmentSchedule,
  type InstallmentInput,
} from "./income-installment-math.js";
type DB = Pick<Pool | PoolClient, "query">;

export async function generateInstallmentItems(
  db: DB,
  userId: number,
  monthPlanId?: number,
) {
  const result = await db.query(
    `insert into monthly_plan_item(monthly_plan_id,installment_due_id,kind,name,category_id,planned_amount_satang,due_date,explicit_status)
    select mp.id,d.id,'expense',p.name || case when d.installment_no=0 then ' · เงินดาวน์' else ' · งวด ' || d.installment_no end,p.category_id,d.amount_satang,d.due_date,d.explicit_status
    from installment_due d join installment_plan p on p.id=d.installment_plan_id
    join monthly_plan mp on mp.user_id=p.user_id and mp.month_start=date_trunc('month',d.due_date)::date and mp.status='open'
    where p.user_id=$1 and p.status='active' and ($2::bigint is null or mp.id=$2)
    on conflict do nothing`,
    [userId, monthPlanId ?? null],
  );
  return result.rowCount ?? 0;
}
export async function loadInstallment(
  db: DB,
  userId: number,
  planId: number,
  lock = false,
) {
  const result = await db.query(
    `select * from installment_plan where id=$1 and user_id=$2${lock ? " for update" : ""}`,
    [planId, userId],
  );
  if (!result.rows[0]) throw new HttpError(404, "ไม่พบแผนผ่อน");
  return result.rows[0];
}
export async function installmentDetail(
  db: DB,
  userId: number,
  planId: number,
) {
  const plan = await loadInstallment(db, userId, planId);
  const { rows: dues } = await db.query(
    `select d.id,d.installment_no,d.due_date,d.amount_satang,i.id as monthly_plan_item_id,
    coalesce(mp.status='closed',false) as plan_closed,
    coalesce(pay.paid_satang,0)::bigint as paid_satang,coalesce(pay.matched_satang,0)::bigint as matched_satang,
    (d.amount_satang-coalesce(pay.paid_satang,0))::bigint as outstanding_satang,
    case when $2='cancelled' then 'cancelled' when d.explicit_status='skipped' then 'skipped'
      when coalesce(pay.paid_satang,0)>=d.amount_satang then 'paid'
      when coalesce(pay.paid_satang,0)>0 then 'partially_paid'
      when d.due_date<current_date then 'overdue' else 'planned' end as status,
    coalesce(pay.payments,'[]'::json) as payments
    from installment_due d left join monthly_plan_item i on i.installment_due_id=d.id
    left join monthly_plan mp on mp.user_id=$3 and mp.month_start=date_trunc('month',d.due_date)::date
    left join lateral(select sum(p.amount_satang) filter(where p.status<>'cancelled') as paid_satang,
      sum(p.amount_satang) filter(where p.status='matched') as matched_satang,
      json_agg(json_build_object('id',p.id,'amount_satang',p.amount_satang,'paid_date',p.paid_date,'bank_account_id',p.bank_account_id,
      'account_nickname',a.nickname,'txn_id',p.txn_id,'status',p.status,'verified_at',p.verified_at) order by p.id) as payments
      from monthly_item_payment p join bank_account a on a.id=p.bank_account_id and a.user_id=$3 where p.monthly_plan_item_id=i.id) pay on true
    where d.installment_plan_id=$1 order by d.installment_no`,
    [planId, plan.status, userId],
  );
  const paid = dues.reduce((s, d) => s + d.paid_satang, 0),
    matched = dues.reduce((s, d) => s + d.matched_satang, 0);
  const total =
    plan.total_amount_satang + plan.interest_satang + plan.fee_satang;
  return {
    ...plan,
    total_payable_satang: total,
    paid_satang: paid,
    matched_satang: matched,
    outstanding_satang: total - paid,
    status:
      plan.status === "cancelled"
        ? "cancelled"
        : paid >= total
          ? "completed"
          : "active",
    structural_editable:
      plan.status !== "cancelled" &&
      dues.every((d) => !d.plan_closed && d.payments.length === 0),
    dues,
  };
}
const STRUCTURAL = [
  "total_amount_satang",
  "down_payment_satang",
  "interest_satang",
  "fee_satang",
  "installment_count",
  "frequency_unit",
  "frequency_interval",
  "first_due_date",
  "down_payment_date",
] as const;
export async function saveInstallment(
  db: DB,
  userId: number,
  b: Body,
  planId?: number,
) {
  const previous =
    planId == null ? null : await loadInstallment(db, userId, planId, true);
  const values = {
    down_payment_satang: 0,
    interest_satang: 0,
    fee_satang: 0,
    frequency_interval: 1,
    down_payment_date: null,
    ...previous,
    ...b,
  };
  const scheduleInput: InstallmentInput = {
    total_amount_satang: satang(values, "total_amount_satang"),
    down_payment_satang: satang(values, "down_payment_satang"),
    interest_satang: satang(values, "interest_satang"),
    fee_satang: satang(values, "fee_satang"),
    installment_count: id(values, "installment_count"),
    frequency_interval: id(values, "frequency_interval"),
    frequency_unit: enumStr(values, "frequency_unit", ["day", "month", "year"]),
    first_due_date: isoDate(values, "first_due_date"),
    down_payment_date:
      values.down_payment_date == null || values.down_payment_date === ""
        ? null
        : isoDate(values, "down_payment_date"),
  };
  const schedule = installmentSchedule(scheduleInput);
  const name = str(values, "name", 120),
    category = values.category_id == null ? null : id(values, "category_id"),
    account =
      values.default_account_id == null
        ? null
        : id(values, "default_account_id");
  await assertOwnedRefs(db, userId, {
    categoryId: category,
    bankAccountId: account,
  });
  if (category != null && !(await db.query("select 1 from category where id=$1 and kind='expense'", [category])).rowCount) {
    throw new HttpError(400, 'หมวดของแผนผ่อนต้องเป็นรายจ่าย');
  }
  const structural =
    !previous ||
    STRUCTURAL.some(
      (k) => Object.hasOwn(b, k) && scheduleInput[k] !== previous[k],
    );
  if (previous) {
    const months = await db.query(
      `select mp.status from monthly_plan mp where mp.user_id=$1 and (
      mp.month_start in(select date_trunc('month',due_date)::date from installment_due where installment_plan_id=$2)
      or ( $3::boolean and mp.month_start=any($4::date[]))) order by mp.id for update`,
      [
        userId,
        planId,
        structural,
        schedule.map((d) => `${d.due_date.slice(0, 7)}-01`),
      ],
    );
    if (structural && months.rows.some((m) => m.status === "closed"))
      throw new HttpError(
        409,
        "ต้องเปิดเดือนที่เกี่ยวข้องก่อนเปลี่ยนตารางผ่อน",
      );
  }
  if (
    previous &&
    structural &&
    !(await installmentDetail(db, userId, planId!)).structural_editable
  )
    throw new HttpError(
      409,
      "แก้ยอดหรือตารางหลังมีประวัติชำระหรือเดือนปิดไม่ได้",
    );
  const status =
    b.status == null
      ? (previous?.status ?? "active")
      : enumStr(b, "status", ["active", "cancelled"]);
  if (previous?.status === "cancelled" && status !== "cancelled")
    throw new HttpError(409, "เปิดแผนที่ยกเลิกแล้วไม่ได้");
  if (previous) {
    await db.query(
      `update installment_plan set name=$2,category_id=$3,default_account_id=$4,status=$5,updated_at=now() where id=$1`,
      [planId, name, category, account, status],
    );
    if (structural) {
      await db.query(
        `delete from monthly_plan_item where installment_due_id in(select id from installment_due where installment_plan_id=$1)`,
        [planId],
      );
      await db.query(
        "delete from installment_due where installment_plan_id=$1",
        [planId],
      );
      await db.query(
        `update installment_plan set total_amount_satang=$2,down_payment_satang=$3,interest_satang=$4,fee_satang=$5,installment_count=$6,frequency_unit=$7,frequency_interval=$8,first_due_date=$9,down_payment_date=$10 where id=$1`,
        [planId, ...STRUCTURAL.map((k) => scheduleInput[k])],
      );
    }
    await db.query(
      `update monthly_plan_item i set name=$2 || case when d.installment_no=0 then ' · เงินดาวน์' else ' · งวด ' || d.installment_no end,category_id=$3,
      explicit_status=case when $4='cancelled' then 'cancelled' else d.explicit_status end,updated_at=now()
      from installment_due d,monthly_plan mp where i.installment_due_id=d.id and d.installment_plan_id=$1 and mp.id=i.monthly_plan_id and mp.status='open'`,
      [planId, name, category, status],
    );
  } else {
    planId = (
      await db.query(
        `insert into installment_plan(user_id,name,category_id,default_account_id,total_amount_satang,down_payment_satang,interest_satang,fee_satang,installment_count,frequency_unit,frequency_interval,first_due_date,down_payment_date)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
        [
          userId,
          name,
          category,
          account,
          ...STRUCTURAL.map((k) => scheduleInput[k]),
        ],
      )
    ).rows[0]!.id;
  }
  if (structural)
    for (const due of schedule)
      await db.query(
        `insert into installment_due(installment_plan_id,installment_no,due_date,amount_satang) values($1,$2,$3,$4)`,
        [planId, due.installment_no, due.due_date, due.amount_satang],
      );
  await generateInstallmentItems(db, userId);
  return planId!;
}
export async function loadDue(db: DB, userId: number, dueId: number) {
  const result = await db.query(
    `select d.*,p.user_id,p.status as plan_status from installment_due d join installment_plan p on p.id=d.installment_plan_id where d.id=$1 and p.user_id=$2`,
    [dueId, userId],
  );
  if (!result.rows[0]) throw new HttpError(404, "ไม่พบงวดผ่อน");
  return result.rows[0];
}
export async function materializeDue(db: DB, userId: number, dueId: number) {
  let due = await loadDue(db, userId, dueId);
  await loadInstallment(db, userId, due.installment_plan_id, true);
  due = await loadDue(db, userId, dueId);
  if (due.plan_status === "cancelled")
    throw new HttpError(409, "แผนผ่อนถูกยกเลิกแล้ว");
  await db.query(
    `insert into monthly_plan(user_id,month_start) values($1,date_trunc('month',$2::date)::date) on conflict do nothing`,
    [userId, due.due_date],
  );
  const mp = (
    await db.query(
      `select id,status from monthly_plan where user_id=$1 and month_start=date_trunc('month',$2::date)::date for update`,
      [userId, due.due_date],
    )
  ).rows[0]!;
  if (mp.status !== "open") throw new HttpError(409, "ต้องเปิดเดือนของงวดก่อน");
  await generateInstallmentItems(db, userId, mp.id);
  const item = (
    await db.query(
      "select id from monthly_plan_item where installment_due_id=$1",
      [dueId],
    )
  ).rows[0]!;
  return { due, itemId: item.id as number };
}
export async function declarePayment(
  db: DB,
  userId: number,
  itemId: number,
  b: Body,
) {
  let item = await loadOwnedItem(db, userId, itemId);
  if (item.income_record_id != null)
    throw new HttpError(409, "จัดการการรับเงินผ่านรายได้");
  if (item.installment_due_id != null) {
    let due = await loadDue(db, userId, item.installment_due_id);
    await loadInstallment(db, userId, due.installment_plan_id, true);
    due = await loadDue(db, userId, item.installment_due_id);
    if (due.plan_status === "cancelled" || due.explicit_status !== "active")
      throw new HttpError(409, "งวดนี้ไม่ได้เปิดให้ชำระ");
  }
  item = await loadOwnedItem(db, userId, itemId, { requireOpen: true });
  if (item.income_record_id != null)
    throw new HttpError(409, "จัดการการรับเงินผ่านรายได้");
  await db.query("select id from monthly_plan_item where id=$1 for update", [
    itemId,
  ]);
  const amount = satang(b, "amount_satang");
  if (amount <= 0) throw new HttpError(400, "ยอดชำระต้องมากกว่า 0");
  if (item.installment_due_id != null) {
    const paid = (
      await db.query(
        "select coalesce(sum(amount_satang),0)::bigint as amount from monthly_item_payment where monthly_plan_item_id=$1 and status<>'cancelled'",
        [itemId],
      )
    ).rows[0]!.amount;
    if (BigInt(paid) + BigInt(amount) > BigInt(item.planned_amount_satang))
      throw new HttpError(409, "ยอดชำระเกินยอดคงเหลืองวด");
  }
  const account = id(b, "bank_account_id");
  await assertOwnedRefs(db, userId, { bankAccountId: account });
  return (
    await db.query(
      `insert into monthly_item_payment(monthly_plan_item_id,amount_satang,paid_date,bank_account_id) values($1,$2,$3,$4) returning *`,
      [itemId, amount, isoDate(b, "paid_date"), account],
    )
  ).rows[0]!;
}
