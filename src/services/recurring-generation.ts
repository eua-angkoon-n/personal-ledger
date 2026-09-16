import type { Pool, PoolClient } from 'pg';

type Queryable = Pick<Pool | PoolClient, 'query'>;

// ตั้งใจไม่ import '../db.js' ที่นี่ — โมดูลนี้มีฟังก์ชัน pure ที่ test รันได้ใน `npm test` เฉย ๆ
// (db.ts สร้าง pool ตอน module-load จาก env.databaseUrl ถ้า import เข้ามาก็ต้องมี Postgres ทุกครั้ง)
// เพราะฉะนั้น helper วันที่ด้านล่างจึงเขียนซ้ำกับตัว private ใน report-query.ts โดยเจตนา

export type RecurrenceSpec = {
  frequency_unit: 'day' | 'week' | 'month' | 'year';
  frequency_interval: number;
  anchor_day: number | null;
  start_date: string;
  end_date: string | null;
};

const MS_PER_DAY = 86_400_000;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return [y, m, d];
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** month เป็น 1-based — วันที่ 0 ของเดือนถัดไปคือวันสุดท้ายของเดือนนี้ (ครอบปีอธิกสุรทินให้เอง) */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthIndexOf(monthStart: string): number {
  const [y, m] = parts(monthStart);
  return y * 12 + (m - 1);
}

// เดือนปัจจุบันตาม local time ของ process (deploy จริงตั้ง TZ=Asia/Bangkok) เหมือน report-query.ts
function currentMonthIndex(): number {
  const now = new Date();
  return now.getFullYear() * 12 + now.getMonth();
}

function toEpochDay(date: string): number {
  const [y, m, d] = parts(date);
  return Date.UTC(y, m - 1, d) / MS_PER_DAY;
}

