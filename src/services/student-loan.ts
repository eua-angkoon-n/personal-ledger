// ตั้งใจไม่ import '../db.js' ที่นี่ — ทั้งไฟล์เป็น pure function เทสต์จึงรันใน `npm test` เฉย ๆ ได้
// (db.ts สร้าง pool ตอน module-load ถ้า import เข้ามาก็ต้องมี Postgres ทุกครั้ง) เหมือน recurring-generation.ts
// helper วันที่ด้านล่างจึงเขียนซ้ำกับตัว private ในไฟล์อื่นโดยเจตนา
//
// กติกา กยศ. ที่โมเดลนี้อิง (สัญญาปีการศึกษา 2566 แบบที่ 4 Step Up + พ.ร.บ. กยศ. (ฉบับที่ 2) พ.ศ. 2566):
// - ผ่อน 15 งวด ครบกำหนดภายใน 5 ก.ค. ของทุกปี เงินต้นแต่ละงวดคิดเป็น % ของ "เงินต้นตามสัญญา" ไม่ใช่คงเหลือ
// - ดอกเบี้ย 1% ต่อปี เดินรายวันบนเงินต้นคงเหลือ (คงเหลือ × 1% ÷ 365) จนกว่าเงินต้นจะหมด
// - งวดแรกจ่ายเฉพาะเงินต้น ไม่มีดอกเบี้ย ดอกเบี้ยเริ่มเดินตั้งแต่วันครบกำหนดงวดแรก
// - ลำดับตัดชำระ: เงินต้นเฉพาะส่วนที่ครบกำหนด → ดอกเบี้ย → เบี้ยปรับ
// - ปิดบัญชีก่อนกำหนดในคราวเดียว ได้ลดเงินต้น (ปัจจุบัน 3%) ไม่รวมดอกเบี้ย

/** ร้อยละของเงินต้นตามสัญญาที่ต้องชำระในงวดที่ 1–15 หน่วยเป็น basis point (ต่อ 10,000) รวมได้ 10,000 พอดี */
export const STEP_UP_BP = [150, 250, 300, 350, 400, 450, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300] as const;

export const TOTAL_INSTALLMENTS = STEP_UP_BP.length;

const BP_DIVISOR = 10_000n;
/** ดอกเบี้ยเดินรายวัน = คงเหลือ × 1% ÷ 365 → ตัวหารรวมของ (สตางค์ × วัน) คือ 10000/100 × 365 */
const INTEREST_DAY_DIVISOR = 36_500n;
const MS_PER_DAY = 86_400_000;
/** กันลูปไม่รู้จบเมื่อยอดจ่ายน้อยกว่าดอกเบี้ยที่เดิน — 50 ปีเกินอายุสัญญาไปมากแล้ว */
const MAX_MONTHS = 600;

export type Scenario = 'lump_sum' | 'extra_monthly' | 'minimum_only';

export type StudentLoanInput = {
  /** ยอดกู้ตามสัญญา = ฐานของ % Step Up */
  principal_original_satang: number;
  /** วันครบกำหนดชำระงวดแรก (5 ก.ค. ปีแรกหลังปลอดหนี้ 2 ปี) */
  first_due_date: string;
  /** วันที่อ่านตัวเลขคงเหลือมาจากแอป กยศ. — ดอกเบี้ยเดินรายวัน จึงต้องรู้ว่าเลขชุดนี้คือ ณ วันไหน */
  as_of_date: string;
  principal_remaining_satang: number;
  interest_accrued_satang: number;
  /** ยอดที่จ่ายจริงต่อเดือน ถ้าต่ำกว่าขั้นต่ำของงวดนั้น ระบบใช้ขั้นต่ำแทน */
  monthly_payment_satang: number;
  /** เงินที่เก็บออมไว้จ่ายก้อนเดียว (ไม่ได้ส่งเข้า กยศ. ระหว่างทาง) */
  monthly_saving_satang: number;
  savings_balance_satang: number;
  /** ส่วนลดเงินต้นเมื่อปิดบัญชีก่อนกำหนด หน่วย basis point (300 = 3%) */
  payoff_discount_bp: number;
  payment_day: number;
};

export type InstallmentRow = {
  installment_no: number;
  due_date: string;
  principal_satang: number;
  interest_satang: number;
  total_satang: number;
  min_monthly_satang: number;
  /** true = งวดที่กำลังอยู่ตอนนี้ (ครบกำหนดไปแล้วก่อน as_of) ใช้เทียบกับยอดที่แอปแจ้ง */
  is_current: boolean;
};

