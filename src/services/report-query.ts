import { query } from '../db.js';
import { HttpError } from '../http.js';

// join กลางที่ทุก query ระดับ txn ใช้ร่วมกัน — เจ้าของ (a.user_id) + annotation ถ้ามี (ส่วนใหญ่ไม่มี)
export const OWNED_TXN_FROM =
  'from txn t join bank_account a on a.id = t.bank_account_id left join txn_annotation an on an.txn_id = t.id';

// coalesce กัน NULL เสมอ — txn_annotation มีแถวเฉพาะตอนผู้ใช้ annotate เอง (ส่วนใหญ่ไม่มี) ไม่ coalesce
// แล้วเทียบ classification ตรง ๆ จะได้ NULL แล้ว WHERE ตัดทิ้งเงียบ ๆ เกือบทั้งบัญชี
export const IS_INTERNAL_TRANSFER_SQL = "(t.is_internal_transfer or coalesce(an.classification, '') = 'internal_transfer')";

export const EFFECTIVE_CLASSIFICATION_SQL = `case
  when ${IS_INTERNAL_TRANSFER_SQL} then 'internal_transfer'
  when an.classification is not null then an.classification
  when t.direction = 'credit' then 'income'
  else 'expense'
end`;

// direction มาจาก statement ที่ผ่าน checksum แล้ว จึงจำแนกรายรับ/รายจ่ายพื้นฐานได้ทันทีโดยไม่ต้องรอคนกดตรวจ
export const EFFECTIVE_REVIEW_STATUS_SQL = "coalesce(an.review_status, 'reviewed')";

// รายงาน (summary/cash-flow/category-breakdown) ตัดทั้งคู่โอนภายในและรายการที่ผู้ใช้ excluded เอง —
// แต่ list ธุรกรรม (TXN_FILTER_SQL) ต้องไม่ใช้ตัวนี้ ผู้ใช้ต้องยังเห็น internal transfer ในตารางได้ (§8.3/§8.4)
export const EXCLUDED_FROM_FLOW_SQL = `(${IS_INTERNAL_TRANSFER_SQL} or coalesce(an.classification, '') = 'excluded')`;

// entity ที่มีผลจริงต่อธุรกรรมนี้ — override ต่อรายการถ้ามี ไม่งั้นใช้ default ของบัญชี (§10.1, Slice 7)
// Slice 8 (คำนวณภาษี) ใช้ตัวนี้ตัดสิน entity เจ้าของยอด ไม่ใช่สร้างกลไกนี้ใหม่
export const EFFECTIVE_TAX_ENTITY_SQL = 'coalesce(an.tax_entity_id, a.default_tax_entity_id)';

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function nextMonthFirstDay(firstOfMonth: string): string {
  const [y, m] = firstOfMonth.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${pad2(m + 1)}-01`;
}

// บวก 1 วันแบบ pure date arithmetic (ไม่ผูก timezone จริง) ใช้ได้เพราะเราแค่จัดการ calendar date ล้วน ๆ
function nextDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function monthIndex(dateStr: string): number {
  const [y, m] = dateStr.split('-').map(Number) as [number, number];
  return y * 12 + (m - 1);
}

// เดือนปัจจุบันตาม local time ของ process (deploy จริงตั้ง TZ=Asia/Bangkok) — parseRange เป็น sync
// ล้วน ๆ ไม่มี DB ให้ถาม current_date ได้ตรงนี้
function currentMonthRange(): { from: string; to: string } {
  const now = new Date();
  const from = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-01`;
  return { from, to: nextMonthFirstDay(from) };
}

/**
 * month=YYYY-MM หรือ from/to (YYYY-MM-DD, to เป็น inclusive ฝั่งผู้เรียก) → ช่วงครึ่งเปิด [from, to)
 * ไม่ส่ง arg มาเลย = เดือนปัจจุบัน. เกิน maxMonths (ถ้าระบุ) หรือรูปแบบผิด → HttpError(400)
 */
