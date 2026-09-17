import { Router } from 'express';
import { requireUser } from '../auth.js';
import { query, tx } from '../db.js';
import { HttpError, isoDate, satang, type Body } from '../http.js';
import { audit } from '../services/audit.js';
import {
  projectStudentLoan,
  type Scenario,
  type StudentLoanInput,
  type StudentLoanProjection,
} from '../services/student-loan.js';

export const studentLoanRouter = Router();

type LoanRow = {
  id: number;
  principal_original_satang: number;
  first_due_date: string;
  as_of_date: string;
  principal_remaining_satang: number;
  interest_accrued_satang: number;
  monthly_payment_satang: number;
  monthly_saving_satang: number;
  savings_balance_satang: number;
  app_annual_due_satang: number | null;
  payoff_discount_bp: number;
  payment_day: number;
  created_at: string;
  updated_at: string;
};

const SELECT_COLUMNS = `id, principal_original_satang, first_due_date, as_of_date, principal_remaining_satang,
                        interest_accrued_satang, monthly_payment_satang, monthly_saving_satang,
                        savings_balance_satang, app_annual_due_satang, payoff_discount_bp, payment_day,
                        created_at, updated_at`;

/** ค่า override จาก query string สำหรับ "ลองปรับตัวเลขดู" โดยไม่บันทึกทับของเดิม */
function overrideSatang(q: Record<string, unknown>, field: string, fallback: number): number {
  const v = q[field];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
    throw new HttpError(400, `${field} ต้องเป็นจำนวนเงินที่ถูกต้อง`);
  }
  return n;
}

function toInput(row: LoanRow, q: Record<string, unknown>): StudentLoanInput {
  const discountRaw = q.payoff_discount_bp;
  let discountBp = row.payoff_discount_bp;
  if (discountRaw != null && discountRaw !== '') {
    const n = Number(discountRaw);
    if (!Number.isInteger(n) || n < 0 || n > 10_000) throw new HttpError(400, 'payoff_discount_bp ต้องอยู่ระหว่าง 0–10000');
    discountBp = n;
  }
  return {
    principal_original_satang: row.principal_original_satang,
    first_due_date: row.first_due_date,
    as_of_date: row.as_of_date,
    principal_remaining_satang: row.principal_remaining_satang,
    interest_accrued_satang: row.interest_accrued_satang,
    monthly_payment_satang: overrideSatang(q, 'monthly_payment_satang', row.monthly_payment_satang),
    monthly_saving_satang: overrideSatang(q, 'monthly_saving_satang', row.monthly_saving_satang),
    savings_balance_satang: overrideSatang(q, 'savings_balance_satang', row.savings_balance_satang),
    payoff_discount_bp: discountBp,
    payment_day: row.payment_day,
  };
}

/**
 * คำนวณทั้งสามฉากในคำขอเดียว — เอนจินเป็น pure และตารางยาวสุดแค่ 15 ปี × 12 เดือน
 * จึงถูกกว่าการให้ฝั่ง web ยิงสามรอบ (และ web/ import src/services/ ข้าม vite root ไม่ได้อยู่แล้ว)
 */
function projectAll(input: StudentLoanInput): Record<Scenario, StudentLoanProjection> {
  return {
    lump_sum: projectStudentLoan(input, 'lump_sum'),
    extra_monthly: projectStudentLoan(input, 'extra_monthly'),
    minimum_only: projectStudentLoan(input, 'minimum_only'),
  };
}

async function loadLoan(userId: number): Promise<LoanRow | null> {
  const { rows } = await query<LoanRow>(`select ${SELECT_COLUMNS} from student_loan where user_id = $1`, [userId]);
  return rows[0] ?? null;
}

function respond(res: { json: (b: unknown) => void }, loan: LoanRow | null, q: Record<string, unknown>): void {
  if (loan == null) {
    res.json({ loan: null, input: null, projections: null });
    return;
  }
  const input = toInput(loan, q);
  res.json({ loan, input, projections: projectAll(input) });
}

