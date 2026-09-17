// แผนปลดหนี้ กยศ. — โมดูล pure ไม่แตะ DB (src/services/student-loan.ts ตั้งใจไม่ import src/db.js)
// จึงรันใน `npm test` เฉย ๆ ได้เหมือน recurring.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STEP_UP_BP,
  TOTAL_INSTALLMENTS,
  installmentNoOn,
  projectStudentLoan,
  type StudentLoanInput,
} from '../src/services/student-loan.js';

const BAHT = 100;

/** เงินกู้ 100,000 บาท ครบกำหนดงวดแรก 5 ก.ค. 2020 ตัวเลขกลม ๆ ให้เช็คเปอร์เซ็นต์ด้วยตาได้ */
function loan(over: Partial<StudentLoanInput> = {}): StudentLoanInput {
  return {
    principal_original_satang: 100_000 * BAHT,
    first_due_date: '2020-07-05',
    as_of_date: '2020-07-05',
    principal_remaining_satang: 100_000 * BAHT,
    interest_accrued_satang: 0,
    monthly_payment_satang: 0,
    monthly_saving_satang: 0,
    savings_balance_satang: 0,
    payoff_discount_bp: 300,
    payment_day: 5,
    ...over,
  };
}

test('STEP_UP_BP', async (t) => {
  await t.test('ตาราง Step Up 15 งวดรวมได้ 100% พอดี', () => {
    assert.equal(TOTAL_INSTALLMENTS, 15);
    assert.equal(
      STEP_UP_BP.reduce((a, b) => a + b, 0),
      10_000,
    );
  });

  await t.test('เรียงจากน้อยไปมาก เงินต้นที่ต้องจ่ายต่อปีเพิ่มขึ้นเรื่อย ๆ ไม่มีปีไหนลดลง', () => {
    for (let i = 1; i < STEP_UP_BP.length; i += 1) {
      assert.ok(STEP_UP_BP[i]! > STEP_UP_BP[i - 1]!, `งวด ${i + 1} ต้องมากกว่างวด ${i}`);
    }
  });
});

test('installmentNoOn', async (t) => {
  await t.test('ก่อนวันครบกำหนดงวดแรก = 0 (ยังปลอดหนี้)', () => {
    assert.equal(installmentNoOn('2020-07-05', '2020-07-04'), 0);
    assert.equal(installmentNoOn('2020-07-05', '2019-12-31'), 0);
  });

  await t.test('นับงวดตามรอบปีของวันครบกำหนด ไม่ใช่ปีปฏิทิน', () => {
    assert.equal(installmentNoOn('2020-07-05', '2020-07-05'), 1);
    assert.equal(installmentNoOn('2020-07-05', '2021-07-04'), 1);
    assert.equal(installmentNoOn('2020-07-05', '2021-07-05'), 2);
    assert.equal(installmentNoOn('2020-07-05', '2026-09-17'), 7);
  });
});