export function parseRange(q: Record<string, unknown>, maxMonths?: number): { from: string; to: string } {
  let from: string;
  let to: string;

  if (typeof q.month === 'string') {
    if (!MONTH_RE.test(q.month)) throw new HttpError(400, 'month ต้องเป็นรูปแบบ YYYY-MM');
    from = `${q.month}-01`;
    to = nextMonthFirstDay(from);
  } else if (q.from != null || q.to != null) {
    if (typeof q.from !== 'string' || !DATE_RE.test(q.from)) throw new HttpError(400, 'from ต้องเป็นรูปแบบ YYYY-MM-DD');
    if (typeof q.to !== 'string' || !DATE_RE.test(q.to)) throw new HttpError(400, 'to ต้องเป็นรูปแบบ YYYY-MM-DD');
    from = q.from;
    to = nextDay(q.to);
    if (to <= from) throw new HttpError(400, 'to ต้องไม่ก่อน from');
  } else {
    ({ from, to } = currentMonthRange());
  }

  if (maxMonths != null && monthIndex(to) - monthIndex(from) > maxMonths) {
    throw new HttpError(400, `ช่วงเวลาต้องไม่เกิน ${maxMonths} เดือน`);
  }

  return { from, to };
}

function optId(q: Record<string, unknown>, field: string): number | null {
  const v = q[field];
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${field} ไม่ถูกต้อง`);
  return n;
}

function optEnum<T extends string>(q: Record<string, unknown>, field: string, values: readonly T[]): T | null {
  const v = q[field];
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
    throw new HttpError(400, `${field} ต้องเป็นหนึ่งใน ${values.join(', ')}`);
  }
  return v as T;
}

function optBool(q: Record<string, unknown>, field: string): boolean | null {
  const v = q[field];
  if (v == null || v === '') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new HttpError(400, `${field} ต้องเป็น true หรือ false`);
}

function optSatang(q: Record<string, unknown>, field: string): number | null {
  const v = q[field];
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${field} ไม่ถูกต้อง`);
  return n;
}

export type TxnFilters = {
  from: string;
  to: string;
  bankAccountId: number | null;
  bankId: number | null;
  categoryId: number | null;
  uncategorised: boolean;
  direction: 'credit' | 'debit' | null;
  accountPurpose: 'personal' | 'business' | null;
  isInternalTransfer: boolean | null;
  reviewStatus: 'reviewed' | 'unreviewed' | null;
  minSatang: number | null;
  maxSatang: number | null;
  q: string | null;
  // 'none' = sentinel หมายถึง "ยังไม่ระบุ" (IS NULL) ไม่ใช่ค่า enum จริงในตาราง — ให้ drill-down จาก
  // missing-document report ("ยังไม่ระบุ Tax Treatment") กรองชุดเดียวกับที่การ์ดนับได้ ไม่งั้นส่ง null
  // (=ไม่กรองอะไรเลย) จะได้ superset ผิดจากที่การ์ดบอก
  taxTreatment: string | 'none' | null;
  taxEntityId: number | null;
  classification: 'income' | 'expense' | 'internal_transfer' | 'excluded' | null;
  limit: number;
  offset: number;
};

const TAX_TREATMENTS = [
  'personal',
  'business_income',
  'business_expense',
  'non_deductible',
  'internal_transfer',
  'excluded',
  'none', // sentinel: กรองเฉพาะ tax_treatment is null — ดูคอมเมนต์ที่ TxnFilters.taxTreatment
] as const;

