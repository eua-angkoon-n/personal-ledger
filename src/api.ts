import { Router } from 'express';
import { loadUser } from './auth.js';
import { accountsRouter } from './routes/accounts.js';
import { adminRouter } from './routes/admin.js';
import { auditLogRouter } from './routes/audit-log.js';
import { banksRouter } from './routes/banks.js';
import { categoriesRouter } from './routes/categories.js';
import { emailAccountsRouter } from './routes/email-accounts.js';
import { monthlyPlansRouter } from './routes/monthly-plans.js';
import { incomeRecordsRouter } from './routes/income-records.js';
import { installmentsRouter } from './routes/installments.js';
import { recurringRulesRouter } from './routes/recurring-rules.js';
import { reportsRouter } from './routes/reports.js';
import { taxCalculationsRouter } from './routes/tax-calculations.js';
import { taxDocumentsRouter } from './routes/tax-documents.js';
import { taxEntitiesRouter } from './routes/tax-entities.js';
import { transactionsRouter } from './routes/transactions.js';
import { transferMatchesRouter } from './routes/transfer-matches.js';
import { APP_VERSION } from './version.js';

export { HttpError } from './http.js';

export const api = Router();

// /me เป็น endpoint เดียวที่เว็บเรียกก่อนรู้ว่าล็อกอินหรือยัง — ส่ง version มาด้วยตรงนี้จึงได้เลข
// เวอร์ชันบนหน้าเข้าสู่ระบบด้วย ไม่ต้องมี `define` ของ vite (เว็บ import จาก src/ ไม่ได้ root คนละที่)
//
// ponytail: /me ไม่ต้องล็อกอิน → `version` จึงอ่านได้จากภายนอกโดยไม่มี session (fingerprinting)
// รับความเสี่ยงนี้เพราะเจ้าของงานเลือก "แสดงมุมล่างขวาทุกหน้า" รวมหน้าเข้าสู่ระบบ และเลขเป็น semver
// เปล่า ๆ ไม่มี git sha ไม่ผูกกับ CVE ของใคร ถ้าวันไหนอยากปิด: `...(user ? { version: APP_VERSION } : {})`
// (ผลตามมา: badge หายจากหน้าเข้าสู่ระบบและหน้ารอโหลด แต่ยังอยู่ครบทุกหน้าหลังล็อกอิน)
api.get('/me', async (req, res, next) => {
  try {
    res.json({ user: await loadUser(req), version: APP_VERSION });
  } catch (e) {
    next(e);
  }
});

api.use(banksRouter);
api.use(adminRouter);
api.use(emailAccountsRouter);
api.use(accountsRouter);
api.use(categoriesRouter);
api.use(transactionsRouter);
api.use(transferMatchesRouter);
api.use(reportsRouter);
api.use(recurringRulesRouter);
api.use(monthlyPlansRouter);
api.use(incomeRecordsRouter);
api.use(installmentsRouter);
api.use(taxEntitiesRouter);
api.use(taxDocumentsRouter);
api.use(taxCalculationsRouter);
api.use(auditLogRouter);
