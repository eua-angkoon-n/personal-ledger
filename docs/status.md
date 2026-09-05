# สถานะงาน — 2026-09-05

ข้อบังคับและท่อข้อมูลอยู่ที่ `CONTEXT.md` · การตัดสินใจอยู่ที่ `docs/adr/0001-statement-pdf-ingestion.md`
และ `docs/adr/0002-imported-transactions-monthly-planning-and-reconciliation.md`

## Git

- บน `master`, ล่าสุดถึง Slice 8 (Tax Calculation) — ดูรายละเอียดที่ section ของแต่ละ Slice ด้านล่าง
- หลัง Slice 1–3 มีงาน rebrand เป็น "Hyacinthia Ledger" และ redesign หน้าเว็บทั้งหมดด้วย MUI
  (โฟลเดอร์/`package.json` ยังชื่อ `family-ledger` — ยังไม่ได้ตามรีเนม)
- PDF, `.eml`, `.env` และ `data/` ถูก ignore ไม่เข้า git

## Slice 1 — โครงระบบ: เสร็จ

- PostgreSQL + migration runner
- Google OAuth, invite code, session, สิทธิ์ user/admin
- เข้ารหัส refresh token และรหัสผ่าน PDF ด้วย AES-256-GCM
- Docker image มี qpdf + pdftotext, app publish เฉพาะ `127.0.0.1:3001`
- หน้า admin CRUD ธนาคาร/ผู้ใช้ และหน้า user CRUD บัญชีธนาคาร

## Slice 2 — ท่อรับอีเมล: เสร็จและผ่าน Gmail จริง

- poll Gmail, incremental history + full-sync fallback
- ตรวจ From + DKIM จาก `Authentication-Results` ของ `mx.google.com`
- SCB ส่ง PDF เป็น `application/octet-stream`: รับเฉพาะชื่อที่ตรง patternและ magic bytes `%PDF-`
- รองรับหลาย PDF ต่ออีเมล (อีเมลย้อนหลัง SCB จริงแนบ 8 ไฟล์)
- dedup ไฟล์ด้วย SHA-256 ของ PDF เข้ารหัส เพราะ Gmail `attachmentId` เปลี่ยนได้ระหว่างการอ่าน
- PDF ที่ถอดรหัสแล้วไหลผ่าน `qpdf | pdftotext` เท่านั้น ไม่ลงดิสก์

## Slice 3 — SCB parser + checksum + txn: เสร็จและผ่าน E2E

รองรับ layout ที่พบจริง 3 แบบ:

1. e-Passbook รายเดือน — ปี พ.ศ., บัญชีปิดบัง, คอลัมน์ถอน/ฝาก
2. Statement ย้อนหลังรุ่นปัจจุบัน — ช่วงวันที่/บัญชีเต็ม, Debit/Credit, running balance
3. Statement ย้อนหลังรุ่นเก่า — code/channel ช่องเดียวและเวลาอยู่บรรทัดถัดไป

รองรับ edge case ที่พบระหว่าง full sync:

- event จำนวนเงิน `0.00` เช่น onboarding — ไม่นับเป็น `txn`
- เดือนที่มีเฉพาะเครดิตหรือเดบิต
- statement `No data` / ไม่มี opening balance — parse ช่วงเวลาได้ แต่ตั้ง `checksum_failed` โดยไม่เดายอด
- statement รายเดือนและย้อนหลังทับเดือนกัน — เก็บ artifact ทั้งคู่และ dedup ที่ `txn`

ผลตรวจระบบจริง:

- full sync สแกน 31 อีเมล
- เก็บ statement ไม่ซ้ำ 38 PDF (`pdf_sha256` ไม่ซ้ำ 38 ค่า)
- `parsed` 36 statement
- `checksum_failed` 2 statement — ทั้งสองไม่มีรายการและไม่มี opening balance จึงตรวจยอดไม่ได้
- เขียน `txn` 78 แถว, จำนวนเงินต่ำสุด 1 สตางค์
- dedup รายการที่ทับกัน 39 แถว
- full sync รอบถัดไป: `statements_inserted: 0`; จำนวน statement/txn ไม่เพิ่ม
- automated tests และ production build ผ่าน

## ยังไม่ได้ยืนยัน

- statement หลายหน้า (ตัวอย่างทั้งหมดที่พบเป็นหน้าเดียว)
- `/auth/google?add=1` สำหรับกล่องอีเมลใบที่สอง
- หลายบัญชี SCB ในกล่องเดียวกันแบบ E2E (โค้ดจับคู่เลขบัญชีเต็ม/ปิดบังรองรับแล้ว)

## KBank parser: เสร็จและผ่านไฟล์จริง

- รองรับบัญชีออมทรัพย์ทั้ง statement รายเดือนและ statement ตามช่วงเวลาที่ร้องขอ
- ไฟล์ร้องขอหลายเดือนเก็บเป็น statement เดียว และ dedup กับไฟล์รายเดือนด้วยกลไกเดิม
- ตรวจยอดยกมา/ยอดยกไป ยอดรวมและจำนวนรายการถอน-ฝาก และ running balance ทุกแถว/ทุกหน้า
- เลือกเฉพาะไฟล์ `STM_SA…pdf` จึงไม่หยิบคู่มือ `channel_bankuse.pdf`
- fixture ที่ commit เป็นข้อมูลสังเคราะห์; PDF/EML จริงและรหัสผ่านไม่เข้า git
- ตรวจไฟล์จริงแล้ว: รายเดือน 90 รายการ, แบบร้องขอ 191 รายการ และ checksum ผ่านทั้งคู่
- หลัง deploy บัญชี KBank เดิมต้องสั่ง Full sync หนึ่งครั้ง; บัญชีที่สร้างใหม่ใช้ backfill เดิมอัตโนมัติ