export type MonthRow = {
  date: string;
  installment_no: number;
  opening_principal_satang: number;
  interest_accrued_satang: number;
  paid_satang: number;
  paid_principal_satang: number;
  paid_interest_satang: number;
  closing_principal_satang: number;
  interest_due_satang: number;
  savings_satang: number;
  payoff_quote_satang: number;
};

export type StudentLoanProjection = {
  scenario: Scenario;
  payoff_date: string | null;
  payoff_installment_no: number | null;
  months_remaining: number;
  /** ยอดรวมที่ต้องจ่ายอีกทั้งหมด = งวดรายเดือนทุกงวด + ก้อนปิดบัญชี */
  total_payment_satang: number;
  /** ดอกเบี้ยที่ต้องจ่ายอีกทั้งหมด = ที่ค้างอยู่ ณ วันนี้ + ที่จะเดินต่อจนปิด */
  total_interest_satang: number;
  /** ส่วนลดเงินต้นที่ได้จากการปิดบัญชีก่อนกำหนด (0 = ไม่ได้ปิดก่อนกำหนด) */
  discount_satang: number;
  final_payoff_satang: number;
  monthly: MonthRow[];
  installments: InstallmentRow[];
  /** true = ชนเพดาน 600 เดือนแล้วยังไม่หมด แปลว่ายอดจ่ายไม่พอแม้แต่จะไล่ดอกเบี้ยทัน */
  truncated: boolean;
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return [y, m, d];
}

/** month เป็น 1-based — วันที่ 0 ของเดือนถัดไปคือวันสุดท้ายของเดือนนี้ (ครอบปีอธิกสุรทินให้เอง) */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function iso(year: number, month: number, day: number): string {
  // เลื่อนเดือนให้อยู่ในช่วง 1–12 ก่อน แล้วค่อย clamp วัน (28 ก.พ. / 30 เม.ย.) แบบไม่สะสม
  const y = year + Math.floor((month - 1) / 12);
  const m = ((((month - 1) % 12) + 12) % 12) + 1;
  return `${y}-${pad2(m)}-${pad2(Math.min(day, daysInMonth(y, m)))}`;
}

function toEpochDay(date: string): number {
  const [y, m, d] = parts(date);
  return Date.UTC(y, m - 1, d) / MS_PER_DAY;
}

function daysBetween(from: string, to: string): number {
  return toEpochDay(to) - toEpochDay(from);
}

function addYears(date: string, years: number): string {
  const [y, m, d] = parts(date);
  return iso(y + years, m, d);
}

function addMonths(date: string, months: number): string {
  const [y, m, d] = parts(date);
  return iso(y, m + months, d);
}

function maxDate(a: string, b: string): string {
  return a >= b ? a : b;
}

function bigMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

function assertSatang(value: number, field: string): bigint {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${field} ต้องเป็นจำนวนเต็มสตางค์ที่ไม่ติดลบ ได้ ${value}`);
  return BigInt(value);
}

function assertDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} ต้องเป็นวันที่รูปแบบ YYYY-MM-DD ได้ ${value}`);
  return value;
}

/**
 * งวดที่ครบกำหนดล่าสุด ณ วันที่ `on` — 0 แปลว่ายังไม่ถึงงวดแรก (ยังอยู่ในช่วงปลอดหนี้)
 * เกิน 15 แปลว่าเลยอายุสัญญาแล้ว ทั้งก้อนครบกำหนด
 */
export function installmentNoOn(firstDueDate: string, on: string): number {
  if (on < firstDueDate) return 0;
  const [fy, fm, fd] = parts(firstDueDate);
  const [oy, om, od] = parts(on);
  // ครบรอบปีเมื่อถึงวัน-เดือนเดิม (วันครบกำหนดเป็น 5 ก.ค. จึงไม่เจอเคส clamp สิ้นเดือน)
  const passedAnniversary = om > fm || (om === fm && od >= fd);
  return oy - fy + (passedAnniversary ? 1 : 0);
}

/** เงินต้นตามตาราง Step Up ของงวดที่ n (1-based) — งวดเกิน 15 ไม่มีตารางแล้ว คืน 0n */
function scheduledPrincipal(principalOriginal: bigint, n: number): bigint {
  const bp = STEP_UP_BP[n - 1];
  if (bp === undefined) return 0n;
  return (principalOriginal * BigInt(bp)) / BP_DIVISOR;
}

