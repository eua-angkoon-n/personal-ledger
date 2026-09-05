-- Slice 8: ประมาณการภาษีแยกตาม Tax Entity/ปีภาษี + audit call site ที่เหลือตาม §7.6
-- audit_log สร้างไปแล้วใน 009 — ไฟล์นี้ไม่สร้างซ้ำ

-- §10.2 Tax Treatment: แยกคอลัมน์ใหม่ ไม่ขยาย txn_annotation.classification เดิม
-- classification (income/expense/internal_transfer/excluded) เป็น load-bearing ของ
-- EFFECTIVE_CLASSIFICATION_SQL/EXCLUDED_FROM_FLOW_SQL ใน report-query.ts ที่ Dashboard/รายงาน/
-- income-records ใช้อยู่แล้ว ขยาย enum ตรงนั้นจะกระทบของเดิมทั้งหมด คอลัมน์ใหม่ blast radius เล็กกว่า
--
-- ลำดับความสำคัญของสองคอลัมน์: คำนวณภาษี (Slice 8) อ่าน tax_treatment อย่างเดียว, รายงานเดิม
-- (Dashboard/cash-flow/category) อ่าน classification อย่างเดียว ค่าทั้งสองขัดกันได้โดยตั้งใจ
-- (เช่น classification='income' + tax_treatment='excluded' = เงินเข้าจริงแต่ไม่เอาเข้าฐานภาษี)
-- ห้ามใส่ CHECK ผูกสองคอลัมน์เข้าหากัน จะทำให้ report SQL เดิมเขียนค่าลงไม่ได้
--
-- nullable ไม่มี default โดยเจตนา (§7.5 "Bank Debit ไม่ถือเป็นค่าใช้จ่ายหักภาษีได้โดยอัตโนมัติ") —
-- null = ผู้ใช้ยังไม่ได้ตัดสิน ระบบห้ามเดาให้
alter table txn_annotation add column tax_treatment text
  check (tax_treatment in ('personal', 'business_income', 'business_expense',
                            'non_deductible', 'internal_transfer', 'excluded'));
create index txn_annotation_tax_treatment_idx on txn_annotation (tax_treatment)
  where tax_treatment is not null;

-- §7.5 tax_deduction_claim
-- deduction_type ไม่มี CHECK: ชุดค่าลดหย่อนเปลี่ยนตามปีภาษี ใส่ CHECK ตายตัวต้อง migration ทุกครั้งที่
-- สรรพากรเพิ่มรายการ ตรวจความถูกต้องที่ route แทนโดยเทียบกับ rule set ของปีนั้น (src/services/tax-rules.ts)
--
-- ไม่มี unique (user_id, tax_entity_id, tax_year, deduction_type): เคยคิดใส่กันกรอกซ้ำ แต่ตีกับ
-- tax_document_id — ใบอนุโมทนาบัตรบริจาคสองใบในปีเดียวกันคือสองแถว deduction_type='donation' คนละแถว
-- ถ้าใส่ unique ผู้ใช้ที่บริจาคสองครั้งจะโดน 409 ทันที เลือกฝั่ง drill-down ต่อเอกสารแทน
-- (การนับซ้ำต่อแถวมี claimed <= eligible คุมอยู่แล้ว)
create table tax_deduction_claim (
  id                     bigserial primary key,
  user_id                bigint not null references app_user(id) on delete cascade,
  tax_entity_id          bigint not null references tax_entity(id),
  tax_year               integer not null check (tax_year between 2000 and 2200),
  deduction_type         text not null,
  eligible_amount_satang bigint not null check (eligible_amount_satang >= 0),
  claimed_amount_satang  bigint not null check (claimed_amount_satang >= 0),
  tax_document_id        bigint references tax_document(id),
  note                   text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (claimed_amount_satang <= eligible_amount_satang)
);
create index tax_deduction_claim_entity_year_idx on tax_deduction_claim (tax_entity_id, tax_year);
create index tax_deduction_claim_user_idx on tax_deduction_claim (user_id);

-- §7.5 tax_calculation_snapshot — 1 แถว = 1 tax_entity_id เสมอ (ห้ามรวม Tax Entity คนละประเภทในผลเดียว)
-- input_snapshot ฝัง rule set (src/services/tax-rules.ts) ทั้งก้อนไว้ด้วย ไม่ใช่แค่ version string —
-- ไม่งั้นแก้ตัวเลข rule ปีถัดไปจะย้อนเปลี่ยนความหมายของ snapshot เก่าที่เคยคำนวณไปแล้วแบบเงียบ ๆ
create table tax_calculation_snapshot (
  id              bigserial primary key,
  user_id         bigint not null references app_user(id) on delete cascade,
  tax_entity_id   bigint not null references tax_entity(id),
  tax_year        integer not null check (tax_year between 2000 and 2200),
  rule_version    text not null,
  input_snapshot  jsonb not null,
  result_snapshot jsonb not null,
  calculated_at   timestamptz not null default now()
);
create index tax_calculation_snapshot_entity_year_idx
  on tax_calculation_snapshot (tax_entity_id, tax_year, calculated_at desc);