## ตั้งค่า local ที่ต้องแก้ก่อน deploy

`docker-compose.yml` ใช้ `NODE_ENV: development` เพื่อทดสอบผ่าน HTTP localhost ก่อน deploy หลัง Caddy/HTTPS
ต้องเปลี่ยนเป็น `production` เพื่อให้ session cookie เป็น `secure:true`

## Requirement ที่ยังไม่มี Slice รองรับ

- Tax Invoice / `TaxInvoiceRecord`
- audit log การเข้าถึงและแก้ไขข้อมูล
- `txn.category_id` และตาราง category

## Slice 4+ — วางแผนแล้ว แตกเป็นเอกสารรายเฟส

แผนเต็ม (`docs/plans/hyacinthia-ledger-feature-plan.md`) ใหญ่เกินจะทำรอบเดียว แตกเป็น
`docs/plans/phases/README.md` + ไฟล์ต่อเฟส (4A–8) ตามลำดับพึ่งพา §19 ของแผนเดิม

**Slice 4A — Ledger Integrity: T1–T8 เสร็จแล้ว** (`docs/plans/phases/4a-ledger-integrity.md`)

- test harness ต่อ Postgres จริง (`npm run test:db`), migration 005, แยก router + parser registry,
  ledger classification API (category/annotation/split/transfer-match), `txn_time`, archive แทน hard delete,
  cross-user authz tests, ผ่าน `ledger-reviewer` แล้ว 1 รอบ (73 test ผ่านหมด)
- บั๊กที่เจอระหว่าง review และแก้แล้วทั้งหมด: reject transfer-match ไม่ล้าง `is_internal_transfer`,
  `npm test` ข้าม Postgres test ไปเงียบ ๆ (เพิ่ม `npm run test:db`), admin reject ผู้ใช้ที่มี bank account
  ชน FK 23503 ถาวร (Slice 1 เดิมแต่ archive ใน T6 ปิดทางแก้ทางอ้อม)
- ตัดสินใจแล้ว: archive ยังไม่มี unarchive ใน 4A (known limitation), `suggestTransferMatches` ต่อสายเข้า
  production path เป็นงานแรกของ Slice 4B แทน (ดู `docs/plans/phases/4b-dashboard.md`)

**Slice 4B — Dashboard + Transaction Review: เสร็จแล้ว** (`docs/plans/phases/4b-dashboard.md`)

- `suggestTransferMatches` ต่อสายเข้า `worker.ts:doSync` แล้ว, `GET /api/transfer-matches?status=suggested`,
  `PUT /transactions/:id/splits` รับ array ว่าง (ล้าง split คืน), `GET /api/transactions` (+`:id`),
  5 report endpoint (`summary`/`category-breakdown`/`cash-flow`/`account-balances`/`data-coverage`)
- `web/src/pages/Dashboard.tsx` (การ์ดสรุป + 3 กราฟ `@mui/x-charts`) และ `web/src/pages/Transactions.tsx`
  (ตาราง filter ผ่าน URL + `ReviewDrawer` จัดหมวด/แบ่งสัดส่วน/ยืนยันคู่โอน) — router คือ `react-router-dom`