/**
 * คำนวณแผนปลดหนี้ กยศ. เดินทีละเดือนจาก `as_of_date` จนปิดบัญชีได้หรือเงินต้นหมด
 *
 * สามฉาก:
 * - `lump_sum`      จ่าย กยศ. รายเดือนตามปกติ + เก็บออมไว้ต่างหาก แล้วปิดบัญชีทีเดียวเมื่อเงินออมพอ
 * - `extra_monthly` เอาเงินที่จะเก็บออมโปะเข้า กยศ. ทุกเดือนแทน
 * - `minimum_only`  จ่ายขั้นต่ำตามตารางอย่างเดียวจนครบ 15 งวด
 *
 * ทุกฉากถูกบังคับว่าอย่างน้อยต้องจ่ายขั้นต่ำของงวดนั้น เพราะเงินต้นตามตาราง Step Up
 * เพิ่มขึ้นทุกปี ขั้นต่ำจึงไม่ใช่ค่าคงที่ — จุดนี้พลาดแล้วตัวเลขเพี้ยนทั้งแผน
 */
export function projectStudentLoan(input: StudentLoanInput, scenario: Scenario = 'lump_sum'): StudentLoanProjection {
  const principalOriginal = assertSatang(input.principal_original_satang, 'principal_original_satang');
  const firstDueDate = assertDate(input.first_due_date, 'first_due_date');
  const asOfDate = assertDate(input.as_of_date, 'as_of_date');
  const monthlyPayment = assertSatang(input.monthly_payment_satang, 'monthly_payment_satang');
  const monthlySaving = assertSatang(input.monthly_saving_satang, 'monthly_saving_satang');
  const discountBp = BigInt(input.payoff_discount_bp);
  if (input.payoff_discount_bp < 0 || input.payoff_discount_bp > 10_000) {
    throw new Error(`payoff_discount_bp ต้องอยู่ระหว่าง 0–10000 ได้ ${input.payoff_discount_bp}`);
  }
  if (!Number.isInteger(input.payment_day) || input.payment_day < 1 || input.payment_day > 28) {
    throw new Error(`payment_day ต้องอยู่ระหว่าง 1–28 ได้ ${input.payment_day}`);
  }

  let principalRemaining = assertSatang(input.principal_remaining_satang, 'principal_remaining_satang');
  let interestDue = assertSatang(input.interest_accrued_satang, 'interest_accrued_satang');
  let savings = assertSatang(input.savings_balance_satang, 'savings_balance_satang');

  // เริ่มที่ 0n โดยเจตนา: จากตัวเลขที่ผู้ใช้กรอกไม่มีทางรู้ว่าเงินที่จ่ายไปแล้วในงวดปัจจุบัน
  // ถูกตัดเป็นเงินต้นเท่าไหร่ ดอกเบี้ยเท่าไหร่ และมันกระทบแค่ลำดับตัดชำระระดับสตางค์
  // ไม่กระทบเดือนที่ปิดหนี้ ซึ่งขึ้นกับเงินต้นคงเหลือ + ดอกเบี้ย + ยอดจ่าย + เงินออม เท่านั้น
  let principalDue = 0n;
  // ตัวสะสมหน่วย (สตางค์ × วัน) หารด้วย 36500 ตอนตัดยอดเท่านั้น เศษเก็บไว้ต่อ ไม่ใช้ float ไม่ใช้เศษส่วนของเดือน
  let interestScaled = 0n;

  const lastDueDate = addYears(firstDueDate, TOTAL_INSTALLMENTS - 1);
  const currentNo = installmentNoOn(firstDueDate, asOfDate);
  let nextNo = currentNo + 1;

  const installments: InstallmentRow[] = [];
  const monthly: MonthRow[] = [];

  // ขั้นต่ำต่อเดือนของงวดที่กำลังอยู่ — คิดจากตารางกับคงเหลือ ณ วันนี้
  const currentScheduled =
    currentNo === 0 ? 0n : currentNo >= TOTAL_INSTALLMENTS ? principalRemaining : scheduledPrincipal(principalOriginal, currentNo);
  // งวดแรกตามสัญญาจ่ายเฉพาะเงินต้น ไม่มีดอกเบี้ย (ดอกเบี้ยเริ่มเดินนับจากวันครบกำหนดงวดแรกเป็นต้นไป)
  const currentInterestQuote = currentNo <= 1 ? 0n : principalRemaining / 100n;
  let minMonthly = ceilDiv(currentScheduled + currentInterestQuote, 12n);

  if (currentNo >= 1) {
    // แถวงวดปัจจุบันเป็นใบเสนอยอดย้อนหลัง ไว้ให้ผู้ใช้เทียบกับยอดที่แอป กยศ. แจ้ง
    installments.push({
      installment_no: currentNo,
      due_date: addYears(firstDueDate, currentNo - 1),
      principal_satang: Number(currentScheduled),
      interest_satang: Number(currentInterestQuote),
      total_satang: Number(currentScheduled + currentInterestQuote),
      min_monthly_satang: Number(minMonthly),
      is_current: true,
    });
  }

  let cursor = asOfDate;
  let totalPaid = 0n;
  let totalInterest = interestDue;
  let payoffDate: string | null = null;
  let payoffInstallmentNo: number | null = null;
  let discount = 0n;
  let finalPayoff = 0n;
  let truncated = false;

  /** ทบดอกเบี้ยจาก cursor ถึง target — ไม่เดินก่อนวันครบกำหนดงวดแรก (ช่วงปลอดหนี้ไม่มีดอกเบี้ย) */
  const accrueTo = (target: string): void => {
    const from = maxDate(cursor, firstDueDate);
    if (principalRemaining > 0n && target > from) {
      interestScaled += BigInt(daysBetween(from, target)) * principalRemaining;
    }
    cursor = target;
  };

  /** แปลงตัวสะสมเป็นสตางค์ เศษที่ยังไม่ครบหนึ่งสตางค์ยกไปรอบถัดไป */
  const settleInterest = (): bigint => {
    const gained = interestScaled / INTEREST_DAY_DIVISOR;
    interestScaled -= gained * INTEREST_DAY_DIVISOR;
    interestDue += gained;
    totalInterest += gained;
    return gained;
  };

  /**
   * ยอดปิดบัญชี ณ วันหนึ่ง — ส่วนลดเงินต้นให้เฉพาะการปิด "ก่อนกำหนด" คือก่อนวันครบกำหนดงวดสุดท้าย
   * จ่ายงวดที่ 15 ตามตารางจนจบไม่ใช่การปิดก่อนกำหนด จึงไม่ได้ส่วนลด
   */
  const payoffQuote = (on: string): bigint => {
    if (on >= lastDueDate) return principalRemaining + interestDue;
    return (principalRemaining * (BP_DIVISOR - discountBp)) / BP_DIVISOR + interestDue;
  };

  for (let step = 0; step < MAX_MONTHS; step += 1) {
    if (principalRemaining === 0n && interestDue === 0n) break;

    // วันจ่ายถัดไปหลัง cursor
    const [cy, cm] = parts(cursor);
    let paymentDate = iso(cy, cm, input.payment_day);
    if (paymentDate <= cursor) paymentDate = addMonths(paymentDate, 1);

    // วันครบกำหนดงวดที่คั่นอยู่ระหว่าง cursor กับวันจ่าย ต้องทบดอกเบี้ยถึงตรงนั้นก่อนแล้วค่อยเพิ่มเงินต้นครบกำหนด
    while (nextNo <= TOTAL_INSTALLMENTS) {
      const dueDate = addYears(firstDueDate, nextNo - 1);
      if (dueDate > paymentDate) break;
      accrueTo(dueDate);
      settleInterest();

      const scheduled =
        nextNo === TOTAL_INSTALLMENTS ? principalRemaining : scheduledPrincipal(principalOriginal, nextNo);
      const added = bigMin(scheduled, principalRemaining - principalDue);
      principalDue += added;
      // งวดแรกจ่ายเฉพาะเงินต้น ไม่มีดอกเบี้ย ตามสัญญา
      const interestQuote = nextNo === 1 ? 0n : principalRemaining / 100n;
      minMonthly = ceilDiv(added + interestQuote, 12n);
      installments.push({
        installment_no: nextNo,
        due_date: dueDate,
        principal_satang: Number(added),
        interest_satang: Number(interestQuote),
        total_satang: Number(added + interestQuote),
        min_monthly_satang: Number(minMonthly),
        is_current: false,
      });
      nextNo += 1;
    }
    // เลยงวดสุดท้ายแล้วยังไม่หมด = ทั้งก้อนครบกำหนด
    if (nextNo > TOTAL_INSTALLMENTS && paymentDate >= lastDueDate) principalDue = principalRemaining;

    const openingPrincipal = principalRemaining;
    accrueTo(paymentDate);
    const monthInterest = settleInterest();

    if (scenario === 'lump_sum') savings += monthlySaving;

    // ยอดที่ส่งเข้า กยศ. เดือนนี้ — ขั้นต่ำของงวดเป็นพื้นเสมอ เพราะเงินต้นตามตาราง Step Up
    // เพิ่มขึ้นทุกปี ขั้นต่ำจึงไม่ใช่ค่าคงที่ (750 เป็นขั้นต่ำของปีนี้เท่านั้น)
    const scenarioPayment =
      scenario === 'minimum_only'
        ? minMonthly
        : scenario === 'extra_monthly'
          ? bigMax(monthlyPayment + monthlySaving, minMonthly)
          : bigMax(monthlyPayment, minMonthly);

    const quote = payoffQuote(paymentDate);
    // เงินที่พร้อมปิดบัญชีทีเดียวในเดือนนี้ — ฉากเก็บออมใช้กองที่เก็บไว้ ฉากโปะใช้ยอดจ่ายของเดือนนั้น
    // ฉากจ่ายขั้นต่ำไม่เคยปิดก่อนกำหนด เพราะเดินตามตารางจนครบ 15 งวดอยู่แล้ว
    const closingFund = scenario === 'lump_sum' ? savings : scenario === 'extra_monthly' ? scenarioPayment : 0n;

    if (principalRemaining > 0n && closingFund >= quote) {
      // ปิดบัญชี: จ่ายตามใบเสนอยอด แล้วยอดหนี้เป็นศูนย์ ส่วนต่างคือส่วนลดเงินต้นที่ได้รับ
      discount = principalRemaining + interestDue - quote;
      finalPayoff = quote;
      totalPaid += quote;
      payoffDate = paymentDate;
      payoffInstallmentNo = installmentNoOn(firstDueDate, paymentDate);
      if (scenario === 'lump_sum') savings -= quote;
      monthly.push({
        date: paymentDate,
        installment_no: payoffInstallmentNo,
        opening_principal_satang: Number(openingPrincipal),
        interest_accrued_satang: Number(monthInterest),
        paid_satang: Number(quote),
        paid_principal_satang: Number(principalRemaining),
        paid_interest_satang: Number(interestDue),
        closing_principal_satang: 0,
        interest_due_satang: 0,
        savings_satang: Number(savings),
        payoff_quote_satang: Number(quote),
      });
      principalRemaining = 0n;
      principalDue = 0n;
      interestDue = 0n;
      break;
    }

    const pay = bigMin(scenarioPayment, principalRemaining + interestDue);

    // ลำดับตัดชำระตาม พ.ร.บ. 2566: เงินต้นเฉพาะส่วนที่ครบกำหนด → ดอกเบี้ย → (ส่วนเกิน) โปะเงินต้น
    let rest = pay;
    const toPrincipalDue = bigMin(rest, principalDue);
    principalDue -= toPrincipalDue;
    principalRemaining -= toPrincipalDue;
    rest -= toPrincipalDue;

    const toInterest = bigMin(rest, interestDue);
    interestDue -= toInterest;
    rest -= toInterest;

    const toPrepay = bigMin(rest, principalRemaining);
    principalRemaining -= toPrepay;
    rest -= toPrepay;
    if (principalDue > principalRemaining) principalDue = principalRemaining;

    const paidPrincipal = toPrincipalDue + toPrepay;
    totalPaid += pay - rest;

    monthly.push({
      date: paymentDate,
      installment_no: installmentNoOn(firstDueDate, paymentDate),
      opening_principal_satang: Number(openingPrincipal),
      interest_accrued_satang: Number(monthInterest),
      paid_satang: Number(pay - rest),
      paid_principal_satang: Number(paidPrincipal),
      paid_interest_satang: Number(toInterest),
      closing_principal_satang: Number(principalRemaining),
      interest_due_satang: Number(interestDue),
      savings_satang: Number(savings),
      // ใบเสนอยอด ณ ตอนตัดสินใจ (ก่อนจ่ายงวดเดือนนี้) ให้ตรงกับที่เอาไปเทียบกับคอลัมน์เงินออม
      // ถ้าใช้ยอดหลังจ่าย แถวจะดูเหมือนเงินออมพอปิดแล้วแต่ระบบไม่ปิด
      payoff_quote_satang: Number(quote),
    });

    if (principalRemaining === 0n && interestDue === 0n) {
      payoffDate = paymentDate;
      payoffInstallmentNo = installmentNoOn(firstDueDate, paymentDate);
      break;
    }

    if (step === MAX_MONTHS - 1) truncated = true;
  }

  return {
    scenario,
    payoff_date: payoffDate,
    payoff_installment_no: payoffInstallmentNo,
    months_remaining: monthly.length,
    total_payment_satang: Number(totalPaid),
    total_interest_satang: Number(totalInterest),
    discount_satang: Number(discount),
    final_payoff_satang: Number(finalPayoff),
    monthly,
    installments,
    truncated,
  };
}
