import { Router } from 'express';
import { requireUser } from '../auth.js';
import { pool, query, tx } from '../db.js';
import { HttpError, id, optionalStr, pathId, satang, str, type Body } from '../http.js';
import { audit } from '../services/audit.js';
import { EFFECTIVE_TAX_ENTITY_SQL, soleTaxEntitySql } from '../services/report-query.js';
import { estimateTax, type TaxEstimate, type TaxInput } from '../services/tax-calculation.js';
import { resolveRuleSet } from '../services/tax-rules.js';
import { assertOwnsTaxEntity } from './tax-entities.js';

export const taxCalculationsRouter = Router();

function optId(q: Record<string, unknown>, field: string): number | null {
  const v = q[field];
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${field} ไม่ถูกต้อง`);
  return n;
}

function requiredYear(v: unknown, field = 'ปีภาษี'): number {
  const n = Number(v);
  if (typeof v !== 'string' && typeof v !== 'number') throw new HttpError(400, `${field}ไม่ถูกต้อง`);
  if (!Number.isInteger(n) || n < 2000 || n > 2200) throw new HttpError(400, `${field}ไม่ถูกต้อง`);
  return n;
}

async function ownedEntity(userId: number, taxEntityId: number): Promise<{ id: number; entity_type: 'individual' | 'sole_proprietor' | 'company' }> {
  const { rows } = await query<{ id: number; entity_type: 'individual' | 'sole_proprietor' | 'company' }>(
    'select id, entity_type from tax_entity where id = $1 and user_id = $2',
    [taxEntityId, userId],
  );
  if (!rows[0]) throw new HttpError(404, 'ไม่พบ Tax Entity');
  return rows[0];
}

type AggregatedInputs = {
  employmentIncomeSatang: number;
  otherIncomeSatang: number;
  deductibleExpenseSatang: number;
  deductionClaimSatang: number;
  withholdingSatang: number;
  withholdingCertificateSatang: number; // ตัวเทียบ ไม่ได้บวกเข้าสูตร (ดูคอมเมนต์ที่จุดใช้)
  unresolvedIncomeSatang: number; // income_record ที่ resolve entity ไม่ได้ (bank_account_id เป็น null)
};

// entity ของ income_record: ไม่มีคอลัมน์ของตัวเอง (§7.4) — resolve ผ่านบัญชีปลายทาง แล้วตกมาที่
// "entity เดียวในระบบ" เป็นชั้นสุดท้ายเหมือน EFFECTIVE_TAX_ENTITY_SQL ของฝั่ง txn
// left join ไม่ใช่ join: income_record ที่ bank_account_id เป็น null ต้องยังมีสิทธิ์ resolve ผ่านชั้นสุดท้าย
const INCOME_TAX_ENTITY_SQL = `coalesce(ba.default_tax_entity_id, ${soleTaxEntitySql('ir.user_id')})`;

// ปี "ตรง" ของ txn ใช้ extract(year from txn_date) ตรง ๆ ได้เพราะ txn_date เป็น calendar date ล้วน
// (ต่างจาก income_record ที่ปีอาจว่าง ต้อง coalesce กับ month_start ของแผน — ดู query ด้านล่าง)
async function aggregateTaxInputs(userId: number, taxEntityId: number, taxYearCE: number): Promise<AggregatedInputs> {
  const [employment, otherIncome, deductibleExpense, withholdingCert, claims, unresolvedIncome] = await Promise.all([
    // สอง scalar subquery แยกกัน ไม่ join income_deduction เข้ากับ income_record โดยตรง — ถ้า income_record
    // หนึ่งแถวมี deduction_type='withholding_tax' มากกว่าหนึ่งแถว (schema ไม่มี unique คุม) การ join ตรง ๆ
    // จะ fan-out แล้วนับ gross_amount_satang ของแถวนั้นซ้ำหลายรอบ — เงินได้ (money) ห้ามคลาดเคลื่อนแบบนี้
    query<{ gross: number; withholding: number }>(
      `select
         (select coalesce(sum(ir.gross_amount_satang), 0) from income_record ir
          join monthly_plan mp on mp.id = ir.monthly_plan_id
          left join bank_account ba on ba.id = ir.bank_account_id
          where ir.user_id = $1 and ${INCOME_TAX_ENTITY_SQL} = $2
            and extract(year from coalesce(ir.income_date, mp.month_start)) = $3)::bigint as gross,
         (select coalesce(sum(d.amount_satang), 0) from income_deduction d
          join income_record ir on ir.id = d.income_record_id
          join monthly_plan mp on mp.id = ir.monthly_plan_id
          left join bank_account ba on ba.id = ir.bank_account_id
          where d.deduction_type = 'withholding_tax' and ir.user_id = $1 and ${INCOME_TAX_ENTITY_SQL} = $2
            and extract(year from coalesce(ir.income_date, mp.month_start)) = $3)::bigint as withholding`,
      [userId, taxEntityId, taxYearCE],
    ),
    query<{ total: number }>(
      `select coalesce(sum(t.amount_satang), 0)::bigint as total
       from txn t join bank_account a on a.id = t.bank_account_id
       left join txn_annotation an on an.txn_id = t.id
       where a.user_id = $1 and t.direction = 'credit' and an.tax_treatment = 'business_income'
         and (${EFFECTIVE_TAX_ENTITY_SQL}) = $2 and extract(year from t.txn_date) = $3`,
      [userId, taxEntityId, taxYearCE],
    ),
    query<{ total: number }>(
      `select coalesce(sum(t.amount_satang), 0)::bigint as total
       from txn t join bank_account a on a.id = t.bank_account_id
       left join txn_annotation an on an.txn_id = t.id
       where a.user_id = $1 and t.direction = 'debit' and an.tax_treatment = 'business_expense'
         and (${EFFECTIVE_TAX_ENTITY_SQL}) = $2 and extract(year from t.txn_date) = $3`,
      [userId, taxEntityId, taxYearCE],
    ),
    query<{ total: number }>(
      `select coalesce(sum(withholding_satang), 0)::bigint as total from tax_document
       where user_id = $1 and tax_entity_id = $2 and tax_year = $3
         and document_type = 'withholding_certificate' and archived_at is null`,
      [userId, taxEntityId, taxYearCE],
    ),
    query<{ total: number }>(
      `select coalesce(sum(claimed_amount_satang), 0)::bigint as total from tax_deduction_claim
       where user_id = $1 and tax_entity_id = $2 and tax_year = $3`,
      [userId, taxEntityId, taxYearCE],
    ),
    // resolve entity ไม่ได้จริง ๆ เท่านั้นถึงนับเป็น unresolved — ไม่ใช่แค่ "bank_account_id เป็น null"
    // เพราะตอนนี้ผู้ใช้ที่มี entity เดียวจะ resolve ผ่านชั้นสุดท้ายได้แม้ไม่ได้ผูกบัญชี
    query<{ total: number }>(
      `select coalesce(sum(ir.gross_amount_satang), 0)::bigint as total
       from income_record ir
       join monthly_plan mp on mp.id = ir.monthly_plan_id
       left join bank_account ba on ba.id = ir.bank_account_id
       where ir.user_id = $1 and ${INCOME_TAX_ENTITY_SQL} is null
         and extract(year from coalesce(ir.income_date, mp.month_start)) = $2`,
      [userId, taxYearCE],
    ),
  ]);

  return {
    employmentIncomeSatang: Number(employment.rows[0]!.gross),
    otherIncomeSatang: Number(otherIncome.rows[0]!.total),
    deductibleExpenseSatang: Number(deductibleExpense.rows[0]!.total),
    deductionClaimSatang: Number(claims.rows[0]!.total),
    withholdingSatang: Number(employment.rows[0]!.withholding),
    withholdingCertificateSatang: Number(withholdingCert.rows[0]!.total),
    unresolvedIncomeSatang: Number(unresolvedIncome.rows[0]!.total),
  };
}

export type EmploymentIncomeRecord = {
  id: number;
  name: string;
  income_date: string | null;
  gross_amount_satang: number;
  month_start: string;
};

// ต้นทางของ "เงินได้จากงานประจำ" — §10.5 "Drill down ไปยัง Income Record" คืนเป็น list จริงแทนตัวเลขเดียว
// เพราะไม่มีหน้ารายการรายได้แยกตามปี (income_record ผูกกับ monthly_plan รายเดือน) ต่อ id ชี้กลับไปหน้าแผน
// ของเดือนนั้นได้ตรง ๆ (เหมือน bank_account_id เป็น null จึงไม่รวมแถวที่ resolve entity ไม่ได้เข้ามาที่นี่)
async function employmentIncomeRecords(userId: number, taxEntityId: number, taxYearCE: number): Promise<EmploymentIncomeRecord[]> {
  const { rows } = await query<EmploymentIncomeRecord>(
    `select ir.id, ir.name, ir.income_date, ir.gross_amount_satang, mp.month_start
     from income_record ir
     join monthly_plan mp on mp.id = ir.monthly_plan_id
     left join bank_account ba on ba.id = ir.bank_account_id
     where ir.user_id = $1 and ${INCOME_TAX_ENTITY_SQL} = $2
       and extract(year from coalesce(ir.income_date, mp.month_start)) = $3
     order by coalesce(ir.income_date, mp.month_start)`,
    [userId, taxEntityId, taxYearCE],
  );
  return rows;
}

export type UnrecordedIncomeTxn = {
  id: number;
  txn_date: string;
  description: string;
  amount_satang: number;
  bank_account_id: number;
  account_nickname: string;
};

// เกณฑ์ "น่าจะเป็นเงินเดือน/รายได้ประจำ" — ตั้งใจให้แคบไว้ก่อน เสนอผิดแย่กว่าเสนอไม่ครบมาก
// (เสนอผิด = ผู้ใช้กดยืนยันแล้วได้รายได้ปลอมในฐาน ส่วนเสนอไม่ครบ = เพิ่มเองจากหน้าธุรกรรมได้)
// วัดกับข้อมูลจริง: ไม่ใส่เกณฑ์พวกนี้เลยได้ 53 รายการ (เงินโอนจากญาติ ฝากเงินสด ดอกเบี้ย EDC ปนหมด)
// ใส่แล้วเหลือเฉพาะเงินเดือนที่เข้าทุกเดือนจริง
const RECURRING_MIN_MONTHS = 3; // เข้าอย่างน้อย 3 เดือนต่างกันในปีภาษีนั้น
const RECURRING_MIN_SATANG = 100000; // ต่ำกว่า 1,000 บาท ตัดทิ้ง — ดอกเบี้ย/เศษ EDC ไม่ใช่รายได้ประจำ

/**
 * เงินเข้าที่ "น่าจะเป็นรายได้ประจำ" แต่ยังไม่มี income_record รองรับ — ระบบหาให้ ผู้ใช้ยืนยัน
 *
 * ทำไมไม่สร้าง income_record ให้เงียบ ๆ เลย: ภาษีต้องใช้ยอด**ก่อนหัก** แต่ statement เห็นแค่ยอดหลังหัก
 * (ADR-0002 ข้อ 5) ถ้าระบบเดา gross = ยอดที่เข้าบัญชี ตัวเลขภาษีจะต่ำกว่าจริงและภาษีหัก ณ ที่จ่ายหายไป
 * ทั้งคู่แบบเงียบ ๆ — ตามแนวเดียวกับ transfer_match ของ 4A คือระบบ "เสนอ" คนเป็นคน "ยืนยัน"
 *
 * จับกลุ่มด้วย description ที่ถอดตัวเลขออก (เลข ref เปลี่ยนทุกเดือน ชื่อผู้โอนไม่เปลี่ยน) + บัญชีปลายทาง
 * แล้วคัดเฉพาะกลุ่มที่เข้าหลายเดือนและยอดใกล้เคียงกัน (min*2 >= max) — เงินโอนจากคนรู้จักที่ยอดสะเปะสะปะ
 * จะตกเกณฑ์นี้ไปเอง โดยไม่ต้องมี list ชื่อผู้โอนที่ต้อง maintain
 */
async function unrecordedIncomeTxns(userId: number, taxEntityId: number, taxYearCE: number): Promise<UnrecordedIncomeTxn[]> {
  const { rows } = await query<UnrecordedIncomeTxn>(
    `with candidates as (
       select t.id, t.txn_date, t.description, t.amount_satang, t.bank_account_id, a.nickname as account_nickname,
              regexp_replace(t.description, '[0-9]+', '', 'g') as pattern
       from txn t
       join bank_account a on a.id = t.bank_account_id
       left join txn_annotation an on an.txn_id = t.id
       where a.user_id = $1 and t.direction = 'credit'
         and (${EFFECTIVE_TAX_ENTITY_SQL}) = $2 and extract(year from t.txn_date) = $3
         and not t.is_internal_transfer
         and coalesce(an.classification, '') not in ('internal_transfer', 'excluded')
         and an.tax_treatment is distinct from 'business_income'
         and t.amount_satang >= ${RECURRING_MIN_SATANG}
         and not exists (
           select 1 from monthly_item_payment p
           join income_record ir on ir.monthly_plan_item_id = p.monthly_plan_item_id
           where p.txn_id = t.id and p.status = 'matched'
         )
     ),
     recurring as (
       select pattern, bank_account_id from candidates
       group by pattern, bank_account_id
       having count(distinct date_trunc('month', txn_date)) >= ${RECURRING_MIN_MONTHS}
          and min(amount_satang) * 2 >= max(amount_satang)
     )
     select c.id, c.txn_date, c.description, c.amount_satang, c.bank_account_id, c.account_nickname
     from candidates c
     join recurring r on r.pattern = c.pattern and r.bank_account_id = c.bank_account_id
     order by c.txn_date desc
     limit 100`,
    [userId, taxEntityId, taxYearCE],
  );
  return rows;
}

const MISSING_DOC_SAMPLE_LIMIT = 100;

export type UnlinkedBusinessTxnSample = { id: number; txn_date: string; description: string; amount_satang: number };
export type UnlinkedClaimSample = { id: number; deduction_type: string; claimed_amount_satang: number };

type MissingDocumentReport = {
  untreated_txn_count: number;
  unlinked_business_txn_count: number;
  // ตัวอย่างแถว (cap 100) — untreated_txn มี drill-down เต็มผ่าน /transactions?tax_treatment=none แล้ว
  // (ดู drilldownParams) ส่วนสองอย่างนี้ยังไม่มี filter dimension ให้ drill-down เต็มรูป จึงคืนตัวอย่างแถวแทน
  unlinked_business_txn_samples: UnlinkedBusinessTxnSample[];
  draft_document_count: number;
  unlinked_claim_count: number;
  unlinked_claim_samples: UnlinkedClaimSample[];
  unresolved_income_satang: number;
};

// §10.5 "แสดงรายการที่ยังขาดเอกสารหรือยังไม่ Review" — คืนทั้งจำนวนและตัวอย่างแถว (cap 100) ตามที่ระบุไว้
// untreated_txn drill-down เต็มผ่าน /transactions ด้วย tax_treatment=none (sentinel ใหม่ใน report-query.ts)
// draft_document drill-down เต็มผ่าน /tax-documents?status=draft (หน้านั้นรองรับ filter นี้อยู่แล้ว)
async function missingDocumentReport(userId: number, taxEntityId: number, taxYearCE: number, unresolvedIncomeSatang: number): Promise<MissingDocumentReport> {
  const [untreated, unlinked, unlinkedSamples, draftDocs, unlinkedClaims, unlinkedClaimSamples] = await Promise.all([
    query<{ n: number }>(
      `select count(*)::int as n
       from txn t join bank_account a on a.id = t.bank_account_id
       left join txn_annotation an on an.txn_id = t.id
       where a.user_id = $1 and an.tax_treatment is null
         and (${EFFECTIVE_TAX_ENTITY_SQL}) = $2 and extract(year from t.txn_date) = $3`,
      [userId, taxEntityId, taxYearCE],
    ),
    query<{ n: number }>(
      `select count(*)::int as n
       from txn t join bank_account a on a.id = t.bank_account_id
       join txn_annotation an on an.txn_id = t.id
       where a.user_id = $1 and an.tax_treatment in ('business_income', 'business_expense')
         and (${EFFECTIVE_TAX_ENTITY_SQL}) = $2 and extract(year from t.txn_date) = $3
         and not exists (select 1 from tax_document_txn_link l where l.txn_id = t.id)`,
      [userId, taxEntityId, taxYearCE],
    ),
    query<UnlinkedBusinessTxnSample>(
      `select t.id, t.txn_date, t.description, t.amount_satang
       from txn t join bank_account a on a.id = t.bank_account_id
       join txn_annotation an on an.txn_id = t.id
       where a.user_id = $1 and an.tax_treatment in ('business_income', 'business_expense')
         and (${EFFECTIVE_TAX_ENTITY_SQL}) = $2 and extract(year from t.txn_date) = $3
         and not exists (select 1 from tax_document_txn_link l where l.txn_id = t.id)
       order by t.txn_date desc limit ${MISSING_DOC_SAMPLE_LIMIT}`,
      [userId, taxEntityId, taxYearCE],
    ),
    query<{ n: number }>(
      `select count(*)::int as n from tax_document
       where user_id = $1 and tax_entity_id = $2 and tax_year = $3 and status = 'draft' and archived_at is null`,
      [userId, taxEntityId, taxYearCE],
    ),
    query<{ n: number }>(
      `select count(*)::int as n from tax_deduction_claim
       where user_id = $1 and tax_entity_id = $2 and tax_year = $3 and tax_document_id is null`,
      [userId, taxEntityId, taxYearCE],
    ),
    query<UnlinkedClaimSample>(
      `select id, deduction_type, claimed_amount_satang from tax_deduction_claim
       where user_id = $1 and tax_entity_id = $2 and tax_year = $3 and tax_document_id is null
       order by id limit ${MISSING_DOC_SAMPLE_LIMIT}`,
      [userId, taxEntityId, taxYearCE],
    ),
  ]);

  return {
    untreated_txn_count: untreated.rows[0]!.n,
    unlinked_business_txn_count: unlinked.rows[0]!.n,
    unlinked_business_txn_samples: unlinkedSamples.rows,
    draft_document_count: draftDocs.rows[0]!.n,
    unlinked_claim_count: unlinkedClaims.rows[0]!.n,
    unlinked_claim_samples: unlinkedClaimSamples.rows,
    unresolved_income_satang: unresolvedIncomeSatang,
  };
}

function drilldownParams(taxEntityId: number, taxYearCE: number) {
  const from = `${taxYearCE}-01-01`;
  const to = `${taxYearCE + 1}-01-01`;
  return {
    other_income: { from, to, tax_entity_id: taxEntityId, tax_treatment: 'business_income', direction: 'credit' },
    deductible_expense: { from, to, tax_entity_id: taxEntityId, tax_treatment: 'business_expense', direction: 'debit' },
    // sentinel 'none' = ยังไม่ระบุ tax_treatment (IS NULL) — ให้ตรงกับ missing_document.untreated_txn_count เป๊ะ
    untreated_txn: { from, to, tax_entity_id: taxEntityId, tax_treatment: 'none' },
  };
}

async function buildSummary(userId: number, taxYearCE: number, taxEntityId: number) {
  const entity = await ownedEntity(userId, taxEntityId);
  const inputs = await aggregateTaxInputs(userId, taxEntityId, taxYearCE);
  const missingDocument = await missingDocumentReport(userId, taxEntityId, taxYearCE, inputs.unresolvedIncomeSatang);

  let estimate: TaxEstimate | null = null;
  let estimateUnavailableReason: string | null = null;
  let ruleVersion: string;

  if (entity.entity_type === 'individual') {
    const rules = resolveRuleSet(taxYearCE);
    ruleVersion = rules.version;
    const taxInput: TaxInput = {
      employmentIncomeSatang: inputs.employmentIncomeSatang,
      otherIncomeSatang: inputs.otherIncomeSatang,
      deductibleExpenseSatang: inputs.deductibleExpenseSatang,
      deductionClaimSatang: inputs.deductionClaimSatang,
      withholdingSatang: inputs.withholdingSatang,
    };
    estimate = estimateTax(taxInput, rules);
  } else {
    ruleVersion = `not-applicable:${entity.entity_type}`;
    estimateUnavailableReason = 'นิติบุคคล/กิจการเจ้าของคนเดียวใช้ระบบภาษีนิติบุคคลคนละแบบ ยังไม่รองรับการประมาณการในเฟสนี้ — แสดงได้เฉพาะยอดสรุป';
  }

  const [employmentIncomeRecordsList, unrecordedIncome] = await Promise.all([
    employmentIncomeRecords(userId, taxEntityId, taxYearCE),
    unrecordedIncomeTxns(userId, taxEntityId, taxYearCE),
  ]);

  return {
    tax_year: taxYearCE,
    tax_entity_id: taxEntityId,
    entity_type: entity.entity_type,
    rule_version: ruleVersion,
    inputs,
    estimate,
    estimate_unavailable_reason: estimateUnavailableReason,
    missing_document: missingDocument,
    employment_income_records: employmentIncomeRecordsList,
    unrecorded_income_txns: unrecordedIncome,
    drilldown_params: drilldownParams(taxEntityId, taxYearCE),
  };
}

// ไม่มี side effect ใด ๆ — คำนวณสดทุกครั้ง (บทเรียนจาก Slice 5: GET ที่เขียนข้อมูลเงียบ ๆ ทำให้เปิดดูเฉย ๆ
// ก็สร้างแถวขยะ) ผลลัพธ์นี้เป็น "ประมาณการภาษี" เสมอ ไม่ใช่ยอดที่ต้องชำระจริง
taxCalculationsRouter.get('/tax/:year/summary', requireUser(async (req, res, user) => {
  const taxYearCE = requiredYear(req.params.year, 'ปีภาษี');
  const taxEntityId = optId(req.query as Record<string, unknown>, 'tax_entity_id');
  if (taxEntityId == null) throw new HttpError(400, 'ต้องระบุ tax_entity_id');
  await assertOwnsTaxEntity(user.id, taxEntityId);

  res.json(await buildSummary(user.id, taxYearCE, taxEntityId));
}));

// เขียน snapshot — 1 แถวต่อ 1 tax_entity_id เสมอ (ห้ามรวม Tax Entity คนละประเภทในผลเดียว, §7.5)
// input_snapshot ฝัง rule set ทั้งก้อนไว้ ไม่ใช่แค่ version string — แก้ตัวเลข rule ปีถัดไปจะไม่ย้อนเปลี่ยน
// ความหมายของ snapshot เก่าที่คำนวณไปแล้ว
taxCalculationsRouter.post('/tax/:year/calculate', requireUser(async (req, res, user) => {
  const taxYearCE = requiredYear(req.params.year, 'ปีภาษี');
  const b = req.body as Body;
  const taxEntityId = id(b, 'tax_entity_id');
  await assertOwnsTaxEntity(user.id, taxEntityId);

  const summary = await buildSummary(user.id, taxYearCE, taxEntityId);
  const rules = summary.estimate ? resolveRuleSet(taxYearCE) : null;

  const created = await tx(async (c) => {
    const { rows } = await c.query(
      `insert into tax_calculation_snapshot (user_id, tax_entity_id, tax_year, rule_version, input_snapshot, result_snapshot)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      [
        user.id,
        taxEntityId,
        taxYearCE,
        summary.rule_version,
        JSON.stringify({ rules, inputs: summary.inputs, drilldown_params: summary.drilldown_params, missing_document: summary.missing_document }),
        JSON.stringify({ estimate: summary.estimate, estimate_unavailable_reason: summary.estimate_unavailable_reason }),
      ],
    );
    const after = rows[0];
    await audit(c, {
      userId: user.id, action: 'tax_calculation_snapshot.create', entityType: 'tax_calculation_snapshot',
      entityId: after.id, after, ip: req.ip ?? null,
    });
    return after;
  });
  res.status(201).json(created);
}));