test('projectStudentLoan', async (t) => {
  await t.test('งวดแรกจ่ายเฉพาะเงินต้น ไม่มีดอกเบี้ย', () => {
    // as_of ก่อนวันครบกำหนดงวดแรก ระบบจึงได้ออกใบเสนอยอดงวดที่ 1 ให้ดู
    const p = projectStudentLoan(loan({ as_of_date: '2020-06-05', monthly_payment_satang: 0 }), 'minimum_only');
    const first = p.installments.find((r) => r.installment_no === 1)!;
    assert.equal(first.interest_satang, 0, 'งวดแรกต้องไม่มีดอกเบี้ยตามสัญญา');
    assert.equal(first.principal_satang, 1_500 * BAHT, '1.5% ของ 100,000');
    assert.equal(first.total_satang, 1_500 * BAHT);
    // งวดที่ 2 เป็นต้นไปถึงจะมีดอกเบี้ย
    assert.ok(p.installments.find((r) => r.installment_no === 2)!.interest_satang > 0);
  });

  await t.test('ดอกเบี้ยเดินรายวันตามวันจริงในปฏิทิน ไม่ใช่ 1/12 ต่อเดือน', () => {
    // คงเหลือ 100,000 บาท = 10,000,000 สตางค์ → ดอกเบี้ยหนึ่งวัน = 10,000,000 / 36,500
    const jan = projectStudentLoan(
      loan({ as_of_date: '2021-01-05', principal_remaining_satang: 100_000 * BAHT, monthly_payment_satang: 0 }),
      'lump_sum',
    );
    const feb = projectStudentLoan(
      loan({ as_of_date: '2021-02-05', principal_remaining_satang: 100_000 * BAHT, monthly_payment_satang: 0 }),
      'lump_sum',
    );
    // ม.ค. → ก.พ. = 31 วัน, ก.พ. → มี.ค. = 28 วัน (ปี 2021 ไม่ใช่อธิกสุรทิน)
    assert.equal(jan.monthly[0]!.interest_accrued_satang, Math.floor((10_000_000 * 31) / 36_500));
    assert.equal(feb.monthly[0]!.interest_accrued_satang, Math.floor((10_000_000 * 28) / 36_500));
    // ถ้าใครเปลี่ยนไปใช้ 1/12 ต่อเดือน สองค่านี้จะเท่ากันที่ 8,333 สตางค์
    assert.notEqual(jan.monthly[0]!.interest_accrued_satang, feb.monthly[0]!.interest_accrued_satang);
    assert.notEqual(jan.monthly[0]!.interest_accrued_satang, Math.floor(10_000_000 / 12 / 100) * 100);
  });

  await t.test('เงินต้นแต่ละงวดคิดจากเงินต้นตามสัญญา ไม่ใช่คงเหลือ — ตรงตาราง Step Up ทุกงวด', () => {
    const p = projectStudentLoan(loan({ monthly_payment_satang: 0 }), 'lump_sum');
    const future = p.installments.filter((r) => !r.is_current);
    for (const row of future.slice(0, 5)) {
      const expected = (100_000 * BAHT * STEP_UP_BP[row.installment_no - 1]!) / 10_000;
      assert.equal(row.principal_satang, expected, `งวด ${row.installment_no}`);
    }
  });

  await t.test('ขั้นต่ำต่อเดือนเพิ่มขึ้นทุกปีตามตาราง ไม่ใช่ค่าคงที่', () => {
    const p = projectStudentLoan(loan({ monthly_payment_satang: 0 }), 'lump_sum');
    const future = p.installments.filter((r) => !r.is_current && r.installment_no <= 7);
    for (let i = 1; i < future.length; i += 1) {
      assert.ok(
        future[i]!.min_monthly_satang > future[i - 1]!.min_monthly_satang,
        `ขั้นต่ำงวด ${future[i]!.installment_no} ต้องมากกว่างวด ${future[i - 1]!.installment_no}`,
      );
    }
  });

  await t.test('ยอดจ่ายจริงต่ำกว่าขั้นต่ำของงวด → ระบบใช้ขั้นต่ำแทน', () => {
    // งวด 2 = 2.5% ของ 100,000 = 2,500 + ดอกเบี้ย → ขั้นต่ำ ~210/เดือน ตั้งจ่ายจริงแค่ 1 บาท
    const p = projectStudentLoan(
      loan({ as_of_date: '2021-07-05', principal_remaining_satang: 98_500 * BAHT, monthly_payment_satang: 1 * BAHT }),
      'lump_sum',
    );
    const row = p.monthly[0]!;
    assert.ok(row.paid_satang > 1 * BAHT, `จ่ายจริงต้องถูกดันขึ้นเป็นขั้นต่ำ ได้ ${row.paid_satang}`);
    const quoted = p.installments.find((r) => r.is_current)!;
    assert.equal(row.paid_satang, quoted.min_monthly_satang);
  });

  await t.test('ลำดับตัดชำระ: จ่ายไม่ถึงเงินต้นที่ครบกำหนด ดอกเบี้ยค้างไม่ลดเลย', () => {
    // ค้างดอกเบี้ยไว้ 500 บาท แล้วจ่ายน้อยกว่าเงินต้นงวดที่เพิ่งครบกำหนด
    const p = projectStudentLoan(
      loan({
        as_of_date: '2021-07-04',
        principal_remaining_satang: 98_500 * BAHT,
        interest_accrued_satang: 500 * BAHT,
        monthly_payment_satang: 100 * BAHT,
      }),
      'lump_sum',
    );
    const row = p.monthly[0]!;
    assert.equal(row.paid_interest_satang, 0, 'ต้องตัดเงินต้นก่อนจนหมดแล้วค่อยถึงดอกเบี้ย');
    assert.ok(row.interest_due_satang >= 500 * BAHT);
  });

  await t.test('ส่วนเกินโปะเงินต้น แล้วดอกเบี้ยเดือนถัดไปลดลงจริง', () => {
    const base = projectStudentLoan(
      loan({ as_of_date: '2021-08-05', principal_remaining_satang: 98_500 * BAHT, monthly_payment_satang: 300 * BAHT }),
      'lump_sum',
    );
    const prepaid = projectStudentLoan(
      loan({
        as_of_date: '2021-08-05',
        principal_remaining_satang: 98_500 * BAHT,
        monthly_payment_satang: 30_000 * BAHT,
      }),
      'lump_sum',
    );
    assert.ok(
      prepaid.monthly[1]!.interest_accrued_satang < base.monthly[1]!.interest_accrued_satang,
      'โปะเงินต้นก้อนใหญ่แล้วดอกเบี้ยเดือนถัดไปต้องน้อยลง',
    );
    assert.ok(prepaid.monthly[0]!.closing_principal_satang < 70_000 * BAHT);
  });

  await t.test('ปิดบัญชีทีเดียว: ส่วนลด 3% คิดจากเงินต้น ไม่ใช่จากยอดรวมกับดอกเบี้ย', () => {
    const input = loan({
      as_of_date: '2021-08-05',
      principal_remaining_satang: 50_000 * BAHT,
      interest_accrued_satang: 1_000 * BAHT,
      monthly_payment_satang: 0,
      monthly_saving_satang: 0,
      savings_balance_satang: 100_000 * BAHT, // พอปิดทันทีในเดือนแรก
    });
    const p = projectStudentLoan(input, 'lump_sum');
    assert.equal(p.months_remaining, 1);
    const closing = p.monthly[0]!;
    // ส่วนลด = 3% ของเงินต้นคงเหลือ ณ วันปิด ดอกเบี้ยไม่ได้ลด
    assert.equal(p.discount_satang, closing.paid_principal_satang * 0.03);
    assert.equal(p.final_payoff_satang, closing.paid_principal_satang * 0.97 + closing.paid_interest_satang);
  });

  await t.test('ส่วนลด 0% แล้วยอดปิดบัญชีต้องแพงขึ้นเท่ากับส่วนลดที่หายไปพอดี', () => {
    const base = loan({
      as_of_date: '2021-08-05',
      principal_remaining_satang: 50_000 * BAHT,
      savings_balance_satang: 100_000 * BAHT,
    });
    const withDiscount = projectStudentLoan(base, 'lump_sum');
    const without = projectStudentLoan({ ...base, payoff_discount_bp: 0 }, 'lump_sum');
    assert.equal(without.discount_satang, 0);
    assert.equal(without.final_payoff_satang - withDiscount.final_payoff_satang, withDiscount.discount_satang);
    assert.equal(withDiscount.discount_satang, 50_000 * BAHT * 0.03);
  });

  await t.test('เก็บออมมากขึ้น ปิดหนี้ได้เร็วขึ้นและจ่ายรวมน้อยลง', () => {
    const base = loan({
      as_of_date: '2026-09-17',
      principal_remaining_satang: 60_000 * BAHT,
      interest_accrued_satang: 300 * BAHT,
      monthly_payment_satang: 750 * BAHT,
    });
    const slow = projectStudentLoan({ ...base, monthly_saving_satang: 7_000 * BAHT }, 'lump_sum');
    const fast = projectStudentLoan({ ...base, monthly_saving_satang: 10_000 * BAHT }, 'lump_sum');
    assert.ok(slow.payoff_date !== null && fast.payoff_date !== null);
    assert.ok(fast.payoff_date! < slow.payoff_date!, `${fast.payoff_date} ต้องมาก่อน ${slow.payoff_date}`);
    assert.ok(fast.total_payment_satang < slow.total_payment_satang);
  });

  await t.test('ฉากจ่ายขั้นต่ำอย่างเดียว ปิดจบภายในงวดที่ 15 ไม่เลยอายุสัญญา', () => {
    const p = projectStudentLoan(loan(), 'minimum_only');
    assert.equal(p.truncated, false);
    assert.notEqual(p.payoff_date, null);
    assert.ok(
      p.payoff_installment_no !== null && p.payoff_installment_no <= TOTAL_INSTALLMENTS,
      `ปิดที่งวด ${p.payoff_installment_no} ต้องไม่เกิน ${TOTAL_INSTALLMENTS}`,
    );
    assert.equal(p.monthly.at(-1)!.closing_principal_satang, 0);
    assert.equal(p.monthly.at(-1)!.interest_due_satang, 0);
  });

  await t.test('ฉากจ่ายขั้นต่ำอย่างเดียวไม่ได้ส่วนลด (จ่ายครบตามตาราง ไม่ใช่ปิดก่อนกำหนด)', () => {
    const p = projectStudentLoan(loan(), 'minimum_only');
    assert.equal(p.discount_satang, 0);
  });

  await t.test('ตั้งยอดจ่ายเป็น 0 ก็ยังถูกบังคับด้วยขั้นต่ำ จึงไม่มีทางลูปไม่รู้จบ', () => {
    const p = projectStudentLoan(
      loan({ as_of_date: '2020-07-05', monthly_payment_satang: 0, monthly_saving_satang: 0 }),
      'lump_sum',
    );
    // ขั้นต่ำยังถูกบังคับอยู่ จึงปิดได้ตามตาราง — เคสชนเพดานจริงคือหนี้ที่ไม่มีตารางให้เดินต่อ
    assert.equal(p.truncated, false);
    assert.ok(p.months_remaining <= 15 * 12 + 1);
  });

  await t.test('ยอดรวมที่ต้องจ่ายอีก = ผลรวมของทุกงวดในตารางรายเดือน', () => {
    const p = projectStudentLoan(
      loan({
        as_of_date: '2026-09-17',
        principal_remaining_satang: 60_000 * BAHT,
        monthly_payment_satang: 750 * BAHT,
        monthly_saving_satang: 8_000 * BAHT,
      }),
      'lump_sum',
    );
    const sum = p.monthly.reduce((a, m) => a + m.paid_satang, 0);
    assert.equal(p.total_payment_satang, sum);
  });

  await t.test('โปะเข้า กยศ. ทุกเดือนก็ปิดได้ และได้ส่วนลดตอนเคลียร์ก้อนสุดท้าย', () => {
    const p = projectStudentLoan(
      loan({
        as_of_date: '2026-09-17',
        principal_remaining_satang: 60_000 * BAHT,
        monthly_payment_satang: 750 * BAHT,
        monthly_saving_satang: 8_000 * BAHT,
      }),
      'extra_monthly',
    );
    assert.notEqual(p.payoff_date, null);
    assert.ok(p.discount_satang > 0);
    assert.equal(p.monthly.at(-1)!.closing_principal_satang, 0);
  });

  await t.test('ยังอยู่ช่วงปลอดหนี้ ดอกเบี้ยไม่เดิน จ่ายเท่าไหร่ลดเงินต้นล้วน', () => {
    const p = projectStudentLoan(
      loan({ as_of_date: '2019-07-05', monthly_payment_satang: 1_000 * BAHT, monthly_saving_satang: 0 }),
      'lump_sum',
    );
    const beforeFirstDue = p.monthly.filter((m) => m.date < '2020-07-05');
    assert.ok(beforeFirstDue.length > 0);
    for (const row of beforeFirstDue) {
      assert.equal(row.interest_accrued_satang, 0, `${row.date} ไม่ควรมีดอกเบี้ย`);
      assert.equal(row.paid_principal_satang, row.paid_satang);
    }
  });

  await t.test('ปฏิเสธ input ที่ไม่ใช่จำนวนเต็มสตางค์ แทนที่จะคำนวณเพี้ยนเงียบ ๆ', () => {
    assert.throws(() => projectStudentLoan(loan({ principal_remaining_satang: 1234.5 })), /จำนวนเต็มสตางค์/);
    assert.throws(() => projectStudentLoan(loan({ first_due_date: '05/07/2020' })), /YYYY-MM-DD/);
    assert.throws(() => projectStudentLoan(loan({ payoff_discount_bp: 20_000 })), /payoff_discount_bp/);
  });
});
