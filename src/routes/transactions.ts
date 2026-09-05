import { Router } from 'express';
import { requireUser } from '../auth.js';
import { query, tx } from '../db.js';
import { HttpError, enumStr, id, optionalStr, pathId, str, type Body } from '../http.js';
import { audit } from '../services/audit.js';
import { assertOwnsTaxEntity } from './tax-entities.js';
import {
  EFFECTIVE_CLASSIFICATION_SQL,
  EFFECTIVE_REVIEW_STATUS_SQL,
  EFFECTIVE_TAX_ENTITY_SQL,
  OWNED_TXN_FROM,
  TXN_FILTER_SQL,
  parseTxnFilters,
  txnFilterParams,
} from '../services/report-query.js';

export const transactionsRouter = Router();

// GET /transactions — คอลัมน์ขั้นต่ำตาม §8.3, filter ตาม §8.4 (TXN_FILTER_SQL/txnFilterParams มาจาก report-query.ts)
// ห้าม fan-out บน txn_split (ตรงข้ามกับ category-breakdown ที่ fan-out โดยตั้งใจ) — txn 3 split ต้องไม่กิน
// 3 ช่องจาก 50 ของหน้าเดียวกันและถูกนับซ้ำ 3 ครั้งใน pagination รวม split เป็น json คอลัมน์เดียวผ่าน lateral แทน
// ถ้าจะ "ทำให้เหมือนกัน" กับ category-breakdown ระวังพังทั้งสองจุดเพราะโจทย์ตรงข้ามกัน
//
// ponytail: full sort ทุกหน้าเพราะไม่มี (bank_account_id, txn_date desc, id desc) covering index — มีแค่
// txn_account_date_idx (bank_account_id, txn_date) ที่ช่วยเฉพาะกรองบัญชีเดียว รับได้ที่สเกลครอบครัว (หลักพัน
// แถวต่อผู้ใช้) อัปเกรด: เพิ่ม index นั้นก่อน แล้วค่อยย้ายไป keyset pagination (keyset ที่ไม่มี index ให้ขี่
// ไม่เร็วกว่า offset แค่ซับซ้อนขึ้นเปล่า ๆ)
transactionsRouter.get('/transactions', requireUser(async (req, res, user) => {
  const filters = parseTxnFilters(req.query as Record<string, unknown>);
  const params = [...txnFilterParams(user.id, filters), filters.limit, filters.offset];

  const { rows } = await query(
    `select t.id, t.txn_date, t.txn_time, t.description, t.amount_satang, t.direction, t.running_balance_satang,
            t.is_internal_transfer,
            a.id as bank_account_id, a.nickname as account_nickname, a.account_purpose,
            b.id as bank_id, b.name as bank_name,
            ${EFFECTIVE_CLASSIFICATION_SQL} as classification, ${EFFECTIVE_REVIEW_STATUS_SQL} as review_status,
            an.tax_treatment, (${EFFECTIVE_TAX_ENTITY_SQL}) as effective_tax_entity_id,
            coalesce(sp.categories, '[]'::json) as categories,
            coalesce(sp.split_count, 0) as split_count,
            count(*) over () as total_count
     ${OWNED_TXN_FROM}
     join bank b on b.id = a.bank_id
     left join lateral (
       select json_agg(json_build_object('category_id', c.id, 'category_name', c.name, 'amount_satang', s.amount_satang) order by c.name) as categories,
              count(*)::int as split_count
       from txn_split s join category c on c.id = s.category_id where s.txn_id = t.id
     ) sp on true
     ${TXN_FILTER_SQL}
     order by t.txn_date desc, t.id desc
     limit $18 offset $19`,
    params,
  );
  // count(*) over () อยู่ในแถวข้อมูล — หน้าที่ offset เลยแถวสุดท้าย (หรือ filter ไม่ตรงอะไรเลย) จะได้ rows ว่าง
  // แล้วไม่มีที่มาของ total_count เลย ต้องยิงนับแยกเฉพาะตอนนั้น หน้าที่มีข้อมูลไม่ต้องจ่ายรอบสอง
  const totalCount =
    rows.length > 0
      ? Number(rows[0]!.total_count)
      : ((
          await query<{ n: number }>(
            `select count(*)::int as n ${OWNED_TXN_FROM} join bank b on b.id = a.bank_id ${TXN_FILTER_SQL}`,
            txnFilterParams(user.id, filters),
          )
        ).rows[0]?.n ?? 0);

  // เดือนที่ใช้กรองจริงต้องโผล่ในคำตอบเสมอ (เหมือน endpoint /reports/*) — ไม่งั้นเรียกไม่ส่ง month/from/to
  // มาเลยจะได้แค่เดือนปัจจุบันแบบเงียบ ๆ โดยไม่มีร่องรอยในคำตอบว่าช่วงเวลาไหนถูกกรองออกไป
  res.json({ from: filters.from, to: filters.to, rows, total_count: totalCount, limit: filters.limit, offset: filters.offset });
}));

