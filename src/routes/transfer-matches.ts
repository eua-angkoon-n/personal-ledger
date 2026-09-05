import { Router } from 'express';
import { requireUser } from '../auth.js';
import { pathId } from '../http.js';
import { query, tx } from '../db.js';
import { HttpError } from '../http.js';
import { audit } from '../services/audit.js';

export const transferMatchesRouter = Router();

const STATUSES = ['suggested', 'confirmed', 'rejected'] as const;

// list คู่โอนที่ระบบ suggest ไว้ (หรือ status อื่นตาม query) พร้อมรายละเอียดทั้งสองฝั่งในคำตอบเดียว —
// หน้าเว็บจะได้ไม่ต้องยิงซ้ำต่อ txn เพื่อ render confirm/reject
// transfer_match.user_id ไม่มี FK คุมว่า debit/credit txn เป็นของ user คนนั้นจริง (ดู confirm/reject
// ด้านล่าง) เลย join bank_account.user_id ซ้ำเป็นด่านที่สองเหมือนกัน ไม่พึ่ง column เดียว
transferMatchesRouter.get('/transfer-matches', requireUser(async (req, res, user) => {
  const status = typeof req.query.status === 'string' ? req.query.status : 'suggested';
  if (!(STATUSES as readonly string[]).includes(status)) {
    throw new HttpError(400, `status ต้องเป็นหนึ่งใน ${STATUSES.join(', ')}`);
  }

  const { rows } = await query(
    `select
       tm.id, tm.status, tm.confidence::float8 as confidence, tm.matched_by, tm.created_at, tm.reviewed_at,
       d.id as debit_txn_id, d.txn_date as debit_txn_date, d.amount_satang as debit_amount_satang,
       d.direction as debit_direction, da.nickname as debit_account_nickname,
       c.id as credit_txn_id, c.txn_date as credit_txn_date, c.amount_satang as credit_amount_satang,
       c.direction as credit_direction, ca.nickname as credit_account_nickname
     from transfer_match tm
     join txn d on d.id = tm.debit_txn_id
     join bank_account da on da.id = d.bank_account_id and da.user_id = $1
     join txn c on c.id = tm.credit_txn_id
     join bank_account ca on ca.id = c.bank_account_id and ca.user_id = $1
     where tm.user_id = $1 and tm.status = $2
       -- suggestion ที่ขาใดขาหนึ่งถูก confirm ไปแล้วกับคู่อื่น ยืนยันซ้ำไม่ได้ (ชน partial unique index)
       -- เหลือไว้ในคิวมีแต่ทำให้ผู้ใช้กดแล้วเจอ 409 ต้องกรองออกตั้งแต่ list
       and not exists (
         select 1 from transfer_match x
         where x.status = 'confirmed'
           and (x.debit_txn_id in (tm.debit_txn_id, tm.credit_txn_id)
                or x.credit_txn_id in (tm.debit_txn_id, tm.credit_txn_id))
       )
     order by tm.created_at desc`,
    [user.id, status],
  );
  res.json(rows);
}));

// ยืนยันคู่โอนภายใน → เขียน txn.is_internal_transfer = true ให้ทั้งสองฝั่งในทรานแซกชันเดียวกัน
// update ที่สองต้อง join bank_account ยืนยัน ownership ซ้ำอีกชั้น (§6.1 ทุก query ต้อง scope ด้วย user.id
// ไม่มีข้อยกเว้น แม้ transfer_match แถวนี้จะเช็ค user_id ผ่านแล้วก็ตาม)
// ถ้า insert/update ชน partial unique index (23505) ปล่อยให้ error handler กลางแปลงเป็น 409
transferMatchesRouter.post('/transfer-matches/:id/confirm', requireUser(async (req, res, user) => {
  const matchId = pathId(req);
  const updated = await tx(async (c) => {
    const before = (await c.query('select status from transfer_match where id = $1 and user_id = $2', [matchId, user.id])).rows[0] ?? null;

    const { rows } = await c.query<{ debit_txn_id: number; credit_txn_id: number }>(
      `update transfer_match set status = 'confirmed', reviewed_at = now()
       where id = $1 and user_id = $2
       returning debit_txn_id, credit_txn_id`,
      [matchId, user.id],
    );
    const match = rows[0];
    if (!match) throw new HttpError(404, 'ไม่พบรายการจับคู่');

    const flipped = await c.query(
      `update txn t set is_internal_transfer = true
       from bank_account a
       where a.id = t.bank_account_id and a.user_id = $3 and t.id in ($1, $2)`,
      [match.debit_txn_id, match.credit_txn_id, user.id],
    );
    if (flipped.rowCount !== 2) throw new HttpError(404, 'ไม่พบธุรกรรมที่จะจับคู่');

    await audit(c, {
      userId: user.id, action: 'transfer_match.confirm', entityType: 'transfer_match', entityId: matchId,
      before, after: { status: 'confirmed', ...match }, ip: req.ip ?? null,
    });
    return match;
  });
  res.json(updated);
}));

// reject คู่ที่เคย confirmed มาก่อน ต้องล้าง is_internal_transfer ทั้งสองฝั่งด้วย
// ไม่งั้น flag ค้าง true ถาวรและไม่มีทางแก้กลับ (พบจาก code review — ต้องอยู่ใน tx() เดียวกับ confirm)
transferMatchesRouter.post('/transfer-matches/:id/reject', requireUser(async (req, res, user) => {
  const matchId = pathId(req);
  const updated = await tx(async (c) => {
    const before = await c.query<{ status: string; debit_txn_id: number; credit_txn_id: number }>(
      `select status, debit_txn_id, credit_txn_id from transfer_match where id = $1 and user_id = $2 for update`,
      [matchId, user.id],
    );
    const match = before.rows[0];
    if (!match) throw new HttpError(404, 'ไม่พบรายการจับคู่');

    const { rows } = await c.query(
      `update transfer_match set status = 'rejected', reviewed_at = now() where id = $1 returning *`,
      [matchId],
    );

    if (match.status === 'confirmed') {
      await c.query(
        `update txn t set is_internal_transfer = false
         from bank_account a
         where a.id = t.bank_account_id and a.user_id = $3 and t.id in ($1, $2)`,
        [match.debit_txn_id, match.credit_txn_id, user.id],
      );
    }

    await audit(c, {
      userId: user.id, action: 'transfer_match.reject', entityType: 'transfer_match', entityId: matchId,
      before: match, after: rows[0], ip: req.ip ?? null,
    });
    return rows[0];
  });
  res.json(updated);
}));
