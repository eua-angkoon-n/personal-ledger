# Hyacinthia Ledger — แผนพัฒนา Dashboard, Monthly Planning และ Tax

> สถานะ: Draft สำหรับนำไปแตกเป็นงานพัฒนา  
> อัปเดต: 2026-09-02  
> Repository: `eua-angkoon-n/family-ledger`  
> Baseline ที่ใช้ประเมิน: branch `master`, commit `c147a68d6e2f2a5acdcad02a421e4cfa3b9e35b2`

## 1. เป้าหมาย

ขยายระบบเดิมจากการนำเข้า Bank Statement ให้เป็นระบบจัดการการเงินส่วนบุคคลที่ประกอบด้วย:

1. Dashboard รายรับ รายจ่าย และยอดคงเหลือ
2. ระบบวางแผนรายเดือน รายการประจำ การผ่อน และการกันงบ
3. ระบบบันทึกเอกสารภาษีและประมาณการภาษี ทั้งส่วนบุคคลและธุรกิจ
4. การตรวจสอบย้อนกลับจากรายงานไปยัง Bank Statement และเอกสารต้นทาง

การพัฒนาต้องต่อยอดจากระบบนำเข้า Statement เดิม โดยไม่ลดทอน checksum, deduplication, DKIM validation, encryption และ atomic import ที่มีอยู่แล้ว

---

## 2. ระบบปัจจุบัน

### 2.1 Technology Stack

- Node.js 22
- TypeScript strict mode
- Express
- PostgreSQL 16
- React 18
- Vite
- MUI
- Google OAuth และ Gmail API แบบ `gmail.readonly`
- Docker Compose และ Caddy

### 2.2 ความสามารถที่มีแล้ว

- สมัครและเข้าสู่ระบบด้วย Google OAuth
- Invite code และการอนุมัติผู้ใช้โดย Admin
- รองรับหลาย Gmail account ต่อผู้ใช้
- ผู้ใช้จัดการบัญชีธนาคารของตนเอง
- Admin จัดการผู้ใช้และข้อมูลธนาคาร
- Poll Gmail และรองรับ full sync/incremental sync
- ตรวจผู้ส่ง, DKIM, subject และชื่อไฟล์แนบ
- ดาวน์โหลดและเก็บ PDF ต้นฉบับที่ยังเข้ารหัส
- ถอดรหัสผ่าน `qpdf` และสกัดข้อความผ่าน `pdftotext` โดยไม่เขียนไฟล์ที่ถอดรหัสแล้วลงดิสก์
- SCB parser รองรับรูปแบบ Statement ที่พบจริง 3 รูปแบบ
- ตรวจ checksum ก่อนเขียน Transaction
- Deduplicate ทั้งระดับ PDF และ Transaction
- เก็บเงินเป็น `BIGINT` หน่วยสตางค์

### 2.3 ตารางหลักที่มีแล้ว

- `app_user`
- `email_account`
- `bank`
- `bank_account`
- `statement`
- `txn`

### 2.4 ช่องว่างของระบบปัจจุบัน

- หน้า Reports ยังเป็น Empty State
- ยังไม่มี Category
- ยังไม่มี Transaction annotation หรือ split
- ยังไม่มีการจับคู่ Internal Transfer ที่ตรวจสอบได้
- ยังไม่มี Monthly Planning
- ยังไม่มี Installment Plan
- ยังไม่มี Gross Income และ Payroll Deduction
- ยังไม่มี Tax Document และ Tax Calculation
- ยังไม่มี Audit Log

---

## 3. ข้อตกลงที่ล็อกแล้ว

1. Dashboard และข้อมูลทั้งหมดเป็นของผู้ใช้แต่ละคนเท่านั้น
2. ห้ามรวมข้อมูลของผู้ใช้หลายคนในรายงานเดียวกัน
3. รอบบัญชีใช้เดือนปฏิทิน วันที่ 1 ถึงวันสุดท้ายของเดือน
4. ผู้ใช้สามารถ Mark paid ก่อน Statement มาถึงได้
5. การ Mark paid ห้ามสร้าง `txn` ปลอม
6. รายการ `เก็บ` หมายถึงการกันงบไว้เท่านั้น ไม่ใช่รายจ่ายและไม่ใช่การเคลื่อนไหวเงินจริง
7. รายได้ต้องบันทึกเป็นรายได้เต็ม แล้วหักประกันสังคม ภาษีหัก ณ ที่จ่าย และรายการหักอื่นภายหลัง
8. รองรับทั้งภาษีบุคคลธรรมดาและภาษีของธุรกิจ
9. บัญชีธนาคารสามารถระบุได้ว่าเป็นบัญชีส่วนตัวหรือบัญชีธุรกิจ
10. ไม่รองรับการบันทึกเงินสดหรือ e-Wallet ที่ไม่มี Statement
11. Transaction จริงต้องมาจาก Bank Statement เท่านั้น
12. ระบบต้องระบุชัดเจนว่ารายงานไม่รวมเงินสดและ e-Wallet