// GET /transactions/:id — สามคำสั่ง scope ด้วย ownership ทุกคำสั่ง: (a) ตัวธุรกรรม+บัญชี+ธนาคาร+annotation+statement
// (b) split รายหมวด (c) transfer_match ที่อ้างธุรกรรมนี้เป็นฝั่งใดฝั่งหนึ่ง (ไม่รวม rejected) พร้อมข้อมูลคู่ตรงข้าม
// re-join bank_account.user_id บนธุรกรรมคู่ตรงข้ามเสมอ ไม่เชื่อ transfer_match.user_id เพียงอย่างเดียว (เหมือน
// GET /transfer-matches ใน src/routes/transfer-matches.ts)
transactionsRouter.get('/transactions/:id', requireUser(async (req, res, user) => {
  const txnId = pathId(req);

  const { rows: txnRows } = await query(
    `select t.id, t.txn_date, t.txn_time, t.description, t.channel, t.amount_satang, t.direction,
            t.running_balance_satang, t.is_internal_transfer, t.created_at,
            a.id as bank_account_id, a.nickname as account_nickname, a.account_purpose,
            a.default_tax_entity_id as account_default_tax_entity_id,
            b.id as bank_id, b.name as bank_name,
            ${EFFECTIVE_CLASSIFICATION_SQL} as classification, ${EFFECTIVE_REVIEW_STATUS_SQL} as review_status,
            an.note as annotation_note, an.tax_entity_id, an.tax_treatment,
            st.id as statement_id, st.period_start, st.period_end,
            -- ธุรกรรมนี้ถูกบันทึกเป็น "รายได้เต็ม" ไปแล้วหรือยัง — หน้าเว็บใช้ซ่อนปุ่มบันทึกซ้ำ
            (select ir.id from monthly_item_payment p
             join income_record ir on ir.monthly_plan_item_id = p.monthly_plan_item_id
             where p.txn_id = t.id and p.status = 'matched' and ir.user_id = $1) as income_record_id
     from txn t
     join bank_account a on a.id = t.bank_account_id
     join bank b on b.id = a.bank_id
     join statement st on st.id = t.statement_id
     left join txn_annotation an on an.txn_id = t.id
     where a.user_id = $1 and t.id = $2`,
    [user.id, txnId],
  );
  const txn = txnRows[0];
  if (!txn) throw new HttpError(404, 'ไม่พบธุรกรรม');

  const { rows: splits } = await query(
    `select s.id, s.category_id, c.name as category_name, s.amount_satang, s.note
     from txn_split s join category c on c.id = s.category_id
     where s.txn_id = $1 order by c.name`,
    [txnId],
  );

  const { rows: transferMatches } = await query(
    `select tm.id, tm.status, tm.confidence::float8 as confidence, tm.matched_by, tm.created_at, tm.reviewed_at,
            ct.id as counterpart_txn_id, ct.txn_date as counterpart_txn_date,
            ct.amount_satang as counterpart_amount_satang, ct.direction as counterpart_direction,
            ca.nickname as counterpart_account_nickname
     from transfer_match tm
     join txn ct on ct.id = case when tm.debit_txn_id = $2 then tm.credit_txn_id else tm.debit_txn_id end
     join bank_account ca on ca.id = ct.bank_account_id and ca.user_id = $1
     where (tm.debit_txn_id = $2 or tm.credit_txn_id = $2) and tm.status <> 'rejected'`,
    [user.id, txnId],
  );

  res.json({ ...txn, splits, transfer_matches: transferMatches });
}));