- ADR-0003 บันทึก `DESIGN.md` ทับ `personalfinancesystemplan.md` §3 แล้ว (ปิดหัวข้อ "ค้างเรื่อง UI
  design guideline" ด้านล่าง — เอกสารนั้นเป็นประวัติ ไม่ใช้ตัดสินงานอีกต่อไป)
- `ledger-reviewer` ผ่าน 2 รอบ (backend diff, UI diff) ทุก major finding แก้แล้ว — 92/92 test ผ่าน,
  `npm run build` สะอาด
- **ยกไป Slice 5/7 โดยตั้งใจ**: Planning + Payment Status card (§8.2 — placeholder ปิดอยู่จริงในโค้ด
  และ **Slice 5 เปิดใช้แล้ว**), filter Tax Entity/Tax Document (§8.4)
  หมายเหตุแก้ของเดิม: บรรทัดนี้เคยเขียนว่าคอลัมน์ Monthly Plan Item (§8.3) มี placeholder อยู่ใน UI
  — ไม่จริง `TransactionTable.tsx` ไม่เคยมีคอลัมน์นั้นหรือป้ายบอกเลย (grep แล้วไม่พบ) ยังไม่ได้ทำถึงตอนนี้
- **ข้อจำกัดที่รู้ตัว** (ตั้งใจไม่แก้ในเฟสนี้):
  - `classification='excluded'` reconcile ไม่ได้ระหว่างรายงานกับรายการ: รายงานตัด `excluded` ออก
    แต่ `GET /api/transactions` (และ `TXN_FILTER_SQL`) ไม่มี filter ของมัน — drill-down จากการ์ด/กราฟ
    จึงมีบางแถวที่การ์ดไม่ได้นับโผล่ในตาราง ยอดรวมแถวที่เห็นจึงไม่เท่ากับตัวเลขบนการ์ดเป๊ะเมื่อมี excluded
  - กฎ data-coverage (§8.1) จับได้แค่ "บัญชีตกหลัง" ที่ปลายช่วง จับรูช่วงกลาง (parsed ม.ค.+มี.ค. ขาด ก.พ.),
    gap ระดับวัน, หรือเดือนของ statement ที่ `parse_failed` ไม่ได้
  - ไม่มี index `(bank_account_id, txn_date desc, id desc)` — `GET /api/transactions` sort ทั้งชุดต่อหน้า
    (offset pagination) ทางอัปเกรดคือเพิ่ม index ก่อน แล้วค่อยไป keyset
  - `txn.counterparty` เป็น NULL ตลอด (`worker.ts` ไม่เคย insert คอลัมน์นี้) — `q` filter ค้นได้แค่ `description`
  - `parse_failed`/`checksum_failed` count ใน `/reports/summary` เป็น**ทั้งหมดต่อ user** ไม่ใช่ต่อเดือน
    (`period_start`/`period_end` เป็น NULL บนแถวล้มเหลว) ไม่ขยับตามเดือนที่เลือกโดยตั้งใจ
  - `total_balance_satang` ในการ์ดสรุปไม่มี drill-down (ยอดรวมข้ามหลายบัญชี ไม่มี source record เดียวให้ชี้)
  - reviewer finding ระดับ minor ที่ยังไม่แก้: query array-param (`month`/`q` รับ array แล้วไม่ validate
    เป็น 400), `maxMonths` off-by-one ใน `parseRange`, บัญชี archived นับใน cash-flow แต่ไม่นับใน
    account-balances (ไม่สอดคล้องกัน)
- **ยังไม่ผ่านการทดสอบด้วยตา/browser จริง** — environment นี้ไม่มี browser automation tool และต้องใช้
  Google OAuth session จริง `npm run test:db` (92/92) และ `npm run build` (สะอาด) ยืนยันว่า compile/logic
  ถูกต้อง แต่ไม่ยืนยัน layout, การ render กราฟ, หรือว่าคลิก drill-down แล้ว navigate ไปถูกจริงในเบราว์เซอร์
## Slice 5 — Monthly Planning: เสร็จแล้ว

เอกสารเฟส: `docs/plans/phases/5-monthly-planning.md` · migration `006_monthly_planning.sql`

- 4 ตารางตาม §7.2 (`monthly_plan`, `recurring_rule`, `monthly_plan_item`, `monthly_item_payment`)
  + `monthly_plan.closed_snapshot jsonb` แทนตาราง "monthly close snapshot" ที่ §13 ระบุไว้แต่ §7.2 ไม่ให้ schema
- invariant สำคัญบังคับที่ DB ไม่ใช่ application: `month_start` ต้องเป็นวันที่ 1,
  `monthly_plan_item_rule_uniq (monthly_plan_id, recurring_rule_id, occurrence_date)` = idempotency ของการ generate,
  `monthly_item_payment_txn_matched_uniq (txn_id) where status='matched'` = §9.5 เกณฑ์ข้อ 5,
  `check (status <> 'matched' or txn_id is not null)`,
  `check (recurring_rule_id is null or occurrence_date is not null)`
- service: `recurring-generation.ts` (`occurrencesInMonth` pure + generate แบบ **insert-only**),
  `plan-query.ts` (`PAYMENT_STATE_SQL`/`planTotals`/`paymentStatusSummary`/`loadOwnedItem`/`assertOwnedRefs`),
  `payment-reconciliation.ts` (เกณฑ์ §9.5 ครบ auto-match เฉพาะ candidate เดียว)
- route: `monthly-plans.ts` (GET เดือน + items + copy-previous + skip + payments + close/reopen +
  PATCH payment) และ `recurring-rules.ts` (CRUD + archive) — `reconcilePayments` ต่อสายทั้งใน
  `worker.ts:doSync` และใน `POST /monthly-plan-items/:id/payments`
- web: `web/src/pages/MonthlyPlan.tsx` (`/planning?month=`), `PaymentStatusChip.tsx`,
  `MonthPicker` รับ `maxMonth` เพื่อเลือกเดือนอนาคตได้, การ์ด "เงินเหลือใช้ตามแผน" และ
  "สถานะการจ่ายบิล" ใน `Dashboard.tsx` เปิดใช้จริงแล้ว (คลิกไป `/planning`)
- error handler กลางใน `server.ts` แปลง `23514` (CHECK constraint) เป็น 400 แทน 500
- **125/125 test ผ่าน** (`npm run test:db`) เพิ่มจาก 92: `test/recurring.test.ts` (pure ไม่ต้อง DB),
  `test/monthly-plans.test.ts`, `test/authz.test.ts` ข้อ 17–24, `test/migrate.test.ts` subtest ของ 006
  · `npm run build` สะอาด

### บั๊กที่ `ledger-reviewer` จับได้และแก้แล้วในเฟสนี้

**ขอบเขตที่รีวิวจริง:** reviewer ทั้งสองตัว (backend diff, UI diff) รันบนโค้ด**ก่อน**แก้ ทุก finding
ด้านล่างแก้แล้ว แต่ตัวการแก้เองยังไม่ผ่านรีวิว — โดยเฉพาะ `occurrence_date` (เปลี่ยน schema),
การเลิก backfill เดือนอดีต (เปลี่ยนพฤติกรรม) และ `MonthlyPlan.tsx` ที่เพิ่มอีก ~200 บรรทัด
(รายการจ่าย + ปุ่มยกเลิก, เอากลับเข้าแผน, ยืนยันก่อนเลิกใช้กฎ, กรอบ ±3 วัน)
ฝั่ง backend มี test คุมทุกข้อ ฝั่ง UI **ไม่มี test เลยและไม่เคยเปิดดูในเบราว์เซอร์**

- **`due_date` เป็นคีย์กันซ้ำของ generation ไม่ได้** (finding รุนแรงสุด) — §9.3 ให้ผู้ใช้เลื่อน due_date
  เฉพาะเดือนนี้ได้ แต่ตอนนั้น unique index ใช้ due_date เป็นคีย์ เลื่อนแล้ว (หรือเซ็ต null ซึ่ง NULL
  ไม่ชน unique index) GET รอบหน้าจะ insert แถวเดิมกลับมาที่วันเดิม → รายการซ้ำ ยอดตามแผนเด้งเป็นสองเท่า
  และถ้า skip ไว้ก่อนก็ถูกย้อนเงียบ ๆ **แก้โดยแยก `occurrence_date`** ที่ generation เป็นเจ้าของและ
  ผู้ใช้แก้ไม่ได้ ให้เป็นคีย์ ส่วน `due_date` ยังเลื่อนได้ตามสเปก
- **insert-only ไม่พอกันการแก้กฎย้อนอดีต** — กันการ *แก้* แถวเดิมได้ แต่ไม่กันการ *เพิ่ม* แถวใหม่
  แก้ `anchor_day` 5 → 20 แล้วเปิดดูเดือนที่แล้วที่ยัง open จะได้ทั้งวันที่ 5 และ 20
  แก้โดย `generateMonthlyItems` ไม่ generate เดือนที่ผ่านไปแล้วเลย
- **`planned_amount_satang = 0` ขึ้นว่า verified** จาก `0 >= 0` — เติม `matched_satang > 0` ในสาขานั้น
- **ยืนยันคู่ด้วยมือตรวจแค่ "เป็นบัญชีของ user"** ผูก payment 100,000 กับ txn 10 บาทได้แล้วขึ้นว่ายืนยันแล้ว
  (`matched_satang` นับยอดของ payment) — เพิ่มการตรวจยอดและทิศทางให้ครบเหมือน auto-match
- **reconcile ดูด txn ไปจองให้รายการที่ skip/cancel แล้ว** ทำให้ payment ที่ถูกต้องจับ txn ตัวนั้นไม่ได้อีก
  — เพิ่ม `and i.explicit_status = 'active'`
- **`satang()` ไม่มีเพดาน** `1e300` ผ่าน `Number.isInteger` แล้ว pg ส่ง `"1e+300"` เป็น bigint → 500
  (คลาสเดียวกับที่พบเองว่า `isoDate` รับ `2026-02-31` แล้วได้ 500)
- **`run()` ฝั่งเว็บกลืน error ของปุ่มบนแถบเครื่องมือ** (คัดลอกเดือนก่อน/ปิด-เปิดเดือน/ข้าม/เลิกใช้)
  เพราะ `formError` render อยู่ใน modal เท่านั้น — ไม่มี modal เปิดให้ส่งเข้า snackbar
- UI อื่นที่แก้: `PaymentStatusChip` เลิกใช้สี `warning` (ไม่มีใน `theme.ts`) และ `primary`
  (สงวนไว้สำหรับ action ตาม Restrained Accent Rule) เปลี่ยนไปใช้ไอคอนแยกความหมายแบบ `DataFreshness.tsx`;
  กล่องเลือกคู่ค้น candidate ในกรอบ ±3 วันให้ตรงกับเกณฑ์ที่ระบบใช้จริง (เดิมใช้ "เดือนของ paid_date"
  ซึ่งกลางเดือนเสนอ txn ห่าง 30 วัน และต้นเดือนซ่อน candidate ปลายเดือนก่อน) + guard response
  ที่มาไม่เรียงลำดับ + สถานะกำลังโหลด; ปุ่มล็อกเดือนรอ `plan` ของเดือนนั้นก่อนจึงกดได้;
  กล่องจ่ายแสดงรายการที่ประกาศไว้พร้อมปุ่มยกเลิก และปุ่ม "ข้าม" สลับเป็น "เอากลับเข้าแผน"
  (สอง endpoint นี้มีใน API อยู่แล้วแต่ UI เดิมเข้าไม่ถึง); "เลิกใช้" รายการประจำถามยืนยันก่อน
  เพราะไม่มี unarchive; validate `frequency_interval`/`anchor_day` ก่อนส่ง (เดิม NaN → null →
  กลายเป็น "ทุก 1" เงียบ ๆ); คืน focus หลัง dialog ที่ปุ่มต้นทางหายไป

### การตัดสินใจที่ต้องรู้ก่อนแก้ต่อ

- **`closed_snapshot` เป็น audit เท่านั้น** ทั้งหน้าแผนและการ์ด Dashboard อ่านสถานะสดจาก
  `PAYMENT_STATE_SQL` เสมอไม่ว่าเดือนจะ open หรือ closed — ถ้าเปลี่ยนไป render จาก snapshot
  statement ที่มาช้าแล้วจับคู่สำเร็จจะไม่ปรากฏบนจอเลย
- **reconcile จับคู่เข้าเดือนที่ปิดแล้วได้** (ตัดสินใจร่วมกับเจ้าของงาน) เพราะไม่เปลี่ยนตัวเลขตามแผน
  ที่ล็อกคือการแก้ของผู้ใช้ ผ่าน `loadOwnedItem(..., { requireOpen: true })`
- **generation เป็น insert-only** (`on conflict do nothing`) ห้ามเปลี่ยนเป็น upsert เด็ดขาด —
  เป็นกลไกเดียวที่ทำให้การแก้ `recurring_rule` ไม่ย้อนแก้เดือนที่ปิดแล้ว (§16 ข้อ 16)
  ผลตามมา: item ที่ `skipped`/`cancelled` ห้ามลบ แถวต้องอยู่เพื่อกัน re-insert จึงไม่มี DELETE endpoint
- **`occurrence_date` ห้ามให้ผู้ใช้แก้** เป็นคีย์กันสร้างซ้ำ ถ้าวันไหนเปิดให้ PATCH ได้ บั๊กแถวซ้ำ
  ที่แก้ไปแล้วจะกลับมาทันที
- **ยืนยันคู่ด้วยมือบังคับยอด/ทิศทาง/บัญชี แต่ไม่บังคับกรอบ ±3 วัน** — ขั้นตอนนี้คือให้คนตัดสินสิ่งที่
  ระบบตัดสินไม่ได้ วันที่คลาดกันได้จริงเวลาธนาคารลงรายการช้า แต่ยอดกับทิศทางเป็นข้อเท็จจริงที่ต่อรองไม่ได้
  (UI ค้น candidate ในกรอบ ±3 วันเพื่อให้ตรงกับที่ระบบพิจารณา)
- **`reconcilePayments` รับเฉพาะ `Pool` ไม่ใช่ `Queryable`** เพราะกลืน 23505 ต่อแถวแล้วไปต่อ ซึ่งถูกต้อง
  เฉพาะเมื่อแต่ละ update เป็น transaction ของตัวเอง — ถ้าเรียกด้วย `PoolClient` ใน `tx()` error แรก
  จะ abort ทั้ง transaction แล้ว query ที่เหลือพังด้วย 25P02 เงียบ ๆ
- **ทิศทาง txn ตอนจับคู่ขยายจากสเปก**: §9.5 ข้อ 2 เขียน "เป็น Debit" (คิดถึงบิล) โค้ดใช้ `credit`
  สำหรับ item `kind='income'` และ `debit` สำหรับที่เหลือ
- `installment_due_id` เป็น `bigint` เปล่าไม่มี FK ตาม precedent `tax_entity_id` ใน 005 — Slice 6 ค่อยใส่ FK

### ข้อจำกัดที่รู้ตัว (ตั้งใจไม่แก้ในเฟสนี้)

- **ยังไม่เคยเปิดดูในเบราว์เซอร์จริง** — environment นี้ไม่มี browser automation และต้องมี Google OAuth
  session จริง `npm run test:db` + `npm run build` ยืนยัน compile/logic ไม่ยืนยัน layout หรือการคลิกจริง
- คอลัมน์ Monthly Plan Item ในตารางธุรกรรม (§8.3) และกราฟ Planned vs Actual (§8.5 ลำดับ 4) ยกไปเฟสหลัง
- ไม่มี confidence scoring (§9.5 ข้อ 6): `txn.counterparty` เป็น NULL ตลอด และ §7.2 ไม่มีคอลัมน์
  confidence บน `monthly_item_payment` ให้เก็บ — auto-match ยึดเงื่อนไข "candidate เดียว" อย่างเดียว
- `GET /api/monthly-plans/:month` มี side effect (สร้างแถวแผน + กางรายการประจำ) เพราะ §11 ไม่มี endpoint
  generate แยก ผลคือการเปิดดูเดือนย้อนหลัง (รวมจาก Dashboard) สร้างแถวแผน**เปล่า**ของเดือนนั้นขึ้นมา —
  idempotent และมีเพดาน 12 เดือนข้างหน้า แต่ไม่มีเพดานฝั่งอดีต
- **เดือนที่ผ่านไปแล้วไม่มีรายการประจำให้** เพราะ generation ไม่ backfill ย้อนหลัง (ตามที่ §9.2 บังคับว่า
  การแก้กฎมีผลเฉพาะอนาคต) ผลที่ยอมรับ: ตั้งค่ารายการประจำวันนี้แล้วเปิดดูเดือนก่อน ๆ จะเห็นแผนว่าง
  ถ้าวันหนึ่งต้องกรอกแผนย้อนหลังจริง ให้เพิ่มเป็นรายการเฉพาะเดือนหรือใช้ปุ่มคัดลอกเดือนก่อน
- ไม่มีปุ่มเปิดใช้กฎที่ archive แล้วกลับ (`is_active = false` ทางเดียว) ต้องสร้างกฎใหม่
- `copy-previous` กันซ้ำด้วย `(kind, name)` เท่านั้น เดือนก่อนมีสองรายการชื่อเดียวกันจะ copy มาใบเดียว
- รายการประจำความถี่ `day` interval 1 สร้าง ~30 แถวต่อเดือนตามสเปก ไม่มีเพดานจำนวนแถวต่อเดือน
- ยังไม่มี endpoint ลบ `recurring_rule` (archive เท่านั้น) และไม่มี unarchive ทั้งของ rule และ bank account

## Slice 6 — Income & Installment: เสร็จแล้ว

- Migration `008_income_and_installments.sql` — `income_record`, `income_deduction`, `installment_plan`, `installment_due`
  (เลื่อนจาก `007` เพราะ `007_kbank_statement_parser.sql` แทรกก่อนโดยไม่อยู่ในแผนเดิม)
- ผูก income record เข้ากับ monthly plan item เดิม, จับคู่ยอดสุทธิกับ deposit จริงอัตโนมัติเมื่อยอดตรง
- Installment plan คำนวณงวด (anchor date, เงินดาวน์, เศษงวดสุดท้าย) และผูก due เข้า monthly plan item
  ผ่าน `monthly_plan_item_installment_due_fk` ที่ใส่ FK ทีหลังตาม precedent การเลื่อน FK ข้ามสไลซ์
- หน้า `Installments.tsx` + `IncomeSection.tsx` ใน web
- `npm run test:db` ผ่านทั้งหมด (140 ก่อนเริ่ม Slice 7)

## Slice 7 — Tax Document Vault: เสร็จแล้ว

- Migration `009_tax_document_vault.sql` — `tax_entity`, `tax_document`, `tax_document_txn_link`, `audit_log`
  (สร้าง `audit_log` ที่นี่ไม่ใช่ Slice 8 เพราะ DoD ของสไลซ์นี้ต้องการ audit การดาวน์โหลด — ดูรายละเอียด
  ในหมายเหตุของ `docs/plans/phases/7-tax-document-vault.md`) รวมถึง `bank_account.default_tax_entity_id`
  และ FK `txn_annotation.tax_entity_id` ที่เลื่อนมาจาก migration 005
- Buffer เข้ารหัสไฟล์ (`encryptBuffer`/`decryptBuffer` ใน `src/crypto.ts`) คู่กับของสตริงเดิม — ไฟล์บนดิสก์
  เป็น `iv|tag|ciphertext` ดิบ เก็บไว้ที่ `TAX_DOC_STORAGE_DIR` (default `./data/tax-docs`) แยกจาก `PDF_STORAGE_DIR`
- Upload ผ่าน base64 ใน JSON ไม่ใช่ multipart (ไม่เพิ่ม dependency) — ต้อง mount
  `express.json({limit:'15mb'})` ที่ `/api/tax-documents` **ก่อน** ตัวจำกัด 100kb ทั่วไปใน `server.ts`
  เพดานไฟล์จริงหลัง decode คือ 10MB (route บังคับเอง)
- Dedup ด้วย SHA-256 ของ plaintext ก่อนเข้ารหัส ต่อ user (คนละคนถือใบเสร็จใบเดียวกันได้)
- Authorization ทุกครั้งก่อนเปิดไฟล์ (`user_id` ตรง ไม่มีข้อยกเว้นให้ admin) และ log
  `tax_document.download` ก่อน commit เสมอก่อนส่งไบต์ออก — log ล้ม = ไม่ได้ไฟล์
- §10.1 "Personal/Business Account Mapping" ครบทั้งสองฝั่ง: `bank_account.default_tax_entity_id` (ตั้งใน
  `Accounts.tsx`) และ `PATCH /transactions/:id/annotation` รับ `tax_entity_id` เพื่อ override ต่อธุรกรรมได้
  (ไม่ส่ง field มา = ไม่แตะค่าเดิม ต่างจาก classification/note ที่ full-replace ทุกครั้ง — ดู comment ใน
  `src/routes/transactions.ts`) — Slice 8 (Tax Calculation) มีหน้าที่ *ใช้* ค่านี้ตัดสิน entity ต่อธุรกรรม
  ตอนคำนวณภาษี ไม่ใช่สร้างกลไกนี้
- Gmail Attachment Selection ใช้ `listMessages`/`listAttachments` ที่ generalize มาจาก
  `listMessagesFromSender`/`pickPdfAttachments` เดิมของ worker (พฤติกรรม worker ไม่เปลี่ยน)
- หน้า `TaxDocuments.tsx` + `TaxDocumentDrawer`/`TaxDocumentUploadModal`/`GmailAttachmentPicker`
  ใน web, จัดการ Tax Entity ในหน้า `Accounts.tsx`
- `npm run test:db` ผ่านทั้งหมด 161 เทสต์ (รวม `test/tax-documents.test.ts` ใหม่ และเคส cross-user
  ใน `test/authz.test.ts` ตาม ADR-0002 ข้อ 7)
- **ยังไม่เคยเปิดดูในเบราว์เซอร์จริง** เหมือนทุกเฟสก่อนหน้า — environment นี้ไม่มี browser automation
  ยืนยันได้แค่ `npm run test:db` + `npm run build` (typecheck ทั้ง backend/web + vite build ผ่าน) ไม่ยืนยัน
  layout, การอัปโหลดไฟล์จริงผ่าน `<input type="file">`, หรือ flow การเลือกไฟล์แนบจาก Gmail จริง

## Slice 8 — Tax Calculation: เสร็จแล้ว

- Migration `010_tax_calculation_and_audit.sql` — `txn_annotation.tax_treatment` (6 ค่าตาม §10.2, nullable
  ไม่มี default โดยเจตนา — §7.5 ห้าม Bank Debit ถือเป็นค่าใช้จ่ายหักภาษีได้เองโดยไม่มีคนตัดสิน), `tax_deduction_claim`,
  `tax_calculation_snapshot` (`audit_log` มีแล้วตั้งแต่ 009 ไม่สร้างซ้ำ)
- `tax_treatment` เป็นคอลัมน์แยกจาก `classification` เดิมโดยตั้งใจ (ไม่ขยาย enum เดิม) — คำนวณภาษีอ่าน
  `tax_treatment` อย่างเดียว รายงาน/แดชบอร์ดเดิมอ่าน `classification` อย่างเดียว สองค่านี้ขัดกันได้โดยตั้งใจ
  (เช่น `classification='income'` + `tax_treatment='excluded'` = เงินเข้าจริงแต่ไม่เอาเข้าฐานภาษี)
- Rule เป็น data ไม่ใช่ตาราง DB (`src/services/tax-rules.ts`) — ขั้นบันไดภาษีบุคคลธรรมดา + ลดหย่อนส่วนตัว
  60,000 + ค่าใช้จ่ายเงินได้ 40(1) 50% ไม่เกิน 100,000 ปีภาษี ค.ศ. 2024/2025 **ยังไม่ผ่านการตรวจกับ
  rd.go.th** (มี `// TODO` กำกับไว้ในโค้ด) — ผู้ใช้ยืนยันจะตรวจเองก่อนใช้ตัดสินใจภาษีจริง
- `src/services/tax-calculation.ts` เป็นฟังก์ชัน pure `estimateTax(input, rules)` (เหมือน `occurrencesInMonth`
  ไม่แตะ DB) ลำดับคำนวณ: หักค่าใช้จ่ายเงินได้จาก **เงินเดือนอย่างเดียว** (ไม่รวม business income เข้ามาคิด %),
  assessable = เงินเดือน + รายได้ธุรกิจอื่น − ค่าใช้จ่ายหักภาษีได้, net = assessable − ค่าใช้จ่ายเงินได้ −
  ลดหย่อนส่วนตัว − ค่าลดหย่อนที่ยื่น, ภาษี = ขั้นบันไดของ net, ยอดที่ต้องชำระ = ภาษี − ภาษีหัก ณ ที่จ่าย
  (ติดลบ = ขอคืน) — เฉพาะ entity `individual` เท่านั้นที่ได้ตัวเลขนี้ `sole_proprietor`/`company` ได้แค่ยอดสรุป
  + missing-document report (CIT เป็นคนละระบบ ไม่รองรับในเฟสนี้ตามที่ตกลงกัน)
- `GET /api/tax/:year/summary` คำนวณสดไม่มี side effect (บทเรียนจาก Slice 5 ที่ GET เขียนข้อมูลเงียบ ๆ)
  `POST /api/tax/:year/calculate` เขียน `tax_calculation_snapshot` **1 แถวต่อ 1 tax_entity_id เสมอ**
  (ห้ามรวม Tax Entity คนละประเภทในผลเดียว) `input_snapshot` ฝัง rule set ทั้งก้อนไว้ ไม่ใช่แค่ version string
  — แก้ตัวเลข rule ปีถัดไปจะไม่ย้อนเปลี่ยนความหมายของ snapshot เก่า
- `tax_deduction_claim` CRUD ลบได้จริง (ไม่ archive) ตาม §17 เพราะ `audit_log.before_data` เก็บทั้งแถวไว้แล้ว
  — ไม่มี unique ต่อ `deduction_type` เพราะตีกับ `tax_document_id` (ใบอนุโมทนาบัตรบริจาคสองใบในปีเดียวกัน
  ต้องเป็นสองแถวแยกกันเพื่อ drill-down ต่อเอกสารได้)
- `src/services/report-query.ts` เพิ่ม `tax_treatment`/`tax_entity_id`/`classification` เข้า `TXN_FILTER_SQL`
  และ `EFFECTIVE_TAX_ENTITY_SQL` — จุดสำคัญ: `tax_treatment` รับ sentinel `'none'` แทน "ยังไม่ระบุ" (IS NULL)
  เพราะ `null` เดิมแปลว่า "ไม่กรอง" อยู่แล้ว ถ้าไม่มี sentinel ปุ่ม drill-down ของการ์ด "ยังไม่ระบุ Tax Treatment"
  จะคืน superset ของทุกธุรกรรมแทนที่จะเป็นชุดที่การ์ดนับจริง (พบระหว่าง code review ก่อน commit)
- Audit call site ที่เหลือครบทั้ง 9 จุดตาม §7.6 (เปลี่ยน category/tax treatment, split, confirm/reject transfer,
  mark paid ทั้งจาก monthly plan และจากแผนผ่อน, ยกเลิก/ยืนยัน payment, แก้ plan item/skip, ปิด/เปิดเดือน,
  แก้แผนผ่อน, แก้รายการหักรายได้, archive บัญชี, ค่าลดหย่อน, export ภาษี) — `GET /api/audit-log` อ่านได้
  พร้อมหน้า `AuditLog.tsx` (`/audit`, ไอคอนข้างปุ่มออกจากระบบ ไม่อยู่ใน nav หลัก เหมือน `/installments`)
- เว็บ: `TaxSummary.tsx` (`/tax?year=&tax_entity_id=`), `DeductionClaimSection.tsx` (คัดลอกแพทเทิร์นจาก
  `IncomeSection.tsx`), ปุ่ม CSV (server string-join + `<a download>`, ไม่เพิ่ม dependency) และปุ่มพิมพ์
  (`window.print()` แทน PDF library — อัปเกรดเมื่อมีคนต้องการ layout ต่างจากหน้าจอจริง ๆ)
- `ReviewDrawer.tsx` เพิ่ม select "Tax Treatment" (จุดเดียวที่ผู้ใช้ตั้งค่านี้ได้ ไม่มี default ให้ระบบเดา) และ
  `Transactions.tsx` เพิ่ม filter `tax_treatment`/`tax_entity_id` + รองรับ `from`/`to` (ไม่ใช่แค่ `month`)
  สำหรับ drill-down รายปีจากหน้าภาษี
- **บั๊กที่พบระหว่าง code review (ก่อน commit) และแก้แล้วทั้งหมด**:
  - `aggregateTaxInputs` join `income_deduction` เข้ากับ `income_record` ตรง ๆ เพื่อรวม `gross_amount_satang`
    พร้อมกัน — ถ้า income record หนึ่งแถวมี `deduction_type='withholding_tax'` มากกว่าหนึ่งแถว (schema ไม่มี
    unique คุม) join จะ fan-out แล้วนับรายได้ซ้ำหลายรอบ แก้เป็น scalar subquery แยกกันสองก้อน
  - การ์ด "ยังไม่ระบุ Tax Treatment" ส่งพารามิเตอร์ไม่ครบ ทำให้ drill-down ได้ทุกธุรกรรมของปีนั้นแทนที่จะเป็น
    เฉพาะที่การ์ดนับ (superset) — เพิ่ม sentinel `tax_treatment=none` ใน `TXN_FILTER_SQL` แก้ปัญหานี้
  - `GET /api/tax/:year/snapshots` ไม่เรียก `assertOwnsTaxEntity` เหมือน endpoint พี่น้อง (ปลอดภัยเพราะ query
    scope ด้วย `user_id` อยู่แล้ว แต่ไม่สอดคล้องกัน) — เพิ่มให้ตรงกัน
  - `bank_account.archive` audit เขียน `select *` เข้า `before_data`/`after_data` ทำให้ `pdf_password_enc`
    (ciphertext) รั่วเข้า `audit_log` ที่ `GET /api/audit-log` คืนดิบให้เจ้าของอ่านได้ — เปลี่ยนเป็น select
    เฉพาะคอลัมน์ปลอดภัย
  - `/installment-dues/:id/payments` (mark paid ฝั่งแผนผ่อน) ไม่มี audit call site ทั้งที่ endpoint พี่น้อง
    (`monthly-plan-items/:id/payments`) มี — เพิ่มให้ครบ
- **125 → 204 เทสต์** (`npm run test:db`) เพิ่ม `test/tax-calculation.test.ts` (pure, ครอบ `estimateTax`/
  `resolveRuleSet`), `test/tax-calculations-api.test.ts` (DB, ครอบ summary/snapshot/claim CRUD/export/audit +
  DoD reconciliation test ที่ยิง `GET summary` แล้วเทียบผลรวมจาก drill-down ของแต่ละการ์ดว่าตรงเป๊ะ — เพื่อ
  กันบั๊กคลาสเดียวกับที่ Slice 4B เคยส่งมอบไปแบบพัง), `test/migrate.test.ts` subtest 010, `test/authz.test.ts`
  ข้อ 37–41 (คำนวณภาษี, ค่าลดหย่อน, snapshot, export, audit-log ข้ามคน) · `npm run build` สะอาด
- **ยังไม่เคยเปิดดูในเบราว์เซอร์จริง** เหมือนทุกเฟสก่อนหน้า — environment นี้ไม่มี browser automation และต้องมี
  Google OAuth session จริง ยืนยันได้แค่ `npm run test:db` + `npm run build`
- ตั้งใจไม่ทำในเฟสนี้: ภ.ง.ด.90/91 เต็มรูป (แยกเงินได้ 40(1)–(8) รายประเภท), ภาษีนิติบุคคล (CIT), PDF generator
  จริง (ใช้ print stylesheet), OCR/text extraction ของเอกสารภาษี (§10.3 "ระยะหลัง")

## Requirement ที่ยังไม่มี Slice รองรับ

- Text extraction / OCR / duplicate suggestion สำหรับเอกสารภาษี (§10.3 "ระยะหลัง")
- ภ.ง.ด.90/91 เต็มรูป และภาษีนิติบุคคล (CIT) — Slice 8 ทำเฉพาะประมาณการบุคคลธรรมดาแบบย่อ (ขั้นบันได +
  ลดหย่อนส่วนตัว + ค่าใช้จ่ายเงินได้ 50%/100,000 + ค่าลดหย่อนที่ผู้ใช้กรอกเอง)

## UI design guideline — ปิดแล้ว

`docs/plans/personalfinancesystemplan.md` §3 (light mode, สีแดง crimson, ฟอนต์พิกเซล, Lucide icons)
ขัดกับ `DESIGN.md` และโค้ดจริงที่ใช้อยู่ (dark-first, `#70adfb`, MUI, iannnnn-DOG) — บันทึกการกลับทิศไว้ที่
`docs/adr/0003-design-md-supersedes-personalfinancesystemplan-section-3.md` แล้ว §3 เก็บไว้เพื่อประวัติ
ไม่ใช้ตัดสินงาน UI อีกต่อไป
