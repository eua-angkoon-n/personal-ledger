import { Router } from "express";
import { requireUser } from "../auth.js";
import { pool, tx } from "../db.js";
import { pathId } from "../http.js";
import {
  declarePayment,
  installmentDetail,
  materializeDue,
  saveInstallment,
} from "../services/installments.js";
import { audit } from "../services/audit.js";
export const installmentsRouter = Router();
installmentsRouter.get(
  "/installment-plans",
  requireUser(async (req, res, user) => {
    const ids = (
      await pool.query(
        "select id from installment_plan where user_id=$1 order by id desc",
        [user.id],
      )
    ).rows;
    const rows = [];
    for (const { id } of ids) {
      const { dues, ...row } = await installmentDetail(pool, user.id, id);
      rows.push(row);
    }
    const totals = {
      total_payable_satang: 0,
      paid_satang: 0,
      outstanding_satang: 0,
    };
    for (const row of rows)
      if (row.status === "active")
        for (const key of Object.keys(totals) as (keyof typeof totals)[])
          totals[key] += row[key];
    res.json({ rows, totals });
  }),
);
installmentsRouter.get(
  "/installment-plans/:id",
  requireUser(async (req, res, user) => {
    res.json(await installmentDetail(pool, user.id, pathId(req)));
  }),
);
installmentsRouter.post(
  "/installment-plans",
  requireUser(async (req, res, user) => {
    const created = await tx(async (c) => {
      const detail = await installmentDetail(
        c,
        user.id,
        await saveInstallment(c, user.id, req.body),
      );
      await audit(c, { userId: user.id, action: "installment_plan.create", entityType: "installment_plan", entityId: detail.id, after: detail, ip: req.ip ?? null });
      return detail;
    });
    res.status(201).json(created);
  }),
);
installmentsRouter.patch(
  "/installment-plans/:id",
  requireUser(async (req, res, user) => {
    const planId = pathId(req);
    const updated = await tx(async (c) => {
      const before = (await c.query("select * from installment_plan where id=$1 and user_id=$2", [planId, user.id])).rows[0] ?? null;
      const detail = await installmentDetail(
        c,
        user.id,
        await saveInstallment(c, user.id, req.body, planId),
      );
      await audit(c, { userId: user.id, action: "installment_plan.update", entityType: "installment_plan", entityId: planId, before, after: detail, ip: req.ip ?? null });
      return detail;
    });
    res.json(updated);
  }),
);
installmentsRouter.post(
  "/installment-dues/:id/payments",
  requireUser(async (req, res, user) => {
    const payment = await tx(async (c) => {
      const { itemId } = await materializeDue(c, user.id, pathId(req));
      const row = await declarePayment(c, user.id, itemId, req.body);
      await audit(c, { userId: user.id, action: "monthly_item_payment.declare", entityType: "monthly_item_payment", entityId: row.id, after: row, ip: req.ip ?? null });
      return row;
    });
    res
      .status(201)
      .json(
        (
          await pool.query("select * from monthly_item_payment where id=$1", [
            payment.id,
          ])
        ).rows[0],
      );
  }),
);
for (const action of ["skip", "restore"] as const)
  installmentsRouter.post(
    `/installment-dues/:id/${action}`,
    requireUser(async (req, res, user) => {
      res.json(
        await tx(async (c) => {
          const { due, itemId } = await materializeDue(c, user.id, pathId(req));
          const status = action === "skip" ? "skipped" : "active";
          await c.query(
            "update installment_due set explicit_status=$2 where id=$1",
            [due.id, status],
          );
          await c.query(
            "update monthly_plan_item set explicit_status=$2,updated_at=now() where id=$1",
            [itemId, status],
          );
          return installmentDetail(c, user.id, due.installment_plan_id);
        }),
      );
    }),
  );