export function parseTxnFilters(q: Record<string, unknown>): TxnFilters {
  const { from, to } = parseRange(q);

  const limitRaw = q.limit == null || q.limit === '' ? 50 : Number(q.limit);
  if (!Number.isInteger(limitRaw) || limitRaw <= 0) throw new HttpError(400, 'limit ไม่ถูกต้อง');
  const offsetRaw = q.offset == null || q.offset === '' ? 0 : Number(q.offset);
  if (!Number.isInteger(offsetRaw) || offsetRaw < 0) throw new HttpError(400, 'offset ไม่ถูกต้อง');

  return {
    from,
    to,
    bankAccountId: optId(q, 'bank_account_id'),
    bankId: optId(q, 'bank_id'),
    categoryId: optId(q, 'category_id'),
    uncategorised: optBool(q, 'uncategorised') ?? false,
    direction: optEnum(q, 'direction', ['credit', 'debit'] as const),
    accountPurpose: optEnum(q, 'account_purpose', ['personal', 'business'] as const),
    isInternalTransfer: optBool(q, 'is_internal_transfer'),
    reviewStatus: optEnum(q, 'review_status', ['reviewed', 'unreviewed'] as const),
    minSatang: optSatang(q, 'min_satang'),
    maxSatang: optSatang(q, 'max_satang'),
    q: typeof q.q === 'string' && q.q.trim() !== '' ? q.q.trim() : null,
    taxTreatment: optEnum(q, 'tax_treatment', TAX_TREATMENTS),
    taxEntityId: optId(q, 'tax_entity_id'),
    classification: optEnum(q, 'classification', ['income', 'expense', 'internal_transfer', 'excluded'] as const),
    limit: Math.min(limitRaw, 200),
    offset: offsetRaw,
  };
}

// $1 = userId เสมอ, $2/$3 = ช่วงวันที่ครึ่งเปิด, $4..$17 = ตัวกรอง ผู้เรียก (route) ต่อ limit/offset ของตัวเองได้จาก $18
// txn.counterparty เป็น NULL เสมอ (worker ไม่เคยเขียนคอลัมน์นี้) — ค้นหาด้วย description อย่างเดียว
// $15/$16/$17 เพิ่มเข้ามาใน Slice 8 ให้การ์ดภาษี (group ตาม tax_treatment/entity) กับปุ่ม drill-down
// ไปหน้านี้แสดง "ชุดเดียวกันเป๊ะ" — ไม่งั้นซ้ำรอยบั๊ก excluded ที่ Slice 4B ทิ้งไว้ (การ์ดตัด แต่ list กรองไม่ได้)
export const TXN_FILTER_SQL = `
  where a.user_id = $1
    and t.txn_date >= $2 and t.txn_date < $3
    and ($4::bigint is null or t.bank_account_id = $4)
    and ($5::bigint is null or a.bank_id = $5)
    and ($6::bigint is null or exists (select 1 from txn_split s where s.txn_id = t.id and s.category_id = $6))
    and ($7::boolean is false or not exists (select 1 from txn_split s2 where s2.txn_id = t.id))
    and ($8::text is null or t.direction = $8)
    and ($9::text is null or a.account_purpose = $9)
    and ($10::boolean is null or (${IS_INTERNAL_TRANSFER_SQL}) = $10)
    and ($11::text is null or ${EFFECTIVE_REVIEW_STATUS_SQL} = $11)
    and ($12::bigint is null or t.amount_satang >= $12)
    and ($13::bigint is null or t.amount_satang <= $13)
    and ($14::text is null or t.description ilike '%' || $14 || '%')
    and ($15::text is null or ($15 = 'none' and an.tax_treatment is null) or an.tax_treatment = $15)
    and ($16::bigint is null or (${EFFECTIVE_TAX_ENTITY_SQL}) = $16)
    and ($17::text is null or (${EFFECTIVE_CLASSIFICATION_SQL}) = $17)
`;

export function txnFilterParams(userId: number, f: TxnFilters): unknown[] {
  return [
    userId,
    f.from,
    f.to,
    f.bankAccountId,
    f.bankId,
    f.categoryId,
    f.uncategorised,
    f.direction,
    f.accountPurpose,
    f.isInternalTransfer,
    f.reviewStatus,
    f.minSatang,
    f.maxSatang,
    f.q,
    f.taxTreatment,
    f.taxEntityId,
    f.classification,
  ];
}

