import { Router } from "express";
import { requireUser } from "../auth.js";
import { pool, tx } from "../db.js";
import { HttpError, id, pathId } from "../http.js";
import { incomeRows, saveIncome } from "../services/income-records.js";
import { audit } from "../services/audit.js";

export const incomeRecordsRouter = Router();
incomeRecordsRouter.get(
  "/income-records",
  requireUser(async (req, res, user) => {
    const month = req.query.month;
    if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
      throw new HttpError(400, "month ต้องเป็น YYYY-MM");
    res.json({ rows: await incomeRows(pool, user.id, month) });
  }),
);
/**
 * รายได้เป็นบัญชีที่ผู้ใช้กรอกเองล้วน ไม่ผูกกับเงินเข้าใน statement อีกต่อไป
 *
 * ปุ่ม "บันทึกเป็นรายได้เต็ม" ในหน้าธุรกรรมจึงเป็นแค่การ prefill ยอด/วันที่/ชื่อมาให้ ไม่ได้สร้างสาย
 * ผูกกับ txn — `source_txn_id` ไม่มีความหมายแล้ว ผลที่ยอมรับ: กดซ้ำได้หลายครั้งจากเงินเข้าก้อนเดียว
 * แล้ว employmentIncomeSatang บวกซ้ำ (เดิมกันด้วย assertTxnNotRecordedAsIncome + unique index บน
 * txn ที่ matched) ตรวจซ้ำได้จากตาราง "รายได้และรายการหัก" และ drill-down รายตัวในหน้าภาษี
 */
incomeRecordsRouter.post(
  "/income-records",
  requireUser(async (req, res, user) => {
    const result = await tx(async (c) => {
      const recordId = await saveIncome(c, user.id, req.body);
      return (await incomeRows(c, user.id, undefined, recordId))[0];
    });
    res.status(201).json(result);
  }),
);
incomeRecordsRouter.patch(
  "/income-records/:id",
  requireUser(async (req, res, user) => {
    const result = await tx(async (c) => {
      const recordId = await saveIncome(c, user.id, req.body, pathId(req));
      return (await incomeRows(c, user.id, undefined, recordId))[0];
    });
    res.json(result);
  }),
);
incomeRecordsRouter.put(
  "/income-records/:id/deductions",
  requireUser(async (req, res, user) => {
    if (!Object.hasOwn(req.body, "deductions"))
      throw new HttpError(400, "ต้องส่ง deductions");
    const recordId = pathId(req);
    const result = await tx(async (c) => {
      const before = (await c.query("select * from income_deduction where income_record_id=$1 order by id", [recordId])).rows;
      await saveIncome(c, user.id, { deductions: req.body.deductions }, recordId);
      const after = (await c.query("select * from income_deduction where income_record_id=$1 order by id", [recordId])).rows;
      await audit(c, { userId: user.id, action: "income_deduction.update", entityType: "income_record", entityId: recordId, before, after, ip: req.ip ?? null });
      return (await incomeRows(c, user.id, undefined, recordId))[0];
    });
    res.json(result);
  }),
);
