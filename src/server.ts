import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import connectPgSimple from 'connect-pg-simple';
import express, { type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import { api } from './api.js';
import { authRouter } from './auth.js';
import { pool } from './db.js';
import { env } from './env.js';
import { HttpError } from './http.js';
import { migrate } from './migrate.js';
import { startWorker } from './worker.js';

const WEB_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');

const applied = await migrate();
if (applied.length) console.log(`migration: ${applied.join(', ')}`);

const app = express();
app.set('trust proxy', 1); // อยู่หลัง Caddy — ต้องเชื่อ X-Forwarded-* ไม่งั้น secure cookie ไม่ทำงาน
// เอกสารภาษีมาเป็น base64 ใน JSON (ไม่เพิ่ม multipart dependency) ต้องมีเพดานใหญ่กว่า 100kb ทั่วไป
// ต้อง mount ก่อน express.json({limit:'100kb'}) เสมอ — body-parser ข้ามเมื่อ req._body ถูกตั้งแล้ว mount ไว้ทีหลังไม่มีผล
app.use('/api/tax-documents', express.json({ limit: '15mb' }));
app.use(express.json({ limit: '100kb' }));
app.use(
  session({
    store: new (connectPgSimple(session))({ pool, createTableIfMissing: true }),
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.isProd,
      maxAge: 30 * 24 * 3600_000,
    },
  }),
);

app.use('/auth', authRouter);
app.use('/api', api);

// /api ที่ไม่มีจริงต้องได้ 404 ไม่ใช่ index.html — ไม่งั้น fetch ที่พิมพ์ path ผิดจะพังเป็น JSON parse error
app.use('/api', (_req, res) => res.status(404).json({ error: 'ไม่พบ endpoint' }));

app.use(express.static(WEB_DIST));
app.get('*', (_req, res) => res.sendFile(join(WEB_DIST, 'index.html')));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
  const code = (err as { code?: string }).code;
  if (code === '23505') return void res.status(409).json({ error: 'ข้อมูลซ้ำกับที่มีอยู่แล้ว' });
  if (code === '23503') return void res.status(409).json({ error: 'ยังมีข้อมูลอื่นอ้างถึงอยู่ ลบไม่ได้' });
  // CHECK constraint ที่ DB บังคับ (เช่น end_date < start_date, month_start ไม่ใช่วันที่ 1) เป็นข้อมูล
  // ที่ผู้ใช้ส่งมาผิด ไม่ใช่บั๊กของระบบ — 400 ไม่ใช่ 500 route ที่มีข้อความเฉพาะเจาะจงกว่านี้ตรวจเองก่อนอยู่แล้ว
  if (code === '23514') return void res.status(400).json({ error: 'ข้อมูลไม่ผ่านเงื่อนไขของระบบ' });
  console.error(err);
  res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ' });
});

app.listen(env.port, () => console.log(`family-ledger ฟังอยู่ที่ :${env.port}`));
startWorker();
