// §10.5 "แยก Rule ตามปีภาษี" — rule เป็น data ไม่ใช่ตาราง DB (§13 ไม่ได้ให้ schema ตารางกฎไว้)
// ตัวเลขผิด = แก้ค่าเดียวในไฟล์นี้ ไม่ใช่แก้โครงสร้าง และ snapshot ฝัง rule set ทั้งก้อนไว้เสมอ
// (ดู tax-calculation.ts) จึงแก้เลขปีถัดไปได้โดยไม่ย้อนเปลี่ยนความหมายของ snapshot เก่า
//
// TODO: ตรวจตัวเลขขั้นบันได/ค่าลดหย่อนกับ rd.go.th ก่อนใช้ตัดสินใจภาษีจริง — ค่าด้านล่างเป็นค่าเริ่มต้น
// ที่ยังไม่ผ่านการยืนยันกับกรมสรรพากร

export type TaxBracket = {
  upToSatang: number | null; // null = ไม่มีเพดานบน (ขั้นสุดท้าย)
  rate: number; // 0.05 = 5%
};

export type TaxRuleSet = {
  version: string;
  taxYearCE: number;
  brackets: TaxBracket[];
  personalAllowanceSatang: number;
  employmentExpense: { rate: number; capSatang: number };
  // ชุดค่าลดหย่อนที่รับได้ในปีนี้ — ไม่มี 'personal' เพราะลดหย่อนส่วนตัวมาจาก personalAllowanceSatang
  // อยู่แล้ว ถ้าเปิดให้กรอกเป็น deduction claim ด้วยจะนับซ้ำ
  deductionTypes: readonly string[];
};

const DEDUCTION_TYPES = [
  'spouse',
  'child',
  'parent',
  'life_insurance',
  'health_insurance',
  'social_security',
  'provident_fund',
  'ssf',
  'rmf',
  'mortgage_interest',
  'donation',
  'other',
] as const;

// ขั้นบันไดภาษีเงินได้บุคคลธรรมดา, ลดหย่อนส่วนตัว 60,000, ค่าใช้จ่ายเงินได้ 40(1) 50% ไม่เกิน 100,000
// เท่ากันทั้งปีภาษี ค.ศ. 2024/2025 (พ.ศ. 2567/2568) ณ วันที่เขียนโค้ดนี้ — ตรวจซ้ำก่อนใช้จริงตาม TODO ด้านบน
const TH_PIT_BASE = {
  brackets: [
    { upToSatang: 15_000_000, rate: 0 },
    { upToSatang: 30_000_000, rate: 0.05 },
    { upToSatang: 50_000_000, rate: 0.1 },
    { upToSatang: 75_000_000, rate: 0.15 },
    { upToSatang: 100_000_000, rate: 0.2 },
    { upToSatang: 200_000_000, rate: 0.25 },
    { upToSatang: 500_000_000, rate: 0.3 },
    { upToSatang: null, rate: 0.35 },
  ],
  personalAllowanceSatang: 6_000_000,
  employmentExpense: { rate: 0.5, capSatang: 10_000_000 },
  deductionTypes: DEDUCTION_TYPES,
};

// tax_year เก็บเป็น ค.ศ. ล้วนทั้งระบบ (migration 009 CHECK 2000..2200 ตรงกับ ~2026 ไม่ใช่ ~2569) — ห้ามบวก/ลบ 543 ที่นี่
const RULE_SETS: Record<number, TaxRuleSet> = {
  2024: { version: 'th-pit-2024.1', taxYearCE: 2024, ...TH_PIT_BASE },
  2025: { version: 'th-pit-2025.1', taxYearCE: 2025, ...TH_PIT_BASE },
};

const KNOWN_YEARS = Object.keys(RULE_SETS).map(Number).sort((a, b) => a - b);

/** taxYearCE เป็น ค.ศ. ล้วน — ไม่มี rule ของปีนั้น ใช้ปีล่าสุดที่ ≤ ปีที่ขอ (ปีเก่ากว่าที่มีทั้งหมด = ใช้ปีแรกสุด) */
export function resolveRuleSet(taxYearCE: number): TaxRuleSet {
  const exact = RULE_SETS[taxYearCE];
  if (exact) return exact;

  const fallbackYear = [...KNOWN_YEARS].reverse().find((y) => y <= taxYearCE);
  const chosen = fallbackYear != null ? RULE_SETS[fallbackYear]! : RULE_SETS[KNOWN_YEARS[0]!]!;
  return chosen;
}