---

## 4. ขอบเขตและ Non-goals

### 4.1 อยู่ในขอบเขต

- Bank Transaction จาก Statement
- รายงานแยกตามผู้ใช้
- การจัดหมวดหมู่ Transaction
- Internal Transfer Detection
- Monthly Planning
- Recurring Income/Expense/Reserve
- Mark paid และ reconciliation กับ Statement
- Installment Plan
- Gross Income และ Payroll Deduction
- Tax Entity ส่วนตัวและธุรกิจ
- Tax Document และค่าลดหย่อน
- ประมาณการภาษีตามปีภาษี
- Audit Log

### 4.2 ไม่อยู่ในขอบเขตระยะแรก

- รายงานรวมครอบครัว
- เงินสด
- e-Wallet ที่ไม่มี Statement
- การสร้าง Transaction จริงด้วยมือ
- Real-time Banking API
- การยื่นภาษีให้ผู้ใช้อัตโนมัติ
- OCR อัตโนมัติเต็มรูปแบบ
- Notification ผ่าน LINE, SMS หรือ Push
- Native Mobile Application

---

## 5. หลักการด้าน Domain

ระบบต้องแยกข้อมูลออกเป็น 3 ขอบเขตอย่างชัดเจน

### 5.1 Imported Ledger

ข้อมูลเงินจริงที่ยืนยันได้จาก Statement:

```text
Statement PDF
  → Parser
  → Checksum
  → txn
```

`txn` ต้องคงความหมายเป็นรายการเงินจริงจากธนาคารเท่านั้น

### 5.2 Monthly Planning

ข้อมูลที่ผู้ใช้วางแผนหรือประกาศเอง:

```text
Monthly Plan
  → Planned Income / Expense / Reserve
  → Payment Declaration
  → Reconciliation กับ txn ภายหลัง
```

Planning ห้ามสร้างหรือแก้ไข `txn`

### 5.3 Tax

ข้อมูลที่ใช้เพื่อจัดหมวดและประมาณการภาษี:

```text
Tax Entity
  → Bank Account / Transaction Classification
  → Tax Document
  → Deduction
  → Tax Calculation Snapshot
```

ภาษีส่วนบุคคลและธุรกิจต้องคำนวณแยกกัน

---

## 6. การแยกข้อมูลและสิทธิ์

### 6.1 กฎบังคับ

- ทุก Endpoint ต้องใช้ User จาก `requireUser`
- ห้ามรับ `user_id` จาก Request Body หรือ Query String
- ทุก Query ต้อง scope ด้วย User ที่ login อยู่
- Admin จัดการสถานะผู้ใช้และข้อมูลธนาคารได้ แต่ไม่มีสิทธิ์เปิดดู Transaction, Monthly Plan หรือ Tax ของผู้ใช้
- Export และ Attachment ต้องตรวจ ownership ก่อนส่งไฟล์
- ต้องมี Integration Test ป้องกัน Cross-user access

### 6.2 Query Pattern

```sql
select t.*
from txn t
join bank_account a on a.id = t.bank_account_id
where a.user_id = $1;
```

ตารางใหม่ทุกตารางต้องมี `user_id` โดยตรง หรืออ้างถึง Parent ที่มี `user_id` และต้องตรวจ ownership ทุกครั้ง

---

## 7. การเปลี่ยนแปลงโครงสร้างข้อมูล

## 7.1 Ledger Classification

### `category`

```text
id
user_id nullable
name
kind: income | expense
parent_id nullable
is_system
is_active
created_at
```

- `user_id = null` สำหรับหมวดระบบ
- ผู้ใช้สร้างหมวดส่วนตัวได้
- ห้ามลบหมวดที่ถูกใช้งาน ให้เปลี่ยนเป็น inactive

### `txn_annotation`

```text
id
txn_id unique
tax_entity_id nullable
classification: income | expense | internal_transfer | excluded
review_status: unreviewed | reviewed
note nullable
reviewed_at nullable
updated_at
```

เก็บการตีความของผู้ใช้แยกจากข้อมูลดิบใน `txn`

### `txn_split`

```text
id
txn_id
category_id
amount_satang
note nullable
```

Constraint:

```text
ผลรวม txn_split.amount_satang ต้องเท่ากับ txn.amount_satang
```

### `transfer_match`

```text
id
user_id
debit_txn_id
credit_txn_id
status: suggested | confirmed | rejected
confidence
matched_by: system | user
reviewed_at nullable
created_at
```

Constraint:

- Debit และ Credit ต้องเป็นของ User เดียวกัน
- จำนวนเงินต้องเท่ากัน
- Transaction หนึ่งรายการมีคู่ confirmed ได้ไม่เกินหนึ่งคู่

### การปรับ `txn`

เพิ่มข้อมูลสำหรับ dedup และ transfer matching:

```text
txn_time nullable
source_row_no nullable
source_fingerprint nullable
```

