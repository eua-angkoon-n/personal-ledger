# Hyacinthia Ledger — แผนรายเฟส (Slice 4A–8)

แตกจาก `docs/plans/hyacinthia-ledger-feature-plan.md` (baseline: branch `master`, commit `c147a68`)
เพราะเอกสารเดิมครอบคลุมทั้ง 5 เฟสในไฟล์เดียว ใหญ่เกินกว่าจะลงมือหรือรีวิวได้ในรอบเดียว

## ลำดับเฟสและการพึ่งพา

```
4A Ledger Integrity
  → 4B Dashboard & Transaction Review
    → 5 Monthly Planning
      → 6 Income & Installment
        → 7 Tax Document Vault
          → 8 Tax Calculation
```

**กติกาบังคับจาก §19 ของแผนต้นฉบับ:** ห้ามเริ่ม Dashboard หรือ Tax Calculation ที่นำไปใช้ตัดสินใจจริง
ก่อน Category, Internal Transfer และ Data Freshness (= 4A) พร้อมใช้งานสมบูรณ์

| เฟส | เอกสาร | Migration | สถานะ |
|---|---|---|---|
| 4A — Ledger Integrity | [4a-ledger-integrity.md](4a-ledger-integrity.md) | `005_ledger_classification.sql` | เสร็จ |
| 4B — Dashboard & Transaction Review | [4b-dashboard.md](4b-dashboard.md) | (ไม่มี — ใช้ schema จาก 005) | เสร็จ |
| 5 — Monthly Planning | [5-monthly-planning.md](5-monthly-planning.md) | `006_monthly_planning.sql` | เสร็จ |
| 6 — Income & Installment | [6-income-installment.md](6-income-installment.md) | `008_income_and_installments.sql` | เสร็จ |
| 7 — Tax Document Vault | [7-tax-document-vault.md](7-tax-document-vault.md) | `009_tax_document_vault.sql` | เสร็จ |
| 8 — Tax Calculation | [8-tax-calculation.md](8-tax-calculation.md) | `010_tax_calculation_and_audit.sql` | ถัดไป |

หมายเหตุเลข migration: `007_kbank_statement_parser.sql` เป็นงาน seed ข้อมูลที่ไม่ได้อยู่ในแผนเดิม
แทรกเข้ามาก่อน Slice 6 ทำให้เลขไฟล์ของ Slice 6 เป็นต้นไปเลื่อน +1 จากที่ตารางนี้เคยระบุไว้ก่อนหน้า

## ข้อตกลงร่วมทุกเฟส (ดู §3, §6 ของแผนต้นฉบับ)

- Dashboard และข้อมูลทั้งหมดเป็นของผู้ใช้แต่ละคนเท่านั้น ห้ามรวมข้อมูลข้าม User
- ทุก Endpoint ใช้ User จาก `requireUser` เท่านั้น ห้ามรับ `user_id` จาก Body/Query
- Transaction จริงมาจาก Bank Statement เท่านั้น — ห้ามมี endpoint สร้าง `txn` ด้วยมือ
- เงินทุกช่องเป็น `BIGINT` หน่วยสตางค์
- ตารางใหม่ทุกตารางต้องมี `user_id` โดยตรงหรืออ้างถึง parent ที่มี พร้อมตรวจ ownership ทุกครั้ง

รายละเอียดเต็มของแต่ละหัวข้อ (data model, API, testing strategy, ความเสี่ยง) อยู่ใน
`docs/plans/hyacinthia-ledger-feature-plan.md` — ไฟล์รายเฟสอ้างอิงเลขหัวข้อ (§) กลับไปที่นั่น
