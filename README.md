# Hyacinthia Ledger

ระบบบัญชีรายรับ–รายจ่ายระดับครอบครัว อ่าน statement PDF ที่ธนาคารส่งเข้าอีเมลอัตโนมัติ แปลงเป็นรายการธุรกรรม
พร้อมวางแผนรายเดือน ผ่อนชำระ เอกสารภาษี และคำนวณภาษีเบื้องต้น — ลดการบันทึกด้วยมือ ดูภาพรวมการเงินได้ทันที

โฟลเดอร์/`package.json` ยังใช้ชื่อเดิม `family-ledger` (ยังไม่ได้ตามรีเนมหลัง rebrand)

## ท่อข้อมูลหลัก

```
Gmail (poll ชั่วโมงละครั้ง)
  → จับคู่อีเมล: ผู้ส่ง + DKIM + หัวข้อ
  → ดึงไฟล์แนบ PDF (ชื่อไฟล์ตรง pattern + MIME + magic bytes)
  → ถอดรหัส + สกัดข้อความในหน่วยความจำ (qpdf | pdftotext), ไม่ลงดิสก์
  → แกะตารางด้วย parser ต่อธนาคาร (SCB, KBank)
  → ตรวจ checksum ยอดยกมา/ยกไป — ไม่ผ่าน = ไม่เขียนสักแถว
  → เขียน statement/txn ใน DB transaction เดียว
```

รายละเอียดกติกาและสถาปัตยกรรม: [`CONTEXT.md`](./CONTEXT.md) · ผลิตภัณฑ์/ผู้ใช้: [`PRODUCT.md`](./PRODUCT.md) ·
ดีไซน์: [`DESIGN.md`](./DESIGN.md) · ADR: [`docs/adr/`](./docs/adr/) · สถานะงานล่าสุด: [`docs/status.md`](./docs/status.md)

## Stack

- Backend: Node.js (`tsx`), Express, PostgreSQL (`pg`), session ผ่าน `express-session` + `connect-pg-simple`
- Frontend: React + Vite, MUI (`@mui/material`, `@mui/x-charts`), `react-router-dom`
- Auth: Google OAuth
- Encryption: AES-256-GCM (`src/crypto.ts`) สำหรับ refresh token, รหัสผ่าน PDF, และเอกสารภาษี

## ฟีเจอร์ที่ทำเสร็จแล้ว (Slice 1–8)

- นำเข้า statement อัตโนมัติจาก Gmail (SCB, KBank) พร้อม checksum gate
- จัดหมวดหมู่/แบ่งสัดส่วน/ยืนยันคู่โอนภายใน, Dashboard สรุป + กราฟ
- วางแผนรายเดือน (รายการประจำ, ติดตามสถานะจ่ายบิล, ปิด/เปิดเดือน)
- รายได้ (income) และแผนผ่อนชำระ (installment)
- คลังเอกสารภาษี (เข้ารหัส, audit log การเข้าถึง)
- คำนวณภาษีเบื้องต้น (บุคคลธรรมดา) + ค่าลดหย่อน + export

โปรเจกต์ปิดสโคปตามแผนแล้ว — ไม่ทำ ภ.ง.ด.90/91 เต็มรูป, ภาษีนิติบุคคล (CIT), หรือ OCR เอกสารภาษี

## หลังปิดสโคป

- **เวอร์ชัน** อยู่ที่ `src/version.ts` ที่เดียว แสดงมุมล่างขวาทุกหน้า —
  **ทุกครั้งที่ deploy ต้องขยับเลข + เพิ่มบรรทัดใน [`CHANGELOG.md`](./CHANGELOG.md)** (กฎเต็ม: `AGENTS.md` §Versioning)
- **คู่มือระบบ** เนื้อหาชุดเดียวที่ `web/src/guide/guides.ts` ใช้ทั้งปุ่มคู่มือในแต่ละหน้า (ไฮไลต์ทีละขั้น) และหน้า `/help`
- **บันทึกระบบ** `audit_log` ครอบทุก route ที่แก้ข้อมูล + เข้า/ออก/สมัคร · ผู้ใช้ดูของตัวเองที่ `/audit`
  แอดมินดูข้ามผู้ใช้ที่ ตั้งค่า → บันทึกระบบ (ต้องส่ง `?scope=all` แบบชัดแจ้ง)

## เริ่มต้นใช้งาน (dev)

```sh
cp .env.example .env   # กรอกค่าตามคอมเมนต์ในไฟล์ (ENCRYPTION_KEY, SESSION_SECRET, Google OAuth ฯลฯ)
docker compose up -d   # PostgreSQL
npm install
npm run migrate        # ปกติแอปรันให้เองตอนบูตอยู่แล้ว
npm run dev:api        # API ที่ :3000
npm run dev:web         # Vite ที่ :5173 (proxy /api, /auth ไป :3000)
```

## คำสั่งอื่น

```sh
npm test          # unit test เท่านั้น (ไม่ต่อ Postgres)
npm run test:db   # unit + integration ต่อ Postgres จริงผ่าน docker-compose.test.yml — ใช้คำสั่งนี้ก่อน commit เสมอ
npm run build     # tsc (backend + web) + vite build
npm start         # รันจาก dist/ (production)
```

Deploy: [`docs/deploy.md`](./docs/deploy.md)