ควรเก็บวันและเวลาแยก หรือใช้ `occurred_at` โดยกำหนด timezone เป็น `Asia/Bangkok`

### การปรับ `bank_account`

```text
account_purpose: personal | business
default_tax_entity_id nullable
archived_at nullable
```

เปลี่ยนการลบบัญชีจาก Hard Delete เป็น Archive เพื่อไม่ให้ Statement และ Transaction ประวัติสูญหาย

---

## 7.2 Monthly Planning

### `monthly_plan`

```text
id
user_id
month_start
status: open | closed
created_at
closed_at nullable
```

Constraints:

```text
unique (user_id, month_start)
month_start ต้องเป็นวันที่ 1 ของเดือน
```

### `recurring_rule`

```text
id
user_id
name
kind: income | payroll_deduction | expense | reserve
amount_mode: fixed | estimated
amount_satang
frequency_unit: day | week | month | year
frequency_interval
anchor_day nullable
start_date
end_date nullable
default_account_id nullable
category_id nullable
is_active
created_at
updated_at
```

กฎ:

- การแก้ Recurring Rule มีผลเฉพาะรายการในอนาคต
- หากกำหนดวันที่ 29–31 และเดือนนั้นไม่มีวันดังกล่าว ให้ใช้วันสุดท้ายของเดือน
- การสร้างรายการประจำต้อง idempotent

### `monthly_plan_item`

```text
id
monthly_plan_id
recurring_rule_id nullable
installment_due_id nullable
kind: income | payroll_deduction | expense | reserve
name
category_id nullable
planned_amount_satang
due_date nullable
explicit_status: active | skipped | cancelled
note nullable
created_at
updated_at
```

สถานะการจ่ายให้คำนวณจาก Payment และ Due Date ไม่เก็บซ้ำในตารางนี้

### `monthly_item_payment`

```text
id
monthly_plan_item_id
amount_satang
paid_date
bank_account_id
txn_id nullable
status: declared | matched | needs_review | cancelled
created_at
verified_at nullable
```

การ Mark paid จะสร้างแถว `declared` และรอจับคู่กับ `txn`

---

## 7.3 Installment

### `installment_plan`

```text
id
user_id
name
tax_entity_id nullable
category_id nullable
total_amount_satang
down_payment_satang
financed_amount_satang
interest_satang
fee_satang
installment_count
frequency_unit: day | month | year
frequency_interval
first_due_date
default_account_id nullable
status: active | completed | cancelled
created_at
updated_at
```

### `installment_due`

```text
id
installment_plan_id
installment_no
due_date
amount_satang
status: planned | partially_paid | paid | overdue | skipped
created_at
```

กฎ:

- ผลรวมทุกงวดต้องเท่ากับยอดที่ต้องชำระทั้งหมด
- งวดสุดท้ายรองรับเศษจากการหาร
- รองรับจ่ายบางส่วน
- รองรับจ่ายก่อนกำหนด
- ต้องแสดงยอดจ่ายแล้วและยอดคงเหลือ

---

## 7.4 Income และ Payroll Deduction

### `income_record`

```text
id
user_id
monthly_plan_id
name
gross_amount_satang
expected_net_satang
deposit_txn_id nullable
tax_entity_id
income_date nullable
created_at
updated_at
```

### `income_deduction`

```text
id
income_record_id
deduction_type: social_security | withholding_tax | other
name
amount_satang
tax_document_id nullable
```

สูตร:

```text
Expected Net Income
= Gross Income
- ผลรวม Income Deduction
```

กฎป้องกันการนับซ้ำ:

- Dashboard กระแสเงินสดจริงใช้ Credit จาก `txn`
- Monthly Plan ใช้ Gross Income หัก Deduction
- Tax Report ใช้ Gross Income และ Withholding Tax
- ห้ามรวม Gross Income และ Bank Credit เป็นรายได้สองก้อน

---

## 7.5 Tax

### `tax_entity`

```text
id
user_id
entity_type: individual | sole_proprietor | company
display_name
tax_id_enc nullable
vat_registered
is_active
created_at
```

ผู้ใช้หนึ่งคนมี Tax Entity ได้มากกว่าหนึ่งรายการ เช่น:

- บุคคลธรรมดา
- ร้านค้าหรือกิจการเจ้าของคนเดียว
- บริษัท

### `tax_document`

```text
id
user_id
tax_entity_id
document_type
tax_year
issuer_name
issuer_tax_id nullable
recipient_tax_id nullable
document_no nullable
issue_date nullable
subtotal_satang nullable
vat_satang nullable
total_satang
withholding_satang nullable
storage_path
file_sha256
status: draft | verified | submitted
created_at
updated_at
```

Document Type ขั้นต้น:

```text
tax_invoice
e_tax_invoice
receipt
withholding_certificate
insurance_certificate
donation_receipt
investment_certificate
other
```

### `tax_document_txn_link`

```text
id
tax_document_id
txn_id
linked_amount_satang
```

รองรับหนึ่งเอกสารเชื่อมหลาย Transaction และหนึ่ง Transaction เชื่อมหลายเอกสารได้