export type AccountCoverage = {
  bank_account_id: number;
  account_nickname: string;
  bank_id: number;
  bank_name: string;
  account_purpose: 'personal' | 'business';
  email: string;
  last_synced_at: string | null;
  latest_txn_date: string | null;
  latest_parsed_period_end: string | null;
  parsed_statement_count: number;
  pending_statement_count: number;
  parse_failed_count: number;
  checksum_failed_count: number;
  statement_behind: boolean;
};

// กติกาข้อมูลขาดช่วง (§8.1/§8.2): ระหว่างเดือน M เทียบ period_end ล่าสุดของ statement ที่ parsed แล้ว
// กับ "วันสุดท้ายของเดือน M-1" เท่านั้น — เช็คเดือน M ตรง ๆ ผิด เพราะ statement ของเดือนนี้ยังไม่มีจนกว่าเดือนจะปิด
// (ทุกบัญชีจะเตือน false ถาวร) ใช้ max(period_end) อย่างเดียว ไม่นับจำนวน statement เป็นตัวชี้วัด เพราะ migration 003
// ถอด unique (bank_account_id, period_start, period_end) แล้ว — SCB ส่งไฟล์รายเดือนทับไฟล์ย้อนหลัง (on-demand)
// ของช่วงเดียวกันได้ตามปกติ นับ statement ต่อเดือนพิสูจน์ความครบถ้วนไม่ได้ มีแต่ max(period_end) ที่มีความหมาย
// guard a.created_at กันบัญชีที่เพิ่งเพิ่มเดือนนี้ไม่ให้เตือนเท็จ (ไม่มีคอลัมน์ opened_at ในสคีมา ใช้ created_at
// เป็น proxy ที่ตรงที่สุดที่มี)
//
// ไม่ตรวจ: gap ภายใน (parse ม.ค.+มี.ค. ข้ามก.พ. อ่านว่าปกติ), gap ระดับวัน, หรือ parse_failed/checksum_failed
// อยู่เดือนไหน (period_start/period_end เป็น null ตาม migration 002)
// ponytail: ถ้าต้องแม่นระดับวัน/ตรวจ gap ภายใน ให้ไปทาง range_agg(daterange(period_start, period_end)) ต่อบัญชี
// (PG 16 รองรับ) — ยังไม่คุ้มความซับซ้อนตอนนี้
export async function accountCoverage(userId: number): Promise<AccountCoverage[]> {
  const { rows } = await query<AccountCoverage>(
    `select
       a.id as bank_account_id,
       a.nickname as account_nickname,
       b.id as bank_id,
       b.name as bank_name,
       a.account_purpose,
       e.email,
       e.last_synced_at,
       (select max(t.txn_date) from txn t where t.bank_account_id = a.id) as latest_txn_date,
       max(st.period_end) filter (where st.status = 'parsed') as latest_parsed_period_end,
       count(*) filter (where st.status = 'parsed') as parsed_statement_count,
       count(*) filter (where st.status = 'pending') as pending_statement_count,
       count(*) filter (where st.status = 'parse_failed') as parse_failed_count,
       count(*) filter (where st.status = 'checksum_failed') as checksum_failed_count,
       case
         when a.created_at >= date_trunc('month', current_date) then false
         else coalesce(max(st.period_end) filter (where st.status = 'parsed'), '-infinity'::date)
              < (date_trunc('month', current_date) - interval '1 day')::date
       end as statement_behind
     from bank_account a
     join bank b on b.id = a.bank_id
     join email_account e on e.id = a.email_account_id
     left join statement st on st.bank_account_id = a.id
     where a.user_id = $1 and a.archived_at is null
     group by a.id, b.id, e.id
     order by a.nickname`,
    [userId],
  );
  return rows;
}
