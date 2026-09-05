import type { TaxRuleSet } from './tax-rules.js';

export type TaxInput = {
  employmentIncomeSatang: number;
  otherIncomeSatang: number;
  deductibleExpenseSatang: number;
  deductionClaimSatang: number;
  withholdingSatang: number;
};

export type BracketBreakdown = {
  upToSatang: number | null;
  rate: number;
  taxSatang: number;
};

export type TaxEstimate = {
  ruleVersion: string;
  employmentIncomeSatang: number;
  otherIncomeSatang: number;
  deductibleExpenseSatang: number;
  employmentExpenseSatang: number;
  personalAllowanceSatang: number;
  deductionClaimSatang: number;
  assessableSatang: number;
  netSatang: number;
  estimatedTaxSatang: number;
  withholdingSatang: number;
  estimatedPayableSatang: number;
  bracketBreakdown: BracketBreakdown[];
};

// ขั้นบันไดสะสม: ยอดตั้งแต่ upToSatang ของขั้นก่อนหน้า ถึง upToSatang ของขั้นนี้ โดนอัตราของขั้นนี้
function applyBrackets(netSatang: number, brackets: TaxRuleSet['brackets']): BracketBreakdown[] {
  const result: BracketBreakdown[] = [];
  let lowerBound = 0;
  for (const bracket of brackets) {
    const upperBound = bracket.upToSatang ?? Infinity;
    const taxableInBracket = Math.max(0, Math.min(netSatang, upperBound) - lowerBound);
    result.push({ upToSatang: bracket.upToSatang, rate: bracket.rate, taxSatang: Math.round(taxableInBracket * bracket.rate) });
    lowerBound = upperBound;
    if (netSatang <= upperBound) break;
  }
  return result;
}

/**
 * ประมาณการภาษีเงินได้บุคคลธรรมดา — ผลลัพธ์นี้เป็น "ประมาณการ" เสมอ ไม่ใช่ยอดที่ต้องชำระจริง (§7.5)
 *
 * ลำดับคำนวณ (ล็อกไว้ตามที่ตกลงกัน ห้ามสลับ):
 *   employmentExpense = min(employmentIncome * rate, cap)   ← คิดจาก employmentIncome เท่านั้น
 *                                                              ห้ามคิดจากยอดรวม (business income ไม่มีสิทธิ์นี้)
 *   assessable = employmentIncome + otherIncome - deductibleExpense
 *   net        = max(0, assessable - employmentExpense - personalAllowance - deductionClaim)
 *   tax        = applyBrackets(net)
 *   payable    = tax - withholding                           ← ติดลบ = ขอคืนภาษี
 */
export function estimateTax(input: TaxInput, rules: TaxRuleSet): TaxEstimate {
  const employmentExpenseSatang = Math.min(
    Math.round(input.employmentIncomeSatang * rules.employmentExpense.rate),
    rules.employmentExpense.capSatang,
  );

  const assessableSatang = input.employmentIncomeSatang + input.otherIncomeSatang - input.deductibleExpenseSatang;

  const netSatang = Math.max(
    0,
    assessableSatang - employmentExpenseSatang - rules.personalAllowanceSatang - input.deductionClaimSatang,
  );

  const bracketBreakdown = applyBrackets(netSatang, rules.brackets);
  const estimatedTaxSatang = bracketBreakdown.reduce((sum, b) => sum + b.taxSatang, 0);

  return {
    ruleVersion: rules.version,
    employmentIncomeSatang: input.employmentIncomeSatang,
    otherIncomeSatang: input.otherIncomeSatang,
    deductibleExpenseSatang: input.deductibleExpenseSatang,
    employmentExpenseSatang,
    personalAllowanceSatang: rules.personalAllowanceSatang,
    deductionClaimSatang: input.deductionClaimSatang,
    assessableSatang,
    netSatang,
    estimatedTaxSatang,
    withholdingSatang: input.withholdingSatang,
    estimatedPayableSatang: estimatedTaxSatang - input.withholdingSatang,
    bracketBreakdown,
  };
}