const CLASSIFICATIONS = ['income', 'expense', 'internal_transfer', 'excluded'] as const;
// §10.2 — คำนวณภาษี (Slice 8) อ่านคอลัมน์นี้อย่างเดียว รายงานเดิมอ่าน classification อย่างเดียว
// สองคอลัมน์ขัดกันได้โดยตั้งใจ (ดูคอมเมนต์ migration 010)
const TAX_TREATMENTS = [
  'personal',
  'business_income',
  'business_expense',
  'non_deductible',
  'internal_transfer',
  'excluded',
] as const;

async function ownedTxn(userId: number, txnId: number): Promise<{ id: number; amount_satang: number } | null> {
  const { rows } = await query<{ id: number; amount_satang: number }>(
    `select t.id, t.amount_satang from txn t
     join bank_account a on a.id = t.bank_account_id
     where a.user_id = $1 and t.id = $2`,
    [userId, txnId],
  );
  return rows[0] ?? null;
}

transactionsRouter.patch('/transactions/:id/annotation', requireUser(async (req, res, user) => {
  const txnId = pathId(req);
  if (!(await ownedTxn(user.id, txnId))) throw new HttpError(404, 'ไม่พบธุรกรรม');

  const b = req.body as Body;
  const classification = str(b, 'classification');
  if (!(CLASSIFICATIONS as readonly string[]).includes(classification)) {
    throw new HttpError(400, `classification ต้องเป็นหนึ่งใน ${CLASSIFICATIONS.join(', ')}`);
  }
  const note = optionalStr(b, 'note', 500);

  // §10.1: transaction override tax entity ของ bank account ได้ — ไม่ส่ง field นี้มา = ไม่แตะค่าเดิม
  // (ต่างจาก classification/note ที่ resend ทุกครั้งอยู่แล้ว) ส่ง null มาตรง ๆ = ล้าง override กลับไปใช้ default ของบัญชี
  const taxEntityIdProvided = Object.prototype.hasOwnProperty.call(b, 'tax_entity_id');
  let taxEntityId: number | null = null;
  if (taxEntityIdProvided && b.tax_entity_id != null) {
    taxEntityId = id(b, 'tax_entity_id');
    await assertOwnsTaxEntity(user.id, taxEntityId);
  }

  // §10.2/§7.5: tax_treatment เหมือน tax_entity_id ไม่ใช่เหมือน classification — ไม่ส่ง field มา = ไม่แตะค่าเดิม
  // ผู้ใช้ต้องเลือกเองเสมอ (Bank Debit ไม่ใช่ค่าใช้จ่ายหักภาษีอัตโนมัติ) ระบบห้ามล้างค่าที่ตั้งไว้แล้วโดยไม่ตั้งใจ
  const taxTreatmentProvided = Object.prototype.hasOwnProperty.call(b, 'tax_treatment');
  let taxTreatment: string | null = null;
  if (taxTreatmentProvided && b.tax_treatment != null) {
    taxTreatment = enumStr(b, 'tax_treatment', TAX_TREATMENTS);
  }

  const row = await tx(async (c) => {
    const before = (await c.query('select * from txn_annotation where txn_id = $1', [txnId])).rows[0] ?? null;

    const { rows } = await c.query(
      `insert into txn_annotation (txn_id, classification, note, tax_entity_id, tax_treatment, review_status, reviewed_at, updated_at)
       values ($1, $2, $3, $4, $5, 'reviewed', now(), now())
       on conflict (txn_id) do update set
         classification = excluded.classification,
         note = excluded.note,
         tax_entity_id = case when $6 then excluded.tax_entity_id else txn_annotation.tax_entity_id end,
         tax_treatment = case when $7 then excluded.tax_treatment else txn_annotation.tax_treatment end,
         review_status = 'reviewed',
         reviewed_at = now(),
         updated_at = now()
       returning *`,
      [txnId, classification, note, taxEntityId, taxTreatment, taxEntityIdProvided, taxTreatmentProvided],
    );
    const after = rows[0];

    await audit(c, { userId: user.id, action: 'txn.annotate', entityType: 'txn', entityId: txnId, before, after, ip: req.ip ?? null });
    return after;
  });
  res.json(row);
}));