taxCalculationsRouter.get('/tax/:year/snapshots', requireUser(async (req, res, user) => {
  const taxYearCE = requiredYear(req.params.year, 'ปีภาษี');
  const taxEntityId = optId(req.query as Record<string, unknown>, 'tax_entity_id');
  if (taxEntityId != null) await assertOwnsTaxEntity(user.id, taxEntityId);
  const { rows } = await query(
    `select * from tax_calculation_snapshot
     where user_id = $1 and tax_year = $2 and ($3::bigint is null or tax_entity_id = $3)
     order by calculated_at desc`,
    [user.id, taxYearCE, taxEntityId],
  );
  res.json({ rows });
}));

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// §10.5 export — string join ฝั่ง server + <a download> ฝั่งเว็บ ไม่เพิ่ม dependency (ไม่มี CSV/PDF lib
// ในระบบนี้เลยตอนนี้) ต้อง audit ก่อนส่งเสมอเหมือน tax_document.download (§7.6)
taxCalculationsRouter.get('/tax/:year/export.csv', requireUser(async (req, res, user) => {
  const taxYearCE = requiredYear(req.params.year, 'ปีภาษี');
  const taxEntityId = optId(req.query as Record<string, unknown>, 'tax_entity_id');
  if (taxEntityId == null) throw new HttpError(400, 'ต้องระบุ tax_entity_id');
  await assertOwnsTaxEntity(user.id, taxEntityId);

  const summary = await buildSummary(user.id, taxYearCE, taxEntityId);
  const e = summary.estimate;

  const lines: string[] = [];
  lines.push('รายการ,จำนวนเงิน (บาท)');
  lines.push(`ประมาณการภาษี ปีภาษี,${taxYearCE}`);
  lines.push(`Tax Entity,${taxEntityId}`);
  lines.push(`Rule Version,${csvEscape(summary.rule_version)}`);
  lines.push(`เงินได้จากงานประจำ,${(summary.inputs.employmentIncomeSatang / 100).toFixed(2)}`);
  lines.push(`เงินได้ธุรกิจอื่น,${(summary.inputs.otherIncomeSatang / 100).toFixed(2)}`);
  lines.push(`ค่าใช้จ่ายหักภาษีได้,${(summary.inputs.deductibleExpenseSatang / 100).toFixed(2)}`);
  lines.push(`ค่าลดหย่อนที่ยื่นขอ,${(summary.inputs.deductionClaimSatang / 100).toFixed(2)}`);
  if (e) {
    lines.push(`ค่าใช้จ่ายเงินได้ (40(1)),${(e.employmentExpenseSatang / 100).toFixed(2)}`);
    lines.push(`ลดหย่อนส่วนตัว,${(e.personalAllowanceSatang / 100).toFixed(2)}`);
    lines.push(`เงินได้สุทธิ (ประมาณการ),${(e.netSatang / 100).toFixed(2)}`);
    lines.push(`ประมาณการภาษีที่ต้องชำระ,${(e.estimatedTaxSatang / 100).toFixed(2)}`);
    lines.push(`ภาษีหัก ณ ที่จ่ายแล้ว,${(e.withholdingSatang / 100).toFixed(2)}`);
    lines.push(`ประมาณการยอดที่ต้องชำระเพิ่ม/ขอคืน,${(e.estimatedPayableSatang / 100).toFixed(2)}`);
  } else {
    lines.push(`หมายเหตุ,${csvEscape(summary.estimate_unavailable_reason ?? '')}`);
  }

  await audit(pool, { userId: user.id, action: 'tax.export', entityType: 'tax_entity', entityId: taxEntityId, ip: req.ip ?? null });

  const csv = '﻿' + lines.join('\n');
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="tax-estimate-${taxYearCE}-${taxEntityId}.csv"`);
  res.send(csv);
}));

// §7.5 tax_deduction_claim CRUD — DELETE ทำได้จริง (ไม่ใช่ archive) ตาม §17 เพราะ before_data ใน
// audit_log เก็บทั้งแถวไว้แล้ว และ snapshot ที่คำนวณไปแล้วก็ freeze ยอดไว้แล้ว ไม่มีประวัติให้สูญหาย
const DEDUCTION_NOTE_MAX = 500;

taxCalculationsRouter.get('/tax/deduction-claims', requireUser(async (req, res, user) => {
  const q = req.query as Record<string, unknown>;
  const taxYearCE = q.tax_year == null || q.tax_year === '' ? null : requiredYear(q.tax_year, 'tax_year');
  const taxEntityId = optId(q, 'tax_entity_id');
  const { rows } = await query(
    `select c.* from tax_deduction_claim c
     where c.user_id = $1 and ($2::int is null or c.tax_year = $2) and ($3::bigint is null or c.tax_entity_id = $3)
     order by c.tax_year desc, c.deduction_type`,
    [user.id, taxYearCE, taxEntityId],
  );
  res.json({ rows });
}));

taxCalculationsRouter.post('/tax/deduction-claims', requireUser(async (req, res, user) => {
  const b = req.body as Body;
  const taxEntityId = id(b, 'tax_entity_id');
  await assertOwnsTaxEntity(user.id, taxEntityId);
  const taxYearCE = requiredYear(b.tax_year, 'tax_year');
  const rules = resolveRuleSet(taxYearCE);
  const deductionType = str(b, 'deduction_type', 40);
  if (!rules.deductionTypes.includes(deductionType)) {
    throw new HttpError(400, `deduction_type ต้องเป็นหนึ่งใน ${rules.deductionTypes.join(', ')}`);
  }
  const eligible = satang(b, 'eligible_amount_satang');
  const claimed = satang(b, 'claimed_amount_satang');
  if (claimed > eligible) throw new HttpError(400, 'claimed_amount_satang ต้องไม่เกิน eligible_amount_satang');
  const taxDocumentId = b.tax_document_id == null || b.tax_document_id === '' ? null : id(b, 'tax_document_id');
  if (taxDocumentId != null) {
    const owns = await query('select 1 from tax_document where id = $1 and user_id = $2', [taxDocumentId, user.id]);
    if (!owns.rowCount) throw new HttpError(403, 'เอกสารนี้ไม่ใช่ของคุณ');
  }
  const note = optionalStr(b, 'note', DEDUCTION_NOTE_MAX);

  const created = await tx(async (c) => {
    const { rows } = await c.query(
      `insert into tax_deduction_claim
         (user_id, tax_entity_id, tax_year, deduction_type, eligible_amount_satang, claimed_amount_satang, tax_document_id, note)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [user.id, taxEntityId, taxYearCE, deductionType, eligible, claimed, taxDocumentId, note],
    );
    const after = rows[0];
    await audit(c, { userId: user.id, action: 'tax_deduction_claim.create', entityType: 'tax_deduction_claim', entityId: after.id, after, ip: req.ip ?? null });
    return after;
  });
  res.status(201).json(created);
}));