### `tax_deduction_claim`

```text
id
user_id
tax_entity_id
tax_year
deduction_type
eligible_amount_satang
claimed_amount_satang
tax_document_id nullable
note nullable
```

### `tax_calculation_snapshot`

```text
id
user_id
tax_entity_id
tax_year
rule_version
input_snapshot jsonb
result_snapshot jsonb
calculated_at
```

กฎ:

- Calculation ต้อง version ตามปีภาษี
- ห้ามรวม Tax Entity คนละประเภทในผลคำนวณเดียวกัน
- Bank Debit ไม่ถือเป็นค่าใช้จ่ายหักภาษีได้โดยอัตโนมัติ
- ผู้ใช้ต้องตรวจสอบและยืนยัน Tax Treatment
- ผลลัพธ์ใช้คำว่า “ประมาณการภาษี”

---

## 7.6 Audit Log

### `audit_log`

```text
id
user_id
action
entity_type
entity_id
before_data jsonb nullable
after_data jsonb nullable
ip_address nullable
created_at
```

ต้องบันทึกอย่างน้อย:

- เปลี่ยน Category หรือ Tax Treatment
- ยืนยันหรือยกเลิก Internal Transfer
- Mark paid หรือยกเลิก Payment
- แก้ Monthly Plan
- แก้ Installment
- เชื่อม Tax Document กับ Transaction
- แก้ค่าลดหย่อน
- Archive บัญชี
- ดาวน์โหลดเอกสารภาษี

---

## 8. Dashboard Requirements

## 8.1 Default View

- เปิดที่เดือนปัจจุบัน
- ผู้ใช้เลือกเดือนย้อนหลังได้
- แสดงเฉพาะข้อมูลของ User ที่ login อยู่
- แสดงวันที่ข้อมูลล่าสุดของแต่ละบัญชี
- แสดงคำเตือนเมื่อ Statement ของเดือนยังมาไม่ครบ

## 8.2 Summary Cards

### Planning

- รายได้เต็มตามแผน
- รายการหักจากรายได้
- ค่าใช้จ่ายตามแผน
- เงินกันไว้
- เงินเหลือใช้ตามแผน

สูตร:

```text
เงินเหลือใช้ตามแผน
= รายได้เต็ม
- รายการหักจากรายได้
- รายจ่ายตามแผน
- เงินกันไว้
```

### Actual Bank Data

- เงินเข้าจริงจาก Statement
- เงินออกจริงจาก Statement
- กระแสเงินสดสุทธิ
- ยอดคงเหลือล่าสุดรวม
- Internal Transfer ที่ไม่นับเป็นรายรับหรือรายจ่าย

### Payment Status

- รายการที่ต้องจ่ายทั้งหมด
- จ่ายแล้วแต่รอ Statement
- ยืนยันจาก Statement แล้ว
- จ่ายบางส่วน
- ยังไม่จ่าย
- เกินกำหนด

### Data Quality

- Transaction ที่ยังไม่จัดหมวด
- Transaction ที่ต้องตรวจสอบ
- Statement ที่ `parse_failed`
- Statement ที่ `checksum_failed`
- บัญชีที่ข้อมูลขาดช่วง

## 8.3 Transaction Table

คอลัมน์ขั้นต่ำ:

- วันที่และเวลา
- Description
- บัญชี
- เงินเข้า
- เงินออก
- Running Balance
- Category
- Personal/Business
- Internal Transfer
- Monthly Plan Item ที่จับคู่ไว้
- Tax Document
- Review Status

## 8.4 Filters

- เดือนหรือช่วงวันที่
- บัญชี
- ธนาคาร
- Category
- Credit/Debit
- Personal/Business
- Internal Transfer
- Tax Entity
- มีหรือไม่มี Tax Document
- Reviewed/Unreviewed
- จำนวนเงินขั้นต่ำและสูงสุด
- คำค้น Description/Counterparty

ต้องใช้ Server-side pagination และ aggregation

## 8.5 Charts

ลำดับความสำคัญ:

1. รายรับเทียบรายจ่ายรายเดือน
2. ค่าใช้จ่ายแยกตาม Category
3. แนวโน้มยอดคงเหลือตามบัญชี
4. Planned เทียบ Actual
5. ยอดหนี้และงวดคงเหลือ

Chart ทุกตัวต้อง Drill down ไปยัง Transaction หรือ Monthly Plan Item ต้นทางได้

## 8.6 Data Coverage Message

ทุกหน้ารายงานต้องระบุ:

```text
ข้อมูลเงินจริงคำนวณจาก Bank Statement ที่นำเข้าสู่ระบบเท่านั้น
ไม่รวมเงินสดและ e-Wallet
```

---

## 9. Monthly Planning Requirements

## 9.1 ประเภทรายการ

- Income
- Payroll Deduction
- Expense
- Reserve

## 9.2 รายการประจำ

กำหนดได้:

