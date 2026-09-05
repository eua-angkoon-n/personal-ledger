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
    const result = await tx(async (c) => {
      const recordId = await saveIncome(
        c,
        user.id,
        { deductions: req.body.deductions },
        pathId(req),
      );
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
        await matchIncome(c, user.id, pathId(req), id(req.body, "txn_id"));
        return (await incomeRows(c, user.id, undefined, pathId(req)))[0];
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
        return (await incomeRows(c, user.id, undefined, income.id))[0];
      }),
    );
  }),
);