function fromEpochDay(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * วันครบกำหนดทั้งหมดของกฎหนึ่งข้อที่ตกอยู่ในเดือน `monthStart` ('YYYY-MM-01')
 *
 * เลขคณิตวันที่แบบ string ล้วน ไม่ผูก timezone (เหมือน report-query.ts) เพราะเราจัดการแต่ calendar date
 * - month/year: นับรอบจากเดือนของ `start_date`, ใช้ `anchor_day` (ไม่ระบุ = วันของ start_date) แล้ว
 *   clamp ลงวันสุดท้ายของเดือนเป้าหมายเมื่อเดือนนั้นไม่มีวันนั้น (§9.2) — clamp ต่อเดือน ไม่สะสม
 *   จึงไม่ drift: 31 ม.ค. → 28 ก.พ. → 31 มี.ค. ไม่ใช่ 28 ก.พ. → 28 มี.ค.
 * - day/week: ไม่สน `anchor_day` เดินจาก `start_date` ทีละ interval (×7 ถ้า week) และกระโดดถึง
 *   occurrence แรกในเดือนด้วยเลขคณิต ไม่ loop จาก start_date ที่อาจห่างเป็นปี
 */
export function occurrencesInMonth(rule: RecurrenceSpec, monthStart: string): string[] {
  if (!Number.isInteger(rule.frequency_interval) || rule.frequency_interval < 1) {
    throw new Error(`frequency_interval ต้องเป็นจำนวนเต็มบวก ได้ ${rule.frequency_interval}`);
  }

  const [monthYear, monthNo] = parts(monthStart);
  const monthEnd = iso(monthYear, monthNo, daysInMonth(monthYear, monthNo));
  const from = rule.start_date > monthStart ? rule.start_date : monthStart;
  const to = rule.end_date != null && rule.end_date < monthEnd ? rule.end_date : monthEnd;
  if (from > to) return [];

  if (rule.frequency_unit === 'day' || rule.frequency_unit === 'week') {
    const step = rule.frequency_interval * (rule.frequency_unit === 'week' ? 7 : 1);
    const startDay = toEpochDay(rule.start_date);
    const toDay = toEpochDay(to);
    const skipped = Math.max(0, Math.ceil((toEpochDay(from) - startDay) / step));
    const out: string[] = [];
    for (let day = startDay + skipped * step; day <= toDay; day += step) out.push(fromEpochDay(day));
    return out;
  }

  const [startYear, startMonth, startDayOfMonth] = parts(rule.start_date);
  const elapsed =
    rule.frequency_unit === 'year'
      ? monthNo === startMonth
        ? monthYear - startYear
        : -1
      : (monthYear - startYear) * 12 + (monthNo - startMonth);
  if (elapsed < 0 || elapsed % rule.frequency_interval !== 0) return [];

  const anchor = rule.anchor_day ?? startDayOfMonth;
  const due = iso(monthYear, monthNo, Math.min(anchor, daysInMonth(monthYear, monthNo)));
  return due >= from && due <= to ? [due] : [];
}

type ActiveRule = RecurrenceSpec & {
  id: number;
  kind: string;
  name: string;
  amount_satang: number;
  category_id: number | null;
};

/**
 * กางรายการประจำของ user ลงในแผนเดือนหนึ่ง — **insert-only** เท่านั้น
 *
 * `on conflict do nothing` ชน `monthly_plan_item_rule_uniq` ทำให้เรียกซ้ำได้ไม่เกิดแถวซ้ำ (§9.2, §16 ข้อ 15)
 * และห้ามเปลี่ยนเป็น upsert เด็ดขาด: การแก้ยอด/ชื่อของ rule ต้องมีผลกับเดือนที่ยัง generate ไม่ถึงเท่านั้น
 * ไม่ย้อนแก้เดือนที่ผู้ใช้ตรวจหรือปิดไปแล้ว (§9.2, §16 ข้อ 16)
 *
 * **ข้ามกฎที่กางลงเดือนนี้ไปแล้ว**: insert-only กันการ *แก้* แถวเดิมได้ แต่ไม่กันการ *เพิ่ม* แถวใหม่
 * — คีย์กันซ้ำมี `occurrence_date` อยู่ด้วย แก้ `anchor_day` 1 → 23 แล้วเปิดเดือนเดิมซ้ำจึงได้ทั้ง
 * วันที่ 1 และ 23 เป็นแถวซ้ำที่ผู้ใช้ลบเองไม่ได้ (เจอจริงกับกฎ "ค่าน้ำ ค่าไฟ" 2026-09 ถึง 2026-12)
 * เดือนไหนมีแถวของกฎข้อนั้นอยู่แล้ว = generate ไปแล้ว ข้ามทั้งกฎ ตรงตาม §9.2 "การแก้ Recurring Rule
 * มีผลเฉพาะรายการในอนาคต" ผลที่ตามมา: แก้กฎแล้วอยากให้เดือนที่เปิดดูไปแล้วเปลี่ยนตาม ต้องลบรายการ
 * ของกฎนั้นในเดือนนั้นทิ้ง (DELETE /monthly-plan-items/:id) แล้ว GET ใหม่จะกางตามกฎปัจจุบันให้
 *
 * **ไม่ generate ย้อนเดือนที่ผ่านไปแล้ว**: เดือนที่ผ่านไปแล้วออกตั้งแต่บรรทัดแรก
 * ผลที่ยอมรับ: สร้างกฎวันนี้แล้วเปิดดูเดือนก่อน ๆ จะไม่มีรายการย้อนหลังให้ ซึ่งตรงตามสเปก
 *
 * เขียน `occurrence_date` (คีย์กันซ้ำที่ผู้ใช้แก้ไม่ได้) พร้อม `due_date` ที่ผู้ใช้เลื่อนได้ทีหลัง
 *
 * คืนจำนวนแถวที่เพิ่มจริง (0 = ไม่มีอะไรใหม่ ซึ่งเป็นเคสปกติเวลาเปิดหน้าเดิมซ้ำ)
 */
export async function generateMonthlyItems(
  db: Queryable,
  userId: number,
  planId: number,
  monthStart: string,
): Promise<number> {
  if (monthIndexOf(monthStart) < currentMonthIndex()) return 0;

  const [year, month] = parts(monthStart);
  const monthEnd = iso(year, month, daysInMonth(year, month));

  // start_date/end_date กลับมาเป็น string 'YYYY-MM-DD' ตาม type parser ใน src/db.ts
  const { rows } = await db.query<ActiveRule>(
    `select id, kind, name, amount_satang, category_id,
            frequency_unit, frequency_interval, anchor_day, start_date, end_date
     from recurring_rule
     where user_id = $1
       and is_active
       and start_date <= $2
       and (end_date is null or end_date >= $3)
     order by id`,
    [userId, monthEnd, monthStart],
  );

  const { rows: done } = await db.query<{ recurring_rule_id: number }>(
    `select distinct recurring_rule_id from monthly_plan_item
     where monthly_plan_id = $1 and recurring_rule_id is not null`,
    [planId],
  );
  const materialized = new Set(done.map((d) => d.recurring_rule_id));

  let inserted = 0;
  for (const r of rows) {
    if (materialized.has(r.id)) continue;
    for (const dueDate of occurrencesInMonth(r, monthStart)) {
      const res = await db.query(
        `insert into monthly_plan_item
           (monthly_plan_id, recurring_rule_id, kind, name, category_id, planned_amount_satang,
            occurrence_date, due_date)
         values ($1, $2, $3, $4, $5, $6, $7, $7)
         on conflict do nothing`,
        [planId, r.id, r.kind, r.name, r.category_id, r.amount_satang, dueDate],
      );
      inserted += res.rowCount ?? 0;
    }
  }
  return inserted;
}