- ทุกกี่วัน สัปดาห์ เดือน หรือปี
- วันที่ครบกำหนด
- วันเริ่มต้นและวันสิ้นสุด
- ยอดคงที่หรือยอดประมาณการ
- Category
- บัญชีที่คาดว่าจะใช้
- ข้ามเฉพาะบางเดือนได้
- แก้เฉพาะเดือนนี้หรือแก้ทุกเดือนถัดไปได้

## 9.3 รายการเฉพาะเดือน

- เพิ่มได้โดยไม่สร้าง Recurring Rule
- Copy จากเดือนก่อน
- เปลี่ยนชื่อ ยอด Due Date และ Category ได้
- Cancel หรือ Skip โดยไม่ลบประวัติ

## 9.4 Reserve

Reserve:

- ลดเงินเหลือใช้ตามแผน
- ไม่เพิ่ม Expense Actual
- ไม่ลด Bank Balance
- ไม่เข้า Expense Chart
- ไม่เข้า Tax Expense

## 9.5 Mark Paid Workflow

```text
ผู้ใช้กด Mark paid
  → ระบุวันที่ ยอด และบัญชี
  → สร้าง monthly_item_payment.status = declared
  → แสดง “จ่ายแล้ว รอ Statement”
  → Statement มาถึง
  → ระบบค้นหา Candidate Transaction
  → Match หรือส่งให้ผู้ใช้ตรวจ
  → เปลี่ยนเป็น matched
```

เกณฑ์ Matching ขั้นต้น:

1. บัญชีเดียวกัน
2. เป็น Debit
3. จำนวนเงินตรงกัน
4. วันที่อยู่ในช่วง ±3 วัน
5. Transaction ยังไม่ถูกผูกกับ Payment อื่น
6. Description/Counterparty ใช้เพิ่ม Confidence

Auto-match ได้เฉพาะเมื่อมี Candidate เดียวและ Confidence ผ่านเกณฑ์ที่กำหนด

## 9.6 Monthly Closing

- ผู้ใช้สามารถปิดเดือนที่ตรวจสอบแล้ว
- เดือนที่ปิดแล้วแก้ได้เฉพาะผ่าน Explicit Reopen
- Recurring Rule ที่แก้ภายหลังห้ามย้อนมาแก้ข้อมูลเดือนปิดแล้ว
- เก็บ Snapshot Summary ตอนปิดเดือน

---

## 10. Tax Requirements

## 10.1 Personal และ Business Separation

- Bank Account มี Default Tax Entity
- Transaction สามารถ Override Tax Entity ได้
- Tax Document ต้องผูก Tax Entity
- Dashboard สามารถกรอง Personal/Business ได้
- Tax Calculation ต้องแยก Entity
- ห้ามรวมรายได้บุคคลธรรมดากับบริษัท

## 10.2 Tax Treatment

ค่าที่รองรับขั้นต้น:

```text
personal
business_income
business_expense
non_deductible
internal_transfer
excluded
```

## 10.3 Tax Document Workflow

ระยะแรก:

1. Upload PDF หรือรูปด้วยมือ
2. เลือก Attachment จาก Gmail
3. กรอก Metadata ด้วยมือ
4. เชื่อม Transaction
5. ผู้ใช้ตรวจสอบและ Mark Verified

ระยะหลัง:

- Text extraction จาก PDF
- OCR
- Duplicate document detection
- Suggested transaction matching

## 10.4 Storage Security

Tax Document อาจเป็นไฟล์ Plaintext จึงต้องมีมาตรการเพิ่มจาก Statement PDF:

- Encrypt binary file ก่อนลงดิสก์ หรือใช้ encrypted storage volume
- ใช้ File SHA-256 ป้องกันเอกสารซ้ำ
- ตรวจ Authorization ทุกครั้งก่อนเปิดไฟล์
- Audit การดาวน์โหลด
- กำหนด Retention Policy
- Backup แบบเข้ารหัส

## 10.5 Tax Calculation

- แยก Rule ตามปีภาษี
- เก็บ Calculation Snapshot ทุกครั้ง
- แสดง Input และที่มาของตัวเลข
- Drill down ไปยัง Income Record, Transaction และ Tax Document
- แสดงรายการที่ยังขาดเอกสารหรือยังไม่ Review
- รองรับ Export PDF/CSV ในระยะที่กำหนด

---

## 11. API Plan

ไม่มี Endpoint สำหรับสร้าง Transaction จริงด้วยมือ

### Transactions

```text
GET    /api/transactions
GET    /api/transactions/:id
PATCH  /api/transactions/:id/annotation
PUT    /api/transactions/:id/splits
POST   /api/transfer-matches/:id/confirm
POST   /api/transfer-matches/:id/reject
```

### Reports

```text
GET /api/reports/summary?month=YYYY-MM
GET /api/reports/cash-flow?from=YYYY-MM-DD&to=YYYY-MM-DD
GET /api/reports/category-breakdown?month=YYYY-MM
GET /api/reports/account-balances?month=YYYY-MM
GET /api/reports/data-coverage
```

