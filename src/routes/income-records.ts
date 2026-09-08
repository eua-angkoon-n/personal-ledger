import { Router } from "express";
import { requireUser } from "../auth.js";
import { pool, tx } from "../db.js";
import { HttpError, id, pathId } from "../http.js";
import {
  incomeCandidates,
  incomeRows,
  loadIncome,
  lockIncome,
  matchIncome,
  saveIncome,
} from "../services/income-records.js";
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
type Queryable = Parameters<typeof saveIncome>[0];

/**
 * ผูกรายได้ที่เพิ่งสร้างเข้ากับธุรกรรมต้นทางแบบระบุตัวตรง ๆ (ไม่ใช่เดาจากยอด/วันที่เหมือน auto-match)
 *
 * จุดสำคัญคือ**กันบันทึกซ้ำ**: ปุ่ม "บันทึกเป็นรายได้เต็ม" ในหน้าธุรกรรมกดกี่ครั้งก็ได้ ถ้าไม่ผูกไว้
 * จะได้ income_record หลายก้อนจากเงินเข้าก้อนเดียว แล้ว employmentIncomeSatang (ซึ่งรวมทุก
 * income_record ไม่สนสถานะจับคู่) จะบวกซ้ำ → ประมาณการภาษีสูงเกินจริงแบบเงียบ ๆ
 * ตัวกันจริงคือ partial unique index `monthly_item_payment_txn_matched_uniq (txn_id) where status='matched'`
 * ที่มีมาตั้งแต่ Slice 5 — ที่นี่แค่เช็คก่อนเพื่อให้ได้ข้อความไทยแทน 23505 ดิบ
 *
 * ไม่บังคับว่ายอดสุทธิต้องเท่าเงินเข้าเป๊ะ (ต่างจาก matchIncome ที่ใช้กับการเลือกคู่เอง) เพราะผู้ใช้
 * ชี้ธุรกรรมมาเองแล้วว่าคือก้อนนี้ — คนที่ยังไม่รู้ยอดหักจริงจะได้บันทึกไปก่อนได้ ไม่ต้องเดาตัวเลข
 */
async function linkIncomeToTxn(c: Queryable, userId: number, recordId: number, txnId: number): Promise<void> {
  const income = await loadIncome(c, userId, recordId);
  const txn = (
    await c.query<{ id: number; amount_satang: number; txn_date: string; direction: string; bank_account_id: number }>(
      `select t.id, t.amount_satang, t.txn_date, t.direction, t.bank_account_id
       from txn t join bank_account a on a.id = t.bank_account_id
       where t.id = $1 and a.user_id = $2`,
      [txnId, userId],
    )
  ).rows[0];
  if (!txn) throw new HttpError(404, "ไม่พบธุรกรรม");
  if (txn.direction !== "credit") throw new HttpError(400, "ธุรกรรมนี้ไม่ใช่เงินเข้า");
  if (income.bank_account_id != null && income.bank_account_id !== txn.bank_account_id)
    throw new HttpError(400, "ธุรกรรมอยู่คนละบัญชีกับรายได้");

  // reconcileIncome ท้าย saveIncome อาจจับคู่ให้ไปแล้วถ้ายอด/วันที่เข้าเกณฑ์ — ไม่ต้องผูกซ้ำ
  const already = await c.query(
    `select 1 from monthly_item_payment where monthly_plan_item_id = $1 and txn_id = $2 and status = 'matched'`,
    [income.monthly_plan_item_id, txnId],
  );
  if (already.rowCount) return;

  await c.query(
    `insert into monthly_item_payment (monthly_plan_item_id, amount_satang, paid_date, bank_account_id, txn_id, status, verified_at)
     values ($1, $2, $3, $4, $5, 'matched', now())`,
    [income.monthly_plan_item_id, txn.amount_satang, txn.txn_date, txn.bank_account_id, txnId],
  );
}

