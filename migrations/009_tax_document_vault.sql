create table tax_entity (
  id             bigserial primary key,
  user_id        bigint not null references app_user(id) on delete cascade,
  entity_type    text not null check (entity_type in ('individual','sole_proprietor','company')),
  display_name   text not null,
  tax_id_enc     text, -- encrypt() แบบสตริงเดิม เหมือน pdf_password_enc — ห้าม select ออก API ดิบ
  vat_registered boolean not null default false,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);
create unique index tax_entity_name_uniq on tax_entity (user_id, lower(display_name)) where is_active = true;

create table tax_document (
  id                  bigserial primary key,
  user_id             bigint not null references app_user(id) on delete cascade,
  tax_entity_id       bigint not null references tax_entity(id),
  document_type       text not null check (document_type in
                        ('tax_invoice','e_tax_invoice','receipt','withholding_certificate',
                         'insurance_certificate','donation_receipt','investment_certificate','other')),
  tax_year            integer not null check (tax_year between 2000 and 2200),
  issuer_name         text not null,
  issuer_tax_id       text,
  recipient_tax_id    text,
  document_no         text,
  issue_date          date,
  subtotal_satang     bigint check (subtotal_satang >= 0),
  vat_satang          bigint check (vat_satang >= 0),
  total_satang        bigint not null check (total_satang >= 0),
  withholding_satang  bigint check (withholding_satang >= 0),
  storage_path        text not null, -- server สร้างเองเสมอ ห้ามรับจาก client (path traversal)
  file_sha256         text not null, -- hash ของ plaintext ก่อนเข้ารหัส — GCM สุ่ม IV ทุกครั้งทำให้ hash ของ ciphertext ใช้กันซ้ำไม่ได้
  file_mime           text not null,
  file_size_bytes     bigint not null check (file_size_bytes > 0),
  original_filename   text not null,
  gmail_message_id    text,    -- ไม่ null = provenance มาจาก Gmail attachment (§10.3 ข้อ 2)
  gmail_attachment_id text,
  status              text not null default 'draft' check (status in ('draft','verified','submitted')),
  verified_at         timestamptz,
  archived_at         timestamptz, -- §17 "Hard Delete ทำลายประวัติ" → ใช้ archive แทนลบจริง
  -- §10.4 Retention Policy: เก็บถึงสิ้นปีที่ 5 หลังปีภาษี เป็นกฎคงที่ ไม่ใช่ข้อมูลที่ผู้ใช้กรอกเอง
  -- ponytail: มีแค่คอลัมน์ไว้ query/แสดงผล ยังไม่มี job ลบอัตโนมัติ — เพิ่มเมื่อมีเอกสารเกินอายุจริง
  retention_until     date generated always as (make_date(tax_year + 5, 12, 31)) stored,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
-- ต่างคนถือใบเสร็จใบเดียวกันได้ (เช่น ซื้อร่วมกัน) → unique ต่อ user ไม่ใช่ทั้งระบบ; archive แล้วอัปโหลดซ้ำได้
create unique index tax_document_sha_uniq on tax_document (user_id, file_sha256) where archived_at is null;
create index tax_document_entity_year_idx on tax_document (tax_entity_id, tax_year);
create index tax_document_user_idx on tax_document (user_id) where archived_at is null;

create table tax_document_txn_link (
  id                   bigserial primary key,
  tax_document_id      bigint not null references tax_document(id) on delete cascade,
  txn_id               bigint not null references txn(id) on delete cascade,
  linked_amount_satang bigint not null check (linked_amount_satang > 0),
  created_at           timestamptz not null default now(),
  unique (tax_document_id, txn_id)
);
create index tax_document_txn_link_txn_idx on tax_document_txn_link (txn_id);

-- §7.6 shape เต็ม — Slice 7 เขียนแค่ tax_document.download / tax_document.link_txn
-- ส่วน call site ที่เหลือ (แก้ category, confirm transfer, ฯลฯ) เป็นงานของ Slice 8
create table audit_log (
  id          bigserial primary key,
  user_id     bigint not null references app_user(id) on delete cascade,
  action      text not null,
  entity_type text not null,
  entity_id   bigint,
  before_data jsonb,
  after_data  jsonb,
  ip_address  text,
  created_at  timestamptz not null default now()
);
create index audit_log_user_created_idx on audit_log (user_id, created_at desc);

-- §10.1: bank account มี default tax entity, transaction override ได้ — เลื่อนมาจาก migration 005
-- เพราะ FK ต้องรอ tax_entity เกิดก่อน (ดู docs/adr/0002)
alter table bank_account add column default_tax_entity_id bigint references tax_entity(id);

-- 005 จงใจไม่ใส่ FK ไว้ (ตารางปลายทางยังไม่เกิด) ตอนนี้ tax_entity มีแล้วจึงใส่ได้ — ล้างค่าค้างก่อน
-- กัน add constraint ล้มบน DB จริงถ้ามีแถวเก่าเหลืออยู่ (ไม่ควรมี แต่ safety ก่อนใส่ FK)
update txn_annotation set tax_entity_id = null where tax_entity_id is not null;
alter table txn_annotation add constraint txn_annotation_tax_entity_fk
  foreign key (tax_entity_id) references tax_entity(id);