### Monthly Planning

```text
GET    /api/monthly-plans/:month
POST   /api/monthly-plans/:month/items
PATCH  /api/monthly-plan-items/:id
POST   /api/monthly-plan-items/:id/payments
POST   /api/monthly-plan-items/:id/skip
POST   /api/monthly-plans/:month/close
POST   /api/monthly-plans/:month/reopen
```

### Recurring Rules

```text
GET    /api/recurring-rules
POST   /api/recurring-rules
PATCH  /api/recurring-rules/:id
POST   /api/recurring-rules/:id/archive
```

### Installments

```text
GET    /api/installment-plans
POST   /api/installment-plans
GET    /api/installment-plans/:id
PATCH  /api/installment-plans/:id
POST   /api/installment-dues/:id/payments
```

### Income

```text
GET    /api/income-records?month=YYYY-MM
POST   /api/income-records
PATCH  /api/income-records/:id
PUT    /api/income-records/:id/deductions
```

### Tax

```text
GET    /api/tax/entities
POST   /api/tax/entities
PATCH  /api/tax/entities/:id
GET    /api/tax/documents
POST   /api/tax/documents
PATCH  /api/tax/documents/:id
POST   /api/tax/documents/:id/links
GET    /api/tax/:year/summary
POST   /api/tax/:year/calculate
```

---

## 12. การจัดโครงสร้าง Code

## 12.1 Backend

แยก `src/api.ts` ออกเป็น Router ตาม Feature:

```text
src/routes/
  accounts.ts
  admin.ts
  transactions.ts
  reports.ts
  monthly-plans.ts
  recurring-rules.ts
  installments.ts
  income.ts
  tax.ts
```

เพิ่ม Service Layer สำหรับ Logic ที่มี Transaction หลายตาราง:

```text
src/services/
  transaction-classification.ts
  transfer-matching.ts
  recurring-generation.ts
  payment-reconciliation.ts
  report-query.ts
  tax-calculation.ts
  file-vault.ts
```

`src/api.ts` ทำหน้าที่ประกอบ Router เท่านั้น

## 12.2 Parser Registry

ปัจจุบัน UI/API สามารถเลือก Parser ที่ยังไม่มี Implementation จริงได้ ควรเปลี่ยนเป็น Registry กลาง:

```ts
const parsers = {
  scb: parseScbStatement,
};
```

API, Admin UI และ Worker ต้องอ่าน Parser Key จาก Registry เดียวกัน

## 12.3 Frontend

```text
web/src/pages/
  Dashboard.tsx
  Transactions.tsx
  MonthlyPlan.tsx
  Installments.tsx
  Tax.tsx
  Accounts.tsx
  Admin.tsx
```

```text
web/src/components/
  Money.tsx
  MonthPicker.tsx
  SummaryCard.tsx
  TransactionTable.tsx
  PaymentStatusChip.tsx
  DataFreshness.tsx
  ChartCard.tsx
```

เมื่อมีหน้ารายละเอียดและ Filter ที่แชร์ URL ควรใช้ Routing:

```text
/dashboard?month=2026-09
/transactions?account=12&from=2026-09-01
/monthly-plans/2026-09
/installments/7
/tax/2026/entities/3
```

---

## 13. Migration Plan

Migration ปัจจุบันสิ้นสุดที่ `004_statement_pdf_fingerprint.sql`

### `005_ledger_classification.sql`

- Category
- Transaction annotation
- Transaction split
- Transfer match
- Transaction time/fingerprint
- Bank account purpose
- Bank account archive

### `006_monthly_planning.sql`

- Monthly plan
- Recurring rule
- Monthly plan item
- Monthly item payment
- Monthly close snapshot

### `007_kbank_statement_parser.sql`

- Seed แถว bank สำหรับ KBank (ไม่อยู่ในแผนเดิม แทรกก่อน Slice 6 ทำให้เลข migration ของทุก slice ถัดจากนี้เลื่อน +1)

### `008_income_and_installments.sql`

- Income record
- Income deduction
- Installment plan
- Installment due

### `009_tax_document_vault.sql`

- Tax entity
- Tax document
- Tax document transaction link
- File fingerprint
- Audit log (เลื่อนมาจาก `010` เพราะ "ดาวน์โหลดเอกสารภาษี" ต้องถูก log ตั้งแต่ Slice 7 — §7.6)

### `010_tax_calculation_and_audit.sql`

- Tax deduction claim
- Tax calculation snapshot

แต่ละ Migration ต้องมี Roll-forward Test บนฐานข้อมูลใหม่และฐานข้อมูลที่มีข้อมูลเดิม

---

## 14. Roadmap

## Slice 4A — Ledger Integrity

เป้าหมาย: ทำให้ Transaction มีความหมายพร้อมใช้สร้างรายงาน

งาน:

