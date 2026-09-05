# Slice 6 — Income และ Installment

> สถานะ: เสร็จแล้ว
> อ้างอิง §7.3 "Installment", §7.4 "Income และ Payroll Deduction", §14 "Slice 6"
> ของ `docs/plans/hyacinthia-ledger-feature-plan.md`

## เป้าหมาย

รองรับรายได้เต็ม รายการหัก และภาระผ่อน

## Migration

`008_income_and_installments.sql` — `income_record`, `income_deduction`, `installment_plan`, `installment_due`
(เลข migration เลื่อนจาก `007` เป็น `008` เพราะ `007_kbank_statement_parser.sql` แทรกเข้ามาก่อนโดยไม่อยู่ในแผนเดิม)
(รายละเอียดคอลัมน์เต็มใน §7.3–7.4)

## งาน (§14)

- Gross Income, Social Security, Withholding Tax, Other Deduction (§7.4)
- Match Net Deposit — สูตร Expected Net = Gross − ผลรวม Deduction (§7.4)
- Installment Plan, Installment Due — ผลรวมทุกงวดต้องเท่ายอดรวม, งวดสุดท้ายรับเศษจากการหาร,
  รองรับจ่ายบางส่วน/จ่ายก่อนกำหนด, แสดงยอดจ่ายแล้ว/คงเหลือ (§7.3)
- Outstanding Balance Report

## Definition of Done (§14)

- Gross Income และ Net Deposit ไม่ถูกนับซ้ำ
- แสดงยอดผ่อนทั้งหมด จ่ายแล้ว และคงเหลือ
- งวดสุดท้ายไม่คลาดเคลื่อนจากการหาร

## กฎป้องกันการนับซ้ำ (§7.4 — สำคัญที่สุดของเฟสนี้)

- Dashboard กระแสเงินสดจริงใช้ Credit จาก `txn`
- Monthly Plan ใช้ Gross Income หัก Deduction
- Tax Report ใช้ Gross Income และ Withholding Tax
- ห้ามรวม Gross Income และ Bank Credit เป็นรายได้สองก้อน
