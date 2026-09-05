import type { Pool, PoolClient } from "pg";
import {
  HttpError,
  enumStr,
  id,
  isoDate,
  satang,
  str,
  type Body,
} from "../http.js";
import { assertOwnedRefs, loadOwnedPlanByMonth } from "./plan-query.js";
import { expectedNet } from "./income-installment-math.js";

type DB = Pick<Pool | PoolClient, "query">;
export async function lockIncome(db: DB, userId: number) {
  await db.query("select pg_advisory_xact_lock(600, $1::int)", [userId]);
}
const CANDIDATES = `select r.id as income_record_id, t.id, t.txn_date, t.description, t.amount_satang,
  a.nickname as account_nickname, count(*) over(partition by r.id)::int as candidate_count,
  count(*) over(partition by t.id)::int as income_count
  from income_record r
  join monthly_plan_item i on i.id=r.monthly_plan_item_id and i.explicit_status='active'
  join bank_account a on a.id=r.bank_account_id and a.user_id=r.user_id
  join txn t on t.bank_account_id=a.id and t.direction='credit'
    and t.amount_satang=r.expected_net_satang and abs(t.txn_date-r.income_date)<=3
  where r.user_id=$1 and r.expected_net_satang>0
    and not t.is_internal_transfer
    and not exists(select 1 from monthly_item_payment p where p.monthly_plan_item_id=i.id and p.status<>'cancelled')
    and not exists(select 1 from monthly_item_payment p where p.txn_id=t.id and p.status='matched')
    and not exists(select 1 from txn_annotation ta where ta.txn_id=t.id and ta.classification in ('internal_transfer','excluded'))
    and not exists(select 1 from transfer_match tm where tm.status='confirmed' and (tm.credit_txn_id=t.id or tm.debit_txn_id=t.id))`;