taxCalculationsRouter.patch('/tax/deduction-claims/:id', requireUser(async (req, res, user) => {
  const claimId = pathId(req);
  const b = req.body as Body;
  const has = (field: string) => Object.prototype.hasOwnProperty.call(b, field);

  const updated = await tx(async (c) => {
    const before = (await c.query('select * from tax_deduction_claim where id = $1 and user_id = $2', [claimId, user.id])).rows[0];
    if (!before) throw new HttpError(404, 'ไม่พบค่าลดหย่อน');

    if (has('tax_document_id') && b.tax_document_id != null) {
      const owns = await c.query('select 1 from tax_document where id = $1 and user_id = $2', [id(b, 'tax_document_id'), user.id]);
      if (!owns.rowCount) throw new HttpError(403, 'เอกสารนี้ไม่ใช่ของคุณ');
    }

    const eligible = b.eligible_amount_satang == null ? before.eligible_amount_satang : satang(b, 'eligible_amount_satang');
    const claimed = b.claimed_amount_satang == null ? before.claimed_amount_satang : satang(b, 'claimed_amount_satang');
    if (claimed > eligible) throw new HttpError(400, 'claimed_amount_satang ต้องไม่เกิน eligible_amount_satang');

    const { rows } = await c.query(
      `update tax_deduction_claim set
         eligible_amount_satang = $2,
         claimed_amount_satang = $3,
         tax_document_id = case when $4 then $5 else tax_document_id end,
         note = case when $6 then $7 else note end,
         updated_at = now()
       where id = $1
       returning *`,
      [
        claimId,
        eligible,
        claimed,
        has('tax_document_id'),
        has('tax_document_id') ? (b.tax_document_id == null ? null : id(b, 'tax_document_id')) : null,
        has('note'),
        has('note') ? optionalStr(b, 'note', DEDUCTION_NOTE_MAX) : null,
      ],
    );
    const after = rows[0];
    await audit(c, { userId: user.id, action: 'tax_deduction_claim.update', entityType: 'tax_deduction_claim', entityId: claimId, before, after, ip: req.ip ?? null });
    return after;
  });
  res.json(updated);
}));

taxCalculationsRouter.delete('/tax/deduction-claims/:id', requireUser(async (req, res, user) => {
  const claimId = pathId(req);
  await tx(async (c) => {
    const before = (await c.query('select * from tax_deduction_claim where id = $1 and user_id = $2', [claimId, user.id])).rows[0];
    if (!before) throw new HttpError(404, 'ไม่พบค่าลดหย่อน');
    await c.query('delete from tax_deduction_claim where id = $1', [claimId]);
    await audit(c, { userId: user.id, action: 'tax_deduction_claim.delete', entityType: 'tax_deduction_claim', entityId: claimId, before, ip: req.ip ?? null });
  });
  res.status(204).end();
}));