type SplitInput = { category_id: number; amount_satang: number; note: string | null };

function parseSplits(body: unknown): SplitInput[] {
  // array ว่าง = ล้าง split ทั้งหมดกลับเป็นศูนย์ (ยอมรับได้ ผู้ใช้ต้อง clear ได้หลังตั้งไปแล้ว)
  if (!Array.isArray(body)) throw new HttpError(400, 'ต้องส่ง array ของรายการแยกยอด');
  return body.map((item, i) => {
    if (typeof item !== 'object' || item === null) throw new HttpError(400, `รายการที่ ${i + 1} ไม่ถูกต้อง`);
    const o = item as Body;
    const amount = Number(o.amount_satang);
    if (!Number.isInteger(amount) || amount <= 0) throw new HttpError(400, `จำนวนเงินของรายการที่ ${i + 1} ไม่ถูกต้อง`);
    return { category_id: id(o, 'category_id'), amount_satang: amount, note: optionalStr(o, 'note', 500) };
  });
}

// ponytail: เช็คผลรวมใน application ไม่ใช่ DB constraint — CHECK ข้ามหลายแถวทำไม่ได้ใน Postgres ตรง ๆ
// (ต้อง trigger/deferred constraint) endpoint นี้เป็นจุดเขียนเดียวของ txn_split ต่อ txn เลยพอเช็คที่นี่ที่เดียว
transactionsRouter.put('/transactions/:id/splits', requireUser(async (req, res, user) => {
  const txnId = pathId(req);
  const splits = parseSplits(req.body);

  const result = await tx(async (c) => {
    const owned = await c.query<{ amount_satang: number }>(
      `select t.amount_satang from txn t
       join bank_account a on a.id = t.bank_account_id
       where a.user_id = $1 and t.id = $2`,
      [user.id, txnId],
    );
    const txn = owned.rows[0];
    if (!txn) throw new HttpError(404, 'ไม่พบธุรกรรม');

    const categoryIds = [...new Set(splits.map((s) => s.category_id))];
    const cats = await c.query(
      `select id from category where id = any($1) and (user_id is null or user_id = $2)`,
      [categoryIds, user.id],
    );
    if (cats.rowCount !== categoryIds.length) throw new HttpError(400, 'มีหมวดที่ไม่มีอยู่จริงหรือไม่ใช่ของคุณ');

    const before = (await c.query('select * from txn_split where txn_id = $1 order by id', [txnId])).rows;

    await c.query('delete from txn_split where txn_id = $1', [txnId]);
    for (const s of splits) {
      await c.query(
        'insert into txn_split (txn_id, category_id, amount_satang, note) values ($1, $2, $3, $4)',
        [txnId, s.category_id, s.amount_satang, s.note],
      );
    }

    // array ว่าง = ล้าง split ทั้งหมด ไม่มีผลรวมให้เทียบ
    if (splits.length > 0) {
      const total = splits.reduce((sum, s) => sum + s.amount_satang, 0);
      if (total !== txn.amount_satang) {
        throw new HttpError(400, `ผลรวมยอดแยก (${total}) ต้องเท่ากับยอดธุรกรรม (${txn.amount_satang})`);
      }
    }

    const after = (await c.query('select * from txn_split where txn_id = $1 order by id', [txnId])).rows;
    await audit(c, { userId: user.id, action: 'txn.split', entityType: 'txn', entityId: txnId, before, after, ip: req.ip ?? null });
    return after;
  });

  res.json(result);
}));