- เพิ่ม Transaction time/source fingerprint
- เพิ่ม Category
- เพิ่ม Annotation และ Split
- เพิ่ม Internal Transfer Matching
- เพิ่ม Manual Override
- เปลี่ยน Account Delete เป็น Archive
- แยก Backend Router
- เพิ่ม Cross-user Authorization Tests

Definition of Done:

- ผู้ใช้จัดหมวดและแยกยอด Transaction ได้
- Internal Transfer ไม่ถูกนับเป็น Income/Expense
- User A เข้าถึงข้อมูล User B ไม่ได้
- ไม่สูญเสียข้อมูลเมื่อ Archive บัญชี

## Slice 4B — Dashboard และ Transaction Review

เป้าหมาย: แสดงรายงานเงินจริงจาก Statement ที่ตรวจสอบย้อนกลับได้

งาน:

- Transaction List API พร้อม Filter/Pagination
- Monthly Summary API
- Data Freshness และ Statement Health
- Dashboard Cards
- Transaction Table
- Income/Expense Chart
- Category Chart
- Account Balance Trend

Definition of Done:

- ผู้ใช้เห็นเงินเข้า เงินออก และยอดคงเหลือของตนเอง
- รายงานไม่นับ Internal Transfer
- ทุก Summary Drill down ไปยังรายการต้นทางได้
- แสดงวันที่ข้อมูลล่าสุดของแต่ละบัญชี

## Slice 5 — Monthly Planning

เป้าหมาย: แทนตารางรายเดือนในรูปเดิมด้วยระบบที่คำนวณได้

งาน:

- Monthly Plan ตามเดือนปฏิทิน
- Recurring Rule
- One-off Item
- Reserve
- Copy Previous Month
- Mark paid ก่อน Statement
- Payment Reconciliation
- Partial Payment
- Monthly Closing

Definition of Done:

- ผู้ใช้สร้างรายการประจำและเฉพาะเดือนได้
- Reserve ลดเงินเหลือใช้แต่ไม่เป็น Expense
- Mark paid ไม่สร้าง `txn`
- Payment ถูกจับคู่กับ Statement ภายหลังได้

## Slice 6 — Income และ Installment

เป้าหมาย: รองรับรายได้เต็ม รายการหัก และภาระผ่อน

งาน:

- Gross Income
- Social Security
- Withholding Tax
- Other Deduction
- Match Net Deposit
- Installment Plan
- Installment Due
- Partial/Advance Payment
- Outstanding Balance Report

Definition of Done:

- Gross Income และ Net Deposit ไม่ถูกนับซ้ำ
- แสดงยอดผ่อนทั้งหมด จ่ายแล้ว และคงเหลือ
- งวดสุดท้ายไม่คลาดเคลื่อนจากการหาร

## Slice 7 — Tax Document Vault

เป้าหมาย: เก็บและเชื่อมเอกสารภาษีอย่างปลอดภัย

งาน:

- Tax Entity
- Personal/Business Account Mapping
- Upload Tax Document
- Gmail Attachment Selection
- Encrypted File Storage
- Transaction Linking
- Verification Workflow
- Audit Log

Definition of Done:

- เอกสารทุกฉบับมีเจ้าของและ Tax Entity ชัดเจน
- User อื่นเปิดเอกสารไม่ได้
- ไฟล์ถูกเข้ารหัสและตรวจ Duplicate ได้
- ตรวจสอบย้อนกลับจากเอกสารไป Transaction ได้

## Slice 8 — Tax Calculation

เป้าหมาย: สรุปรายได้ ค่าใช้จ่าย และค่าลดหย่อนตาม Entity และปีภาษี

งาน:

- Tax Treatment
- Deduction Claims
- Versioned Tax Rules
- Calculation Snapshot
- Missing-document Report
- Tax Summary Dashboard
- Export

Definition of Done:

- คำนวณแยก Personal/Business
- แสดง Rule Version และ Input Snapshot
- ทุกยอด Drill down ไปยังข้อมูลต้นทางได้
- ผลลัพธ์ระบุว่าเป็นประมาณการ

---

## 15. Testing Strategy

## 15.1 Unit Tests

- Satang conversion
- Monthly recurrence
- วันที่ 29–31 ในเดือนสั้น
- Monthly Plan formula
- Reserve behavior
- Installment rounding
- Transfer matching score
- Payment reconciliation
- Gross-to-net income calculation
- Tax rule version selection

## 15.2 Integration Tests

- User A อ่าน/แก้ข้อมูล User B ไม่ได้
- Admin อ่าน Transaction ของ User ไม่ได้
- Mark paid ไม่สร้าง `txn`
- Statement ใหม่จับคู่ Payment Declaration ได้
- Split รวมแล้วเท่ากับ Transaction
- Internal Transfer ไม่เข้ารายงาน Income/Expense
- Personal Transaction ไม่เข้า Business Tax
- Archive Account ไม่ลบ Statement/Transaction

## 15.3 E2E Tests