async function assertTxnNotRecordedAsIncome(c: Queryable, userId: number, txnId: number): Promise<void> {
  const { rowCount } = await c.query(
    `select 1 from monthly_item_payment p
     join income_record ir on ir.monthly_plan_item_id = p.monthly_plan_item_id
     where p.txn_id = $1 and p.status = 'matched' and ir.user_id = $2`,
    [txnId, userId],
  );
  if (rowCount) throw new HttpError(409, "ธุรกรรมนี้บันทึกเป็นรายได้ไปแล้ว");
}

incomeRecordsRouter.post(
  "/income-records",
  requireUser(async (req, res, user) => {
    const b = req.body as Record<string, unknown>;
    // ส่งมาจากปุ่มในหน้าธุรกรรม = "เงินเข้าก้อนนี้คือรายได้ก้อนนี้" ผูกให้ชัดเจนและกันกดซ้ำ
    const sourceTxnId = b.source_txn_id == null || b.source_txn_id === "" ? null : id(b, "source_txn_id");
    const result = await tx(async (c) => {
      if (sourceTxnId != null) await assertTxnNotRecordedAsIncome(c, user.id, sourceTxnId);
      const recordId = await saveIncome(c, user.id, req.body);
      if (sourceTxnId != null) await linkIncomeToTxn(c, user.id, recordId, sourceTxnId);
      const row = (await incomeRows(c, user.id, undefined, recordId))[0];
      await audit(c, { userId: user.id, action: "income_record.create", entityType: "income_record", entityId: recordId, after: { ...row, source_txn_id: sourceTxnId }, ip: req.ip ?? null });
      return row;
    });
    res.status(201).json(result);
  }),
);
incomeRecordsRouter.patch(
  "/income-records/:id",
  requireUser(async (req, res, user) => {
    const result = await tx(async (c) => {
      const before = (await incomeRows(c, user.id, undefined, pathId(req)))[0];
      const recordId = await saveIncome(c, user.id, req.body, pathId(req));
      const row = (await incomeRows(c, user.id, undefined, recordId))[0];
      await audit(c, { userId: user.id, action: "income_record.update", entityType: "income_record", entityId: recordId, before, after: row, ip: req.ip ?? null });
      return row;
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
incomeRecordsRouter.get(
  "/income-records/:id/candidates",
  requireUser(async (req, res, user) => {
    await loadIncome(pool, user.id, pathId(req));
    res.json({ rows: await incomeCandidates(pool, user.id, pathId(req)) });
  }),
);
incomeRecordsRouter.post(
  "/income-records/:id/match",
  requireUser(async (req, res, user) => {
    res.json(
      await tx(async (c) => {
        await lockIncome(c, user.id);
        const txnId = id(req.body, "txn_id");
        await matchIncome(c, user.id, pathId(req), txnId);
        const row = (await incomeRows(c, user.id, undefined, pathId(req)))[0];
        await audit(c, { userId: user.id, action: "income_record.match", entityType: "income_record", entityId: pathId(req), after: { ...row, txn_id: txnId }, ip: req.ip ?? null });
        return row;
      }),
    );
  }),
);
incomeRecordsRouter.post(
  "/income-records/:id/unmatch",
  requireUser(async (req, res, user) => {
    res.json(
      await tx(async (c) => {
        await lockIncome(c, user.id);
        const income = await loadIncome(c, user.id, pathId(req), true);
        await c.query(
          "update monthly_item_payment set status='cancelled',txn_id=null,verified_at=null where monthly_plan_item_id=$1 and status<>'cancelled'",
          [income.monthly_plan_item_id],
        );
        await c.query(
          "update income_record set auto_match=false,updated_at=now() where id=$1",
          [income.id],
        );
        const row = (await incomeRows(c, user.id, undefined, income.id))[0];
        await audit(c, { userId: user.id, action: "income_record.unmatch", entityType: "income_record", entityId: income.id, after: row, ip: req.ip ?? null });
        return row;
      }),
    );
  }),
);