studentLoanRouter.get(
  '/student-loan',
  requireUser(async (req, res, user) => {
    respond(res, await loadLoan(user.id), req.query as Record<string, unknown>);
  }),
);

studentLoanRouter.put(
  '/student-loan',
  requireUser(async (req, res, user) => {
    const b = req.body as Body;

    const principalOriginal = satang(b, 'principal_original_satang');
    if (principalOriginal <= 0) throw new HttpError(400, 'ยอดกู้ตามสัญญาต้องมากกว่า 0');
    const principalRemaining = satang(b, 'principal_remaining_satang');
    if (principalRemaining > principalOriginal) {
      throw new HttpError(400, 'เงินต้นคงเหลือต้องไม่มากกว่ายอดกู้ตามสัญญา');
    }

    const firstDueDate = isoDate(b, 'first_due_date');
    const asOfDate = isoDate(b, 'as_of_date');

    const discountBp = Number(b.payoff_discount_bp ?? 300);
    if (!Number.isInteger(discountBp) || discountBp < 0 || discountBp > 10_000) {
      throw new HttpError(400, 'ส่วนลดปิดบัญชีต้องอยู่ระหว่าง 0–10000 basis point');
    }
    const paymentDay = Number(b.payment_day ?? 5);
    if (!Number.isInteger(paymentDay) || paymentDay < 1 || paymentDay > 28) {
      throw new HttpError(400, 'วันที่ชำระต้องอยู่ระหว่าง 1–28');
    }

    // ยอดที่แอปแจ้งเป็นตัวเทียบอย่างเดียว ไม่เข้าสูตร ว่างได้
    const appAnnualDue =
      b.app_annual_due_satang == null || b.app_annual_due_satang === '' ? null : satang(b, 'app_annual_due_satang');
    if (appAnnualDue !== null && appAnnualDue <= 0) throw new HttpError(400, 'ยอดครบกำหนดปีนี้ต้องมากกว่า 0');

    const before = await loadLoan(user.id);

    const saved = await tx(async (c) => {
      const { rows } = await c.query<LoanRow>(
        `insert into student_loan
           (user_id, principal_original_satang, first_due_date, as_of_date, principal_remaining_satang,
            interest_accrued_satang, monthly_payment_satang, monthly_saving_satang, savings_balance_satang,
            app_annual_due_satang, payoff_discount_bp, payment_day)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         on conflict (user_id) do update set
           principal_original_satang = excluded.principal_original_satang,
           first_due_date = excluded.first_due_date,
           as_of_date = excluded.as_of_date,
           principal_remaining_satang = excluded.principal_remaining_satang,
           interest_accrued_satang = excluded.interest_accrued_satang,
           monthly_payment_satang = excluded.monthly_payment_satang,
           monthly_saving_satang = excluded.monthly_saving_satang,
           savings_balance_satang = excluded.savings_balance_satang,
           app_annual_due_satang = excluded.app_annual_due_satang,
           payoff_discount_bp = excluded.payoff_discount_bp,
           payment_day = excluded.payment_day,
           updated_at = now()
         returning ${SELECT_COLUMNS}`,
        [
          user.id,
          principalOriginal,
          firstDueDate,
          asOfDate,
          principalRemaining,
          satang(b, 'interest_accrued_satang'),
          satang(b, 'monthly_payment_satang'),
          satang(b, 'monthly_saving_satang'),
          satang(b, 'savings_balance_satang'),
          appAnnualDue,
          discountBp,
          paymentDay,
        ],
      );
      const after = rows[0]!;
      await audit(c, {
        userId: user.id,
        action: before == null ? 'student_loan.create' : 'student_loan.update',
        entityType: 'student_loan',
        entityId: after.id,
        before: before ?? undefined,
        after,
        ip: req.ip ?? null,
      });
      return after;
    });

    res.status(before == null ? 201 : 200);
    respond(res, saved, {});
  }),
);