export async function incomeCandidates(
  db: DB,
  userId: number,
  incomeId?: number,
) {
  const { rows } = await db.query(CANDIDATES, [userId]);
  return incomeId == null
    ? rows
    : rows.filter((r) => r.income_record_id === incomeId);
}
export async function loadIncome(
  db: DB,
  userId: number,
  incomeId: number,
  requireOpen = false,
) {
  const { rows } = await db.query(
    `select r.*, mp.status as plan_status, mp.month_start
    from income_record r join monthly_plan mp on mp.id=r.monthly_plan_id
    where r.id=$1 and r.user_id=$2 and mp.user_id=$2`,
    [incomeId, userId],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, "ไม่พบรายได้");
  if (requireOpen && row.plan_status !== "open")
    throw new HttpError(409, "ต้องเปิดเดือนก่อนแก้ไขรายได้");
  return row;
}
export async function incomeRows(
  db: DB,
  userId: number,
  month?: string,
  incomeId?: number,
) {
  const { rows } = await db.query(
    `select r.*,mp.month_start,
    (select p.txn_id from monthly_item_payment p where p.monthly_plan_item_id=r.monthly_plan_item_id and p.status='matched' limit 1) as deposit_txn_id,
    coalesce((select json_agg(d order by d.id) from income_deduction d where d.income_record_id=r.id),'[]'::json) as deductions
    from income_record r join monthly_plan mp on mp.id=r.monthly_plan_id and mp.user_id=r.user_id
    where r.user_id=$1 and ($2::date is null or mp.month_start=$2) and ($3::bigint is null or r.id=$3)
    order by r.id`,
    [userId, month ? `${month}-01` : null, incomeId ?? null],
  );
  const candidates = await incomeCandidates(db, userId);
  return rows.map((row) => ({
    ...row,
    match_status:
      row.expected_net_satang === 0
        ? "not_required"
        : row.deposit_txn_id
          ? "matched"
          : candidates.some(
                (c) =>
                  c.income_record_id === row.id &&
                  (c.candidate_count > 1 || c.income_count > 1),
              )
            ? "needs_review"
            : "pending",
  }));
}
export async function matchIncome(
  db: DB,
  userId: number,
  incomeId: number,
  txnId: number,
) {
  const row = await loadIncome(db, userId, incomeId);
  const candidates = await incomeCandidates(db, userId, incomeId);
  const candidate = candidates.find((c) => c.id === txnId);
  if (!candidate)
    throw new HttpError(409, "ธุรกรรมไม่ตรงเกณฑ์หรือถูกจับคู่แล้ว");
  await db.query("select id from txn where id=$1 for update", [txnId]);
  await db.query(
    `insert into monthly_item_payment(monthly_plan_item_id,amount_satang,paid_date,bank_account_id,txn_id,status,verified_at)
    values($1,$2,$3,$4,$5,'matched',now())`,
    [
      row.monthly_plan_item_id,
      row.expected_net_satang,
      candidate.txn_date,
      row.bank_account_id,
      txnId,
    ],
  );
}
export async function reconcileIncome(db: DB, userId: number) {
  await lockIncome(db, userId);
  const candidates = await incomeCandidates(db, userId);
  for (const candidate of candidates) {
    if (candidate.candidate_count !== 1 || candidate.income_count !== 1)
      continue;
    const income = await loadIncome(db, userId, candidate.income_record_id);
    if (income.auto_match)
      await matchIncome(db, userId, income.id, candidate.id);
  }
}
type DeductionInput = {
  deduction_type: string;
  name: string;
  amount_satang: number;
  monthly_plan_item_id: number | null;
};
function deductionsInput(value: unknown): DeductionInput[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new HttpError(400, "deductions ต้องเป็นรายการไม่เกิน 100 รายการ");
  return value.map((v: unknown) => {
    if (v == null || typeof v !== "object" || Array.isArray(v))
      throw new HttpError(400, "รายการหักไม่ถูกต้อง");
    const b = v as Body;
    return {
      deduction_type: enumStr(b, "deduction_type", [
        "social_security",
        "withholding_tax",
        "other",
      ]),
      name: str(b, "name", 120),
      amount_satang: satang(b, "amount_satang"),
      monthly_plan_item_id:
        b.monthly_plan_item_id == null ? null : id(b, "monthly_plan_item_id"),
    };
  });
}
async function linkItem(
  db: DB,
  userId: number,
  planId: number,
  kind: string,
  name: string,
  amount: number,
  itemId: number | null,
  incomeId: number | null,
  date: string | null,
) {
  if (itemId != null) {
    const { rows } = await db.query(
      `select i.* from monthly_plan_item i join monthly_plan mp on mp.id=i.monthly_plan_id
      where i.id=$1 and mp.user_id=$2 and mp.id=$3 for update of i`,
      [itemId, userId, planId],
    );
    const item = rows[0];
    if (
      !item ||
      item.kind !== kind ||
      item.installment_due_id != null ||
      (item.income_record_id != null && item.income_record_id !== incomeId)
    )
      throw new HttpError(409, "รายการนี้เชื่อมกับรายได้ไม่ได้");
    if (
      (
        await db.query(
          "select 1 from monthly_item_payment where monthly_plan_item_id=$1 and status<>'cancelled'",
          [itemId],
        )
      ).rowCount
    )
      throw new HttpError(409, "ต้องยกเลิก Payment เดิมก่อน");
    await db.query(
      "update monthly_plan_item set name=$2,planned_amount_satang=$3,income_record_id=$4,explicit_status='active',updated_at=now() where id=$1",
      [itemId, name, amount, incomeId],
    );
    return itemId;
  }
  return (
    await db.query(
      `insert into monthly_plan_item(monthly_plan_id,kind,name,planned_amount_satang,income_record_id,due_date)
    values($1,$2,$3,$4,$5,$6) returning id`,
      [planId, kind, name, amount, incomeId, date],
    )
  ).rows[0]!.id as number;
}
export async function saveIncome(
  db: DB,
  userId: number,
  b: Body,
  incomeId?: number,
) {
  await lockIncome(db, userId);
  const previous =
    incomeId == null ? null : await loadIncome(db, userId, incomeId, true);
  const month = previous
    ? previous.month_start.slice(0, 7)
    : str(b, "month", 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw new HttpError(400, "month ต้องเป็น YYYY-MM");
  if (!previous) {
    const now = new Date();
    const [year, m] = month.split("-").map(Number);
    if (year * 12 + m - 1 > now.getFullYear() * 12 + now.getMonth() + 12)
      throw new HttpError(400, "วางแผนล่วงหน้าได้ไม่เกิน 12 เดือน");
    await db.query(
      "insert into monthly_plan(user_id,month_start) values($1,$2) on conflict do nothing",
      [userId, `${month}-01`],
    );
  }
  const plan = await loadOwnedPlanByMonth(db, userId, `${month}-01`, {
    requireOpen: true,
  });
  await db.query("select id from monthly_plan where id=$1 for update", [
    plan.id,
  ]);
  const values = { ...previous, ...b };
  const name = str(values, "name", 120),
    gross = satang(values, "gross_amount_satang");
  const account =
    values.bank_account_id == null ? null : id(values, "bank_account_id");
  const date =
    values.income_date == null || values.income_date === ""
      ? null
      : isoDate(values, "income_date");
  if (date && date.slice(0, 7) !== month)
    throw new HttpError(400, "วันที่รับเงินต้องอยู่ในเดือนรายได้");
  if (values.auto_match != null && typeof values.auto_match !== "boolean")
    throw new HttpError(400, "auto_match ต้องเป็น boolean");
  await assertOwnedRefs(db, userId, { bankAccountId: account });
  const oldDeductions = previous
    ? (
        await db.query(
          "select * from income_deduction where income_record_id=$1",
          [incomeId],
        )
      ).rows
    : [];
  const deductions = deductionsInput(b.deductions ?? oldDeductions);
  const linked = deductions
    .map((d) => d.monthly_plan_item_id)
    .filter((v) => v != null);
  if (new Set(linked).size !== linked.length)
    throw new HttpError(400, "รายการหักเชื่อมซ้ำ");
  const net = expectedNet(
    gross,
    deductions.map((d) => d.amount_satang),
  );
  if (
    previous &&
    (
      await db.query(
        "select 1 from monthly_item_payment where monthly_plan_item_id=$1 and status<>'cancelled'",
        [previous.monthly_plan_item_id],
      )
    ).rowCount
  ) {
    // Reconciliation evidence must retain the financial meaning it verified.
    const financial = gross !== previous.gross_amount_satang || account !== previous.bank_account_id ||
      date !== previous.income_date ||
      (b.monthly_plan_item_id != null && Number(b.monthly_plan_item_id) !== previous.monthly_plan_item_id) ||
      JSON.stringify(deductions) !== JSON.stringify(deductionsInput(oldDeductions));
    if (financial)
      throw new HttpError(409, "ต้องยกเลิกคู่เงินเข้าก่อนแก้รายได้");
    await db.query(
      "update income_record set name=$2,auto_match=$3,updated_at=now() where id=$1",
      [incomeId, name, values.auto_match ?? true],
    );
    await db.query("update monthly_plan_item set name=$2 where id=$1", [
      previous.monthly_plan_item_id,
      name,
    ]);
    return incomeId!;
  }
  if (
    previous &&
    b.monthly_plan_item_id != null &&
    Number(b.monthly_plan_item_id) !== previous.monthly_plan_item_id
  )
    throw new HttpError(409, "เปลี่ยนรายการรายได้ที่เชื่อมแล้วไม่ได้");
  const itemId = await linkItem(
    db,
    userId,
    plan.id,
    "income",
    name,
    gross,
    previous?.monthly_plan_item_id ??
      (b.monthly_plan_item_id == null ? null : id(b, "monthly_plan_item_id")),
    incomeId ?? null,
    date,
  );
  if (!previous)
    incomeId = (
      await db.query(
        `insert into income_record(user_id,monthly_plan_id,monthly_plan_item_id,name,gross_amount_satang,expected_net_satang,bank_account_id,income_date,auto_match)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [
          userId,
          plan.id,
          itemId,
          name,
          gross,
          net,
          account,
          date,
          values.auto_match ?? true,
        ],
      )
    ).rows[0]!.id;
  else
    await db.query(
      `update income_record set name=$2,gross_amount_satang=$3,expected_net_satang=$4,bank_account_id=$5,income_date=$6,auto_match=$7,updated_at=now() where id=$1`,
      [incomeId, name, gross, net, account, date, values.auto_match ?? true],
    );
  await db.query(
    "update monthly_plan_item set income_record_id=$2,due_date=$3 where id=$1",
    [itemId, incomeId, date],
  );
  await db.query("delete from income_deduction where income_record_id=$1", [
    incomeId,
  ]);
  for (const d of deductions) {
    const linkedId = await linkItem(
      db,
      userId,
      plan.id,
      "payroll_deduction",
      d.name,
      d.amount_satang,
      d.monthly_plan_item_id,
      incomeId!,
      date,
    );
    await db.query(
      `insert into income_deduction(income_record_id,monthly_plan_item_id,deduction_type,name,amount_satang) values($1,$2,$3,$4,$5)`,
      [incomeId, linkedId, d.deduction_type, d.name, d.amount_satang],
    );
  }
  for (const old of oldDeductions)
    if (!linked.includes(old.monthly_plan_item_id))
      await db.query(
        "update monthly_plan_item set explicit_status='cancelled' where id=$1",
        [old.monthly_plan_item_id],
      );
  await reconcileIncome(db, userId);
  return incomeId!;
}
