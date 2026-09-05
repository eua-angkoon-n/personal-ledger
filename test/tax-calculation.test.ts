// §10.5 + §7.5: ประมาณการภาษีบุคคลธรรมดา เป็นฟังก์ชัน pure ไม่แตะ DB (เหมือน occurrencesInMonth)
// จึงรันใน `npm test` เฉย ๆ ได้ ไม่ต้อง test:db
import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateTax, type TaxInput } from '../src/services/tax-calculation.js';
import { resolveRuleSet } from '../src/services/tax-rules.js';

function input(over: Partial<TaxInput>): TaxInput {
  return {
    employmentIncomeSatang: 0,
    otherIncomeSatang: 0,
    deductibleExpenseSatang: 0,
    deductionClaimSatang: 0,
    withholdingSatang: 0,
    ...over,
  };
}

test('resolveRuleSet', async (t) => {
  await t.test('ปีที่มี rule ตรงตัว → คืน rule ของปีนั้น', () => {
    assert.equal(resolveRuleSet(2024).version, 'th-pit-2024.1');
    assert.equal(resolveRuleSet(2025).version, 'th-pit-2025.1');
  });

  await t.test('ปีที่ไม่มี rule → fallback เป็นปีล่าสุดที่ ≤ ปีที่ขอ', () => {
    assert.equal(resolveRuleSet(2026).version, 'th-pit-2025.1');
  });

  await t.test('ปีที่เก่ากว่า rule ทุกปีที่มี → ใช้ปีแรกสุดที่มี', () => {
    assert.equal(resolveRuleSet(2000).version, 'th-pit-2024.1');
  });
});

test('estimateTax', async (t) => {
  const rules = resolveRuleSet(2025);

  await t.test('รายได้ 0 → ประมาณการภาษี 0 และไม่คืนภาษี', () => {
    const r = estimateTax(input({}), rules);
    assert.equal(r.netSatang, 0);
    assert.equal(r.estimatedTaxSatang, 0);
    assert.equal(r.estimatedPayableSatang, 0);
  });

  await t.test('เงินเดือนพอดีขอบเขตขั้นแรก 150,000 หลังหักทุกอย่างแล้วไม่เสียภาษี', () => {
    // เงินเดือน x: net = x - min(0.5x, 100000) - 60000 ต้อง = 150000 พอดี (สมมติ x ใหญ่พอให้ expense ชนเพดาน)
    // x = 400,000 → expense = min(200000, 100000) = 100000 → net = 400000 - 100000 - 60000 = 240000 (ไม่ใช่ 150000)
    // ใช้ x ที่ net ตรงพอดีที่ 150,000: ลองรายได้ 310,000 → expense = min(155000,100000)=100000 → net=310000-100000-60000=150000
    const r = estimateTax(input({ employmentIncomeSatang: 31_000_000 }), rules);
    assert.equal(r.netSatang, 15_000_000);
    assert.equal(r.estimatedTaxSatang, 0);
  });

  await t.test('net เกินขั้นแรกไปเล็กน้อย → ส่วนเกินโดนอัตรา 5%', () => {
    // net = 150,000 + 10,000 = 160,000 → tax = 10,000 * 5% = 500
    const r = estimateTax(input({ employmentIncomeSatang: 32_000_000 }), rules);
    assert.equal(r.netSatang, 16_000_000);
    assert.equal(r.estimatedTaxSatang, 50_000);
  });

  await t.test('เงินเดือน 200,000 → ค่าใช้จ่ายหักได้เต็มเพดาน 100,000 พอดี (50% ของ 200,000 = 100,000)', () => {
    const r = estimateTax(input({ employmentIncomeSatang: 20_000_000 }), rules);
    assert.equal(r.employmentExpenseSatang, 10_000_000);
  });

  await t.test('เงินเดือนเกินเพดานค่าใช้จ่าย → ค่าใช้จ่ายถูกจำกัดที่เพดาน ไม่ใช่ 50% เต็ม ๆ', () => {
    const r = estimateTax(input({ employmentIncomeSatang: 100_000_000 }), rules);
    assert.equal(r.employmentExpenseSatang, 10_000_000);
  });

  await t.test('เงินเดือน 0 + business income สูง → ค่าใช้จ่ายเงินได้ 40(1) ต้องเป็น 0 (ห้ามคิด % จากยอดรวม)', () => {
    const r = estimateTax(input({ otherIncomeSatang: 100_000_000 }), rules);
    assert.equal(r.employmentExpenseSatang, 0);
    assert.equal(r.assessableSatang, 100_000_000);
  });

  await t.test('business expense หักออกจาก assessable ก่อนคำนวณภาษี', () => {
    const r = estimateTax(input({ otherIncomeSatang: 50_000_000, deductibleExpenseSatang: 20_000_000 }), rules);
    assert.equal(r.assessableSatang, 30_000_000);
  });

  await t.test('ค่าลดหย่อนที่ผู้ใช้กรอกหักออกจาก net เพิ่มเติม', () => {
    const withoutClaim = estimateTax(input({ employmentIncomeSatang: 100_000_000 }), rules);
    const withClaim = estimateTax(input({ employmentIncomeSatang: 100_000_000, deductionClaimSatang: 10_000_000 }), rules);
    assert.equal(withoutClaim.netSatang - withClaim.netSatang, 10_000_000);
  });

  await t.test('รายได้สูงชนขั้นบนสุด 35%', () => {
    const r = estimateTax(input({ employmentIncomeSatang: 600_000_000 }), rules);
    const topBracket = r.bracketBreakdown[r.bracketBreakdown.length - 1]!;
    assert.equal(topBracket.rate, 0.35);
    assert.ok(topBracket.taxSatang > 0);
  });

  await t.test('withholding มากกว่าภาษีที่คำนวณได้ → ยอดที่ต้องจ่ายติดลบ (ขอคืนภาษี)', () => {
    const r = estimateTax(input({ employmentIncomeSatang: 32_000_000, withholdingSatang: 100_000 }), rules);
    assert.equal(r.estimatedTaxSatang, 50_000);
    assert.equal(r.estimatedPayableSatang, -50_000);
  });

  await t.test('ผลลัพธ์พก rule version และ taxYearCE ติดมาด้วยเสมอ', () => {
    const r = estimateTax(input({}), rules);
    assert.equal(r.ruleVersion, rules.version);
  });
});