- Login → เพิ่มบัญชี → Sync → ดู Dashboard
- Categorize Transaction → Dashboard เปลี่ยนตาม
- สร้าง Recurring Expense → Mark paid → Import Statement → Match
- สร้าง Gross Income → Match Net Credit
- สร้าง Installment → จ่ายบางส่วน → ดูยอดคงเหลือ
- Upload Tax Document → Link Transaction → Verify → Calculate

## 15.4 Regression Tests

Tests เดิมต้องผ่านทั้งหมด:

- Crypto
- Auth
- Gmail
- Account matching
- SCB parser
- Checksum
- Statement deduplication

---

## 16. Acceptance Criteria ระดับระบบ

1. User A ไม่มีทางอ่าน แก้ ลบ หรือ Export ข้อมูล User B
2. Dashboard ไม่รวมข้อมูลต่าง User
3. Transaction จริงสร้างได้จาก Statement Import เท่านั้น
4. Reserve ลดเงินเหลือใช้ตามแผน แต่ไม่เพิ่มยอดรายจ่ายจริง
5. Mark paid ไม่สร้าง `txn`
6. Payment ที่ยังไม่มี Statement แสดง “รอยืนยันจาก Statement”
7. Payment ที่ Match แล้วไม่ถูกหักยอดซ้ำ
8. Internal Transfer ไม่ถูกนับเป็นรายรับหรือรายจ่าย
9. Gross Income และ Net Bank Credit ไม่ถูกนับเป็นรายรับสองครั้ง
10. Transaction ของบัญชีธุรกิจไม่เข้า Personal Tax โดยอัตโนมัติ
11. Tax Document ผูกข้าม User หรือข้าม Tax Entity โดยไม่ตั้งใจไม่ได้
12. Dashboard แสดง Data Freshness ของทุกบัญชี
13. รายงานระบุว่าไม่รวมเงินสดและ e-Wallet
14. เงินทุกช่องใช้ `BIGINT` หน่วยสตางค์
15. การสร้างรายการประจำซ้ำต้องไม่เกิด Duplicate
16. เดือนที่ปิดแล้วไม่ถูกแก้จาก Recurring Rule ย้อนหลัง
17. ทุก Summary และ Chart ตรวจสอบย้อนกลับถึง Source Record ได้
18. Build และ Automated Tests ผ่านก่อน Merge

---

## 17. ความเสี่ยงและแนวทางลดความเสี่ยง

| ความเสี่ยง | แนวทาง |
|---|---|
| Statement ช้าได้หลายสัปดาห์ | แยก Planned, Declared และ Verified พร้อมแสดง Data Freshness |
| Auto-match ผิดรายการ | Auto-match เฉพาะ Candidate เดียวและ Confidence สูง |
| รายได้ถูกนับซ้ำ | แยก Gross Income ออกจาก Bank Credit และใช้ Link ชัดเจน |
| Internal Transfer ทำให้รายงานผิด | ต้องมี TransferMatch และ Manual Override ก่อน Dashboard สมบูรณ์ |
| Hard Delete ทำลายประวัติ | ใช้ Archive |
| Tax Rule เปลี่ยนทุกปี | Version Rule และเก็บ Calculation Snapshot |
| เอกสารภาษีรั่วไหล | Encrypt file, authorization, audit และ encrypted backup |
| Worker รันหลาย Instance | เปลี่ยน Memory Lock เป็น PostgreSQL Advisory Lock เมื่อ Scale |
| API file ใหญ่เกินไป | แยก Router และ Service ก่อนเพิ่ม Feature จำนวนมาก |

---

## 18. เอกสารที่ควรเพิ่มใน Repository

ก่อนเริ่ม Implementation ให้เพิ่ม ADR:

```text
docs/adr/0002-imported-transactions-monthly-planning-and-reconciliation.md
```

ADR ต้องบันทึกอย่างน้อย:

- `txn` เป็นข้อมูลจริงจาก Statement เท่านั้น
- Monthly Planning เป็นข้อมูลคนละขอบเขต
- Mark paid ใช้ Payment Declaration
- Reserve ไม่ใช่ Expense
- Gross Income แยกจาก Net Bank Credit
- ไม่มี Cash/e-Wallet Manual Transaction
- รายงานแยก User อย่างเด็ดขาด
- Tax แยกตาม Tax Entity

ควรอัปเดต:

- `CONTEXT.md`
- `docs/status.md`
- `docs/plans/personalfinancesystemplan.md`
- `PRODUCT.md` หากคำว่า “ระดับครอบครัว” ทำให้เข้าใจว่าเป็นรายงานรวมหลาย User

---

## 19. ลำดับเริ่มงานที่แนะนำ

```text
ADR-0002
  → Migration 005
  → Ledger Classification API
  → Cross-user Security Tests
  → Transaction Review UI
  → Dashboard
  → Monthly Planning
  → Income/Installment
  → Tax Document
  → Tax Calculation
```

ห้ามเริ่ม Tax Calculation หรือ Dashboard ที่นำไปใช้ตัดสินใจจริง ก่อน Category, Internal Transfer และ Data Freshness พร้อมใช้งาน
