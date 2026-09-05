import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createTestDb } from './helpers/db.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

async function migrationFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
}

// §13: ทุก migration ต้อง roll-forward ได้ทั้งบน DB ใหม่และ DB ที่มีข้อมูลเดิมอยู่แล้ว
test('migrate() roll-forward', async (t) => {
  const db = await createTestDb();
  if (db.skip) {
    t.skip(db.reason);
    return;
  }
  t.after(db.cleanup);

  let seededBankAccountId: number;
  let seededTxnId: number;

  await t.test('applies every migration file on a brand-new database', async () => {
    const files = await migrationFiles();
    const applied = await db.migrate();
    assert.deepEqual(applied, files);

    const { rows } = await db.pool.query('select filename from schema_migration order by filename');
    assert.deepEqual(rows.map((r) => r.filename), files);

    const kbank = await db.pool.query<{
      sender_email: string;
      sender_domain: string;
      subject_monthly: string;
      subject_ondemand: string;
      attachment_filename_pattern: string;
      parser_key: string;
    }>(
      `select sender_email, sender_domain, subject_monthly, subject_ondemand,
              attachment_filename_pattern, parser_key
       from bank where lower(name) = 'kbank'`,
    );
    assert.deepEqual(kbank.rows[0], {
      sender_email: 'K-ElectronicDocument@kasikornbank.com',
      sender_domain: 'kasikornbank.com',
      subject_monthly: '^E-statement for saving account no\\. [Xx\\d-]+ \\[\\d+\\]$',
      subject_ondemand: '^E-statement for saving account no\\. [Xx\\d-]+ \\[\\d+\\]$',
      attachment_filename_pattern: '^STM_SA\\d{4}_\\d{2}[A-Z]{3}\\d{2}_\\d{2}[A-Z]{3}\\d{2}\\.pdf$',
      parser_key: 'kbank',
    });
  });

  await t.test('continues from a mid-point database that already has real data', async () => {
    // กลับไปเป็น DB ว่างสนิทอีกครั้ง (ยังใช้ pool/scratch database เดิม — ดู comment ใน helpers/db.ts)
    await db.pool.query('drop schema public cascade; create schema public;');

    const upTo = '004_statement_pdf_fingerprint.sql';
    const files = await migrationFiles();
    const partial = await db.migrate({ upTo });
    assert.deepEqual(partial, files.filter((f) => f <= upTo));

    await db.pool.query(
      `insert into bank (
         name, sender_email, sender_domain, subject_monthly, subject_ondemand,
         attachment_filename_pattern, parser_key, is_active
       ) values ('KBank', 'custom@example.com', 'example.com', '^custom-monthly$', '^custom-request$', '^custom\\.pdf$', 'legacy-kbank', false)`,
    );

    // seed ข้อมูลจริงลงตารางที่มีอยู่แล้ว ก่อนรัน migration ที่เหลือ (005+ เมื่อมีในอนาคต)
    const user = await db.pool.query<{ id: number }>(
      `insert into app_user (google_sub, email, display_name, is_admin, status)
       values ('google-sub-1', 'member@example.com', 'Family Member', false, 'approved')
       returning id`,
    );
    const userId = user.rows[0]!.id;

    const emailAccount = await db.pool.query<{ id: number }>(
      `insert into email_account (user_id, email, refresh_token_enc)
       values ($1, 'member@example.com', 'enc:refresh-token')
       returning id`,
      [userId],
    );
    const emailAccountId = emailAccount.rows[0]!.id;

    // migration 003 มาพร้อมแถวธนาคาร SCB ให้อยู่แล้ว (bank_name_uniq กันชื่อซ้ำ) — ใช้แถวนั้นแทนการ insert ใหม่
    const bank = await db.pool.query<{ id: number }>(`select id from bank where lower(name) = 'scb'`);
    const bankId = bank.rows[0]!.id;

    const bankAccount = await db.pool.query<{ id: number }>(
      `insert into bank_account (user_id, bank_id, email_account_id, nickname, account_number, pdf_password_enc)
       values ($1, $2, $3, 'บัญชีหลัก', 'xxx-x-x6231-x', 'enc:pdf-password')
       returning id`,
      [userId, bankId, emailAccountId],
    );
    const bankAccountId = bankAccount.rows[0]!.id;
    seededBankAccountId = bankAccountId;

    const statement = await db.pool.query<{ id: number }>(
      `insert into statement (bank_account_id, gmail_message_id, gmail_attachment_id, period_start, period_end, status)
       values ($1, 'gmail-msg-1', 'gmail-att-1', '2026-08-01', '2026-08-31', 'parsed')
       returning id`,
      [bankAccountId],
    );
    const statementId = statement.rows[0]!.id;

    const txn = await db.pool.query<{ id: number }>(
      `insert into txn (statement_id, bank_account_id, txn_date, description, amount_satang, direction, running_balance_satang)
       values ($1, $2, '2026-08-15', 'โอนเงินเข้า', 10000, 'credit', 500000)
       returning id`,
      [statementId, bankAccountId],
    );
    seededTxnId = txn.rows[0]!.id;

    const throughSlice5 = await db.migrate({ upTo: '007_kbank_statement_parser.sql' });
    const legacyPlan = (await db.pool.query(
      "insert into monthly_plan(user_id,month_start) values($1,'2026-07-01') returning id", [userId],
    )).rows[0]!.id;
    const legacyItem = (await db.pool.query(
      "insert into monthly_plan_item(monthly_plan_id,kind,name,planned_amount_satang) values($1,'income','Legacy income',10000) returning id", [legacyPlan],
    )).rows[0]!.id;
    const rest = [...throughSlice5, ...await db.migrate()];
    assert.deepEqual(rest, files.filter((f) => f > upTo));
    const preservedItem = (await db.pool.query('select planned_amount_satang,income_record_id,installment_due_id from monthly_plan_item where id=$1', [legacyItem])).rows[0];
    assert.deepEqual(preservedItem, { planned_amount_satang: 10000, income_record_id: null, installment_due_id: null });

    const preservedKbank = await db.pool.query<{ sender_email: string; parser_key: string; is_active: boolean }>(
      "select sender_email, parser_key, is_active from bank where lower(name) = 'kbank'",
    );
    assert.deepEqual(preservedKbank.rows[0], {
      sender_email: 'custom@example.com',
      parser_key: 'legacy-kbank',
      is_active: false,
    });

    // ข้อมูลที่ seed ไว้ต้องยังอยู่ครบหลัง migrate ต่อจากจุดกลางทาง
    const txnCount = await db.pool.query('select count(*)::int as n from txn');
    assert.equal(txnCount.rows[0]!.n, 1);
  });

  // 005: หมวดระบบต้องถูก seed, archive แล้วเพิ่มเลขบัญชีเดิมซ้ำได้, confirmed transfer ต่อ txn ได้แค่คู่เดียว
  await t.test('005 seeds categories and enforces its new constraints', async () => {
    const categories = await db.pool.query<{ n: number }>(
      "select count(*)::int as n from category where is_system = true and user_id is null",
    );
    assert.equal(categories.rows[0]!.n, 13);

    const account = (
      await db.pool.query<{ user_id: number; bank_id: number; email_account_id: number; account_number: string }>(
        'select user_id, bank_id, email_account_id, account_number from bank_account where id = $1',
        [seededBankAccountId],
      )
    ).rows[0]!;

    const duplicateWhileActive = db.pool.query(
      `insert into bank_account (user_id, bank_id, email_account_id, nickname, account_number, pdf_password_enc)
       values ($1, $2, $3, 'ซ้ำ', $4, 'enc:x')`,
      [account.user_id, account.bank_id, account.email_account_id, account.account_number],
    );
    await assert.rejects(duplicateWhileActive);

    await db.pool.query('update bank_account set archived_at = now() where id = $1', [seededBankAccountId]);

    const reinserted = await db.pool.query<{ id: number }>(
      `insert into bank_account (user_id, bank_id, email_account_id, nickname, account_number, pdf_password_enc)
       values ($1, $2, $3, 'บัญชีใหม่', $4, 'enc:y') returning id`,
      [account.user_id, account.bank_id, account.email_account_id, account.account_number],
    );
    assert.ok(reinserted.rows[0]!.id > 0);

    const otherTxn = await db.pool.query<{ id: number }>(
      `insert into txn (statement_id, bank_account_id, txn_date, description, amount_satang, direction, running_balance_satang)
       values ((select statement_id from txn where id = $1), $2, '2026-08-16', 'โอนออกภายใน', 20000, 'debit', 480000)
       returning id`,
      [seededTxnId, seededBankAccountId],
    );
    const otherTxnId = otherTxn.rows[0]!.id;

    await db.pool.query(
      `insert into transfer_match (user_id, debit_txn_id, credit_txn_id, status, matched_by)
       values ($1, $2, $3, 'confirmed', 'system')`,
      [account.user_id, otherTxnId, seededTxnId],
    );

    const secondConfirmedForSameDebit = db.pool.query(
      `insert into transfer_match (user_id, debit_txn_id, credit_txn_id, status, matched_by)
       values ($1, $2, $3, 'confirmed', 'user')`,
      [account.user_id, otherTxnId, seededTxnId],
    );
    await assert.rejects(secondConfirmedForSameDebit);
  });

  // 006: month_start ต้องเป็นวันที่ 1, generate รายการประจำซ้ำไม่ได้, txn ผูก payment ที่ matched ได้คู่เดียว
  await t.test('006 enforces monthly planning constraints', async () => {
    const account = (
      await db.pool.query<{ user_id: number }>('select user_id from bank_account where id = $1', [seededBankAccountId])
    ).rows[0]!;

    await assert.rejects(
      db.pool.query(`insert into monthly_plan (user_id, month_start) values ($1, '2026-08-15')`, [account.user_id]),
    );

    const planId = (
      await db.pool.query<{ id: number }>(
        `insert into monthly_plan (user_id, month_start) values ($1, '2026-08-01') returning id`,
        [account.user_id],
      )
    ).rows[0]!.id;
    await assert.rejects(
      db.pool.query(`insert into monthly_plan (user_id, month_start) values ($1, '2026-08-01')`, [account.user_id]),
    );

    const ruleId = (
      await db.pool.query<{ id: number }>(
        `insert into recurring_rule (user_id, name, kind, amount_satang, frequency_unit, start_date)
         values ($1, 'ค่าเช่า', 'expense', 100000, 'month', '2026-08-01') returning id`,
        [account.user_id],
      )
    ).rows[0]!.id;
    const insertGenerated = () =>
      db.pool.query(
        `insert into monthly_plan_item
           (monthly_plan_id, recurring_rule_id, kind, name, planned_amount_satang, occurrence_date, due_date)
         values ($1, $2, 'expense', 'ค่าเช่า', 100000, '2026-08-05', '2026-08-05')`,
        [planId, ruleId],
      );
    await insertGenerated();
    await assert.rejects(insertGenerated());

    await assert.rejects(
      db.pool.query(
        `insert into recurring_rule (user_id, name, kind, amount_satang, frequency_unit, start_date, end_date)
         values ($1, 'ย้อนเวลา', 'expense', 1, 'month', '2026-08-01', '2026-07-01')`,
        [account.user_id],
      ),
    );

    const itemId = (
      await db.pool.query<{ id: number }>(
        `insert into monthly_plan_item (monthly_plan_id, kind, name, planned_amount_satang)
         values ($1, 'expense', 'ค่าน้ำ', 5000) returning id`,
        [planId],
      )
    ).rows[0]!.id;
    const matchPayment = () =>
      db.pool.query(
        `insert into monthly_item_payment
           (monthly_plan_item_id, amount_satang, paid_date, bank_account_id, txn_id, status, verified_at)
         values ($1, 5000, '2026-08-15', $2, $3, 'matched', now())`,
        [itemId, seededBankAccountId, seededTxnId],
      );
    await matchPayment();
    await assert.rejects(matchPayment());

    // แถวที่มาจากกฎต้องมี occurrence_date เสมอ ไม่งั้นหลุด unique index ไปสร้างซ้ำได้
    await assert.rejects(
      db.pool.query(
        `insert into monthly_plan_item (monthly_plan_id, recurring_rule_id, kind, name, planned_amount_satang)
         values ($1, $2, 'expense', 'ไม่มี occurrence', 1)`,
        [planId, ruleId],
      ),
    );

    // status='matched' ต้องมี txn_id เสมอ
    await assert.rejects(
      db.pool.query(
        `insert into monthly_item_payment (monthly_plan_item_id, amount_satang, paid_date, bank_account_id, status)
         values ($1, 5000, '2026-08-16', $2, 'matched')`,
        [itemId, seededBankAccountId],
      ),
    );
  });

  // 009: CHECK ของ tax_entity/tax_document, unique file_sha256 ต่อ user (ไม่ใช่ทั้งระบบ), unique link, FK ที่เลื่อนมาจาก 005
  await t.test('009 enforces tax vault constraints', async () => {
    const account = (
      await db.pool.query<{ user_id: number }>('select user_id from bank_account where id = $1', [seededBankAccountId])
    ).rows[0]!;
    const userA = account.user_id;

    const userB = (
      await db.pool.query<{ id: number }>(
        `insert into app_user (google_sub, email, display_name, is_admin, status)
         values ('google-sub-009-b', 'tax-b@example.com', 'Tax B', false, 'approved') returning id`,
      )
    ).rows[0]!.id;

    await assert.rejects(
      db.pool.query(`insert into tax_entity (user_id, entity_type, display_name) values ($1, 'invalid_type', 'x')`, [userA]),
    );

    const entityA = (
      await db.pool.query<{ id: number }>(
        `insert into tax_entity (user_id, entity_type, display_name) values ($1, 'individual', 'บุคคลธรรมดา') returning id`,
        [userA],
      )
    ).rows[0]!.id;
    const entityB = (
      await db.pool.query<{ id: number }>(
        `insert into tax_entity (user_id, entity_type, display_name) values ($1, 'individual', 'B ธรรมดา') returning id`,
        [userB],
      )
    ).rows[0]!.id;

    const insertDoc = (userId: number, entityId: number, sha: string, overrides: Partial<{ document_type: string; status: string }> = {}) =>
      db.pool.query<{ id: number }>(
        `insert into tax_document (
           user_id, tax_entity_id, document_type, tax_year, issuer_name, total_satang,
           storage_path, file_sha256, file_mime, file_size_bytes, original_filename, status
         ) values ($1, $2, $3, 2026, 'ร้านค้าตัวอย่าง', 10000, '/tmp/x.enc', $4, 'application/pdf', 100, 'x.pdf', $5)
         returning id`,
        [userId, entityId, overrides.document_type ?? 'receipt', sha, overrides.status ?? 'draft'],
      );

    await assert.rejects(insertDoc(userA, entityA, 'sha-bad-type', { document_type: 'invalid_type' }));
    await assert.rejects(insertDoc(userA, entityA, 'sha-bad-status', { status: 'invalid_status' }));

    const docA = (await insertDoc(userA, entityA, 'sha-duplicate-across-users')).rows[0]!.id;
    // ต่างคนถือใบเสร็จใบเดียวกันได้ (unique ต่อ user ไม่ใช่ทั้งระบบ)
    await assert.doesNotReject(insertDoc(userB, entityB, 'sha-duplicate-across-users'));
    // แต่ user เดียวกันอัปโหลด sha ซ้ำไม่ได้ตราบใดที่ยังไม่ archive
    await assert.rejects(insertDoc(userA, entityA, 'sha-duplicate-across-users'));

    const txnRow = (
      await db.pool.query<{ id: number }>(
        `insert into txn (statement_id, bank_account_id, txn_date, description, amount_satang, direction, running_balance_satang)
         values ((select statement_id from txn where id = $1), $2, '2026-08-17', 'ซื้อของใช้สำนักงาน', 10000, 'debit', 470000)
         returning id`,
        [seededTxnId, seededBankAccountId],
      )
    ).rows[0]!.id;

    await assert.rejects(
      db.pool.query(
        `insert into tax_document_txn_link (tax_document_id, txn_id, linked_amount_satang) values ($1, $2, 0)`,
        [docA, txnRow],
      ),
    );
    await db.pool.query(
      `insert into tax_document_txn_link (tax_document_id, txn_id, linked_amount_satang) values ($1, $2, 10000)`,
      [docA, txnRow],
    );
    await assert.rejects(
      db.pool.query(
        `insert into tax_document_txn_link (tax_document_id, txn_id, linked_amount_satang) values ($1, $2, 5000)`,
        [docA, txnRow],
      ),
    );

    // FK ที่เลื่อนมาจาก 005 — ตอนนี้ tax_entity มีจริงแล้ว ชี้ id ที่ไม่มีต้องโดน 23503
    await db.pool.query(
      `insert into txn_annotation (txn_id, classification, review_status) values ($1, 'expense', 'reviewed')`,
      [txnRow],
    );
    await assert.rejects(
      db.pool.query('update txn_annotation set tax_entity_id = 999999 where txn_id = $1', [txnRow]),
    );
    await db.pool.query('update txn_annotation set tax_entity_id = $1 where txn_id = $2', [entityA, txnRow]);
  });

  await t.test('010 enforces tax calculation constraints', async () => {
    const account = (
      await db.pool.query<{ user_id: number }>('select user_id from bank_account where id = $1', [seededBankAccountId])
    ).rows[0]!;
    const userId = account.user_id;
    const entityId = (
      await db.pool.query<{ id: number }>(
        `insert into tax_entity (user_id, entity_type, display_name) values ($1, 'individual', 'Slice 8 entity') returning id`,
        [userId],
      )
    ).rows[0]!.id;

    const txnRow = (
      await db.pool.query<{ id: number }>(
        `insert into txn (statement_id, bank_account_id, txn_date, description, amount_satang, direction, running_balance_satang)
         values ((select statement_id from txn where id = $1), $2, '2026-08-18', 'ค่าอุปกรณ์สำนักงาน', 20000, 'debit', 450000)
         returning id`,
        [seededTxnId, seededBankAccountId],
      )
    ).rows[0]!.id;
    await db.pool.query(
      `insert into txn_annotation (txn_id, classification, review_status) values ($1, 'expense', 'reviewed')`,
      [txnRow],
    );

    // §10.2: tax_treatment ต้องเป็นหนึ่งใน 6 ค่าเท่านั้น และปล่อย null ได้ (ผู้ใช้ยังไม่ได้ตัดสิน)
    await assert.rejects(
      db.pool.query(`update txn_annotation set tax_treatment = 'invalid_treatment' where txn_id = $1`, [txnRow]),
    );
    await db.pool.query(`update txn_annotation set tax_treatment = 'business_expense' where txn_id = $1`, [txnRow]);

    const insertClaim = (eligible: number, claimed: number) =>
      db.pool.query<{ id: number }>(
        `insert into tax_deduction_claim (user_id, tax_entity_id, tax_year, deduction_type, eligible_amount_satang, claimed_amount_satang)
         values ($1, $2, 2026, 'donation', $3, $4) returning id`,
        [userId, entityId, eligible, claimed],
      );
    // claimed ต้องไม่เกิน eligible
    await assert.rejects(insertClaim(10000, 20000));
    const claimId = (await insertClaim(10000, 10000)).rows[0]!.id;
    // ไม่มี unique ต่อ deduction_type — สองแถวประเภทเดียวกันในปีเดียวกันต้องทำได้ (drill-down ต่อเอกสาร)
    await assert.doesNotReject(insertClaim(5000, 5000));

    await assert.rejects(
      db.pool.query(`update tax_deduction_claim set tax_document_id = 999999 where id = $1`, [claimId]),
    );

    await db.pool.query(
      `insert into tax_calculation_snapshot (user_id, tax_entity_id, tax_year, rule_version, input_snapshot, result_snapshot)
       values ($1, $2, 2026, 'th-pit-2025.1', '{}'::jsonb, '{}'::jsonb)`,
      [userId, entityId],
    );
  });
});
