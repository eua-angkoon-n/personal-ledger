import { Router } from 'express';
import { requireUser } from '../auth.js';
import { pool, query } from '../db.js';
import { enumStr, HttpError, id, isoDate, pathId, satang, str, type Body } from '../http.js';
import { assertOwnedRefs } from '../services/plan-query.js';

export const recurringRulesRouter = Router();

const KINDS = ['income', 'payroll_deduction', 'expense', 'reserve'] as const;
const AMOUNT_MODES = ['fixed', 'estimated'] as const;
const UNITS = ['day', 'week', 'month', 'year'] as const;

function optionalBoundedInt(b: Body, field: string, min: number, max: number): number | null {
  const v = b[field];
  if (v == null || v === '') return null;
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) {
    throw new HttpError(400, `${field} ต้องเป็นจำนวนเต็ม ${min}-${max}`);
  }
  return v as number;
}

recurringRulesRouter.get('/recurring-rules', requireUser(async (req, res, user) => {
  const isActive = req.query.is_active === 'true' ? true : req.query.is_active === 'false' ? false : null;
  const { rows } = await query(
    `select r.*, c.name as category_name, a.nickname as default_account_nickname
     from recurring_rule r
     left join category c on c.id = r.category_id
     left join bank_account a on a.id = r.default_account_id
     where r.user_id = $1 and ($2::boolean is null or r.is_active = $2)
     order by r.is_active desc, r.kind, r.name`,
    [user.id, isActive],
  );
  res.json(rows);
}));

recurringRulesRouter.post('/recurring-rules', requireUser(async (req, res, user) => {
  const b = req.body as Body;
  const startDate = isoDate(b, 'start_date');
  const endDate = b.end_date == null || b.end_date === '' ? null : isoDate(b, 'end_date');
  if (endDate != null && endDate < startDate) throw new HttpError(400, 'end_date ต้องไม่ก่อน start_date');

  const defaultAccountId =
    b.default_account_id == null || b.default_account_id === '' ? null : id(b, 'default_account_id');
  const categoryId = b.category_id == null || b.category_id === '' ? null : id(b, 'category_id');
  await assertOwnedRefs(pool, user.id, { bankAccountId: defaultAccountId, categoryId });

  const { rows } = await query(
    `insert into recurring_rule
       (user_id, name, kind, amount_mode, amount_satang, frequency_unit, frequency_interval,
        anchor_day, start_date, end_date, default_account_id, category_id)
     values ($1, $2, $3, $4, $5, $6, coalesce($7, 1), $8, $9, $10, $11, $12)
     returning *`,
    [
      user.id,
      str(b, 'name', 120),
      enumStr(b, 'kind', KINDS),
      b.amount_mode == null ? 'fixed' : enumStr(b, 'amount_mode', AMOUNT_MODES),
      satang(b, 'amount_satang'),
      enumStr(b, 'frequency_unit', UNITS),
      optionalBoundedInt(b, 'frequency_interval', 1, 366),
      optionalBoundedInt(b, 'anchor_day', 1, 31),
      startDate,
      endDate,
      defaultAccountId,
      categoryId,
    ],
  );
  res.status(201).json(rows[0]);
}));

// การแก้กฎมีผลเฉพาะรายการในอนาคต (§9.2) — ไม่ต้องทำอะไรเพิ่มที่นี่ เพราะ generateMonthlyItems ข้ามกฎ
// ที่กางลงเดือนนั้นไปแล้วทั้งกฎ รายการของเดือนที่ generate ไปแล้วจึงไม่ถูกแตะ ทั้งเดือนที่เปิดและปิด (§16 ข้อ 16)
// แค่ insert-only ไม่พอ: คีย์กันซ้ำมี occurrence_date อยู่ด้วย แก้ anchor_day จึงเคยได้แถวที่สองของกฎเดิม
//
// anchor_day / end_date / default_account_id / category_id เป็น nullable จึงใช้ท่า hasOwnProperty +
// `case when $k then $v else col end` แบบ routes/accounts.ts แยกจาก coalesce ไม่งั้นตั้งกลับเป็น null ไม่ได้
recurringRulesRouter.patch('/recurring-rules/:id', requireUser(async (req, res, user) => {
  const ruleId = pathId(req);
  const b = req.body as Body;
  const has = (field: string) => Object.prototype.hasOwnProperty.call(b, field);

  const defaultAccountId =
    b.default_account_id == null || b.default_account_id === '' ? null : id(b, 'default_account_id');
  const categoryId = b.category_id == null || b.category_id === '' ? null : id(b, 'category_id');
  await assertOwnedRefs(pool, user.id, { bankAccountId: defaultAccountId, categoryId });

  const { rows } = await query(
    `update recurring_rule set
       name = coalesce($3, name),
       amount_mode = coalesce($4, amount_mode),
       amount_satang = coalesce($5, amount_satang),
       frequency_unit = coalesce($6, frequency_unit),
       frequency_interval = coalesce($7, frequency_interval),
       start_date = coalesce($8, start_date),
       is_active = coalesce($9, is_active),
       anchor_day = case when $10 then $11 else anchor_day end,
       end_date = case when $12 then $13 else end_date end,
       default_account_id = case when $14 then $15 else default_account_id end,
       category_id = case when $16 then $17 else category_id end,
       updated_at = now()
     where id = $1 and user_id = $2
     returning *`,
    [
      ruleId,
      user.id,
      b.name == null ? null : str(b, 'name', 120),
      b.amount_mode == null ? null : enumStr(b, 'amount_mode', AMOUNT_MODES),
      b.amount_satang == null ? null : satang(b, 'amount_satang'),
      b.frequency_unit == null ? null : enumStr(b, 'frequency_unit', UNITS),
      optionalBoundedInt(b, 'frequency_interval', 1, 366),
      b.start_date == null ? null : isoDate(b, 'start_date'),
      typeof b.is_active === 'boolean' ? b.is_active : null,
      has('anchor_day'),
      optionalBoundedInt(b, 'anchor_day', 1, 31),
      has('end_date'),
      b.end_date == null || b.end_date === '' ? null : isoDate(b, 'end_date'),
      has('default_account_id'),
      defaultAccountId,
      has('category_id'),
      categoryId,
    ],
  );
  // end_date < start_date ที่เกิดจากการแก้ทีละฟิลด์ ให้ CHECK constraint ของตารางเป็นคนปฏิเสธ
  // (error handler กลางแปลง 23514 เป็น 400) — เช็คในโค้ดหลัง update แล้ว throw จะ commit ค่าผิดไปก่อน
  const rule = rows[0];
  if (!rule) throw new HttpError(404, 'ไม่พบรายการประจำ');
  res.json(rule);
}));

// archive = ปิดใช้งาน ไม่ลบ — รายการที่เคย generate ไว้ในเดือนก่อน ๆ ต้องคงอยู่เป็นประวัติ
recurringRulesRouter.post('/recurring-rules/:id/archive', requireUser(async (req, res, user) => {
  const { rows } = await query(
    'update recurring_rule set is_active = false, updated_at = now() where id = $1 and user_id = $2 returning *',
    [pathId(req), user.id],
  );
  if (!rows[0]) throw new HttpError(404, 'ไม่พบรายการประจำ');
  res.json(rows[0]);
}));
