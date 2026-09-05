# Slice 7 — Tax Document Vault

> สถานะ: เสร็จแล้ว
> อ้างอิง §7.5 "Tax" (บางส่วน: `tax_entity`, `tax_document`, `tax_document_txn_link`),
> §10.1 "Personal และ Business Separation", §10.2 "Tax Treatment", §10.3 "Tax Document Workflow",
> §10.4 "Storage Security", §14 "Slice 7" ของ `docs/plans/hyacinthia-ledger-feature-plan.md`

## เป้าหมาย

เก็บและเชื่อมเอกสารภาษีอย่างปลอดภัย

## Migration

`009_tax_document_vault.sql` — `tax_entity`, `tax_document`, `tax_document_txn_link`, `audit_log`, file fingerprint
รวมถึง `bank_account.default_tax_entity_id` ที่เลื่อนมาจาก migration 005 (เพราะ FK ต้องรอ `tax_entity` เกิดก่อน)
(เลข migration เลื่อนจาก `008` เป็น `009` เพราะ `007_kbank_statement_parser.sql` แทรกเข้ามาก่อนโดยไม่อยู่ในแผนเดิม
ทำให้ Slice 6 กลายเป็น `008_income_and_installments.sql` — `audit_log` ดึงมาสร้างที่นี่แทนที่จะรอ Slice 8
เพราะ DoD ของสไลซ์นี้เองต้องมี audit การดาวน์โหลด)

## งาน (§14)

- Tax Entity — ผู้ใช้หนึ่งคนมีได้หลายรายการ (บุคคลธรรมดา / ร้านค้า / บริษัท) (§7.5)
- Personal/Business Account Mapping (§10.1 — bank account มี default tax entity, transaction override ได้)
- Upload Tax Document ด้วยมือ, Gmail Attachment Selection (§10.3 ระยะแรก)
- Encrypted File Storage (§10.4 — encrypt ก่อนลงดิสก์, SHA-256 กันซ้ำ, authorization ทุกครั้งก่อนเปิดไฟล์,
  audit การดาวน์โหลด, retention policy, backup เข้ารหัส)
- Transaction Linking (§7.5 `tax_document_txn_link` — หนึ่งเอกสารเชื่อมหลาย txn และกลับกันได้)
- Verification Workflow (§10.3 — ผู้ใช้ตรวจสอบและ mark verified)
- Audit Log (§7.6 — เชื่อมกับงานนี้เพราะ "ดาวน์โหลดเอกสารภาษี" ต้องถูก log)

## Definition of Done (§14)

- เอกสารทุกฉบับมีเจ้าของและ Tax Entity ชัดเจน
- User อื่นเปิดเอกสารไม่ได้
- ไฟล์ถูกเข้ารหัสและตรวจ Duplicate ได้
- ตรวจสอบย้อนกลับจากเอกสารไป Transaction ได้

## ความเสี่ยงเฉพาะเฟส (§17)

เอกสารภาษีอาจเป็น plaintext file จึงต้องการมาตรการเพิ่มจาก Statement PDF เดิม — encrypt, authorization,
audit, encrypted backup ครบทั้งสี่อย่างก่อนเปิดใช้งานจริง
