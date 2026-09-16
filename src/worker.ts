import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findMaskedAccountCandidates, resolveAccount } from './account-match.js';
import { decrypt } from './crypto.js';
import { pool, query, tx } from './db.js';
import { env } from './env.js';
import {
  GmailHistoryStaleError,
  dkimPasses,
  fromAddress,
  getAttachment,
  getMessage,
  getProfile,
  hasPdfMagic,
  listHistory,
  listMessagesFromSender,
  pickPdfAttachments,
  refreshAccessToken,
  type GmailPayload,
} from './gmail.js';
import { parsers } from './parsers/index.js';
import type { ParsedStatement } from './parsers/types.js';
import { reconcileTransfers } from './services/transfer-matching.js';

type Bank = {
  id: number;
  name: string;
  sender_email: string;
  sender_domain: string;
  subject_monthly: string;
  subject_ondemand: string;
  attachment_filename_pattern: string;
  parser_key: string;
};

type BankAccountCandidate = { id: number; bank_id: number; account_number: string; pdf_password_enc: string };

export type SyncSummary = { messages_scanned: number; statements_inserted: number; skipped: number };

// ponytail: กัน sync ซ้อนต่อกล่องอีเมลเดียวด้วย memory Set พอสำหรับ instance เดียว
// ถ้าสเกลหลาย instance ค่อยย้ายไป pg_advisory_lock ต่อ email_account_id
const running = new Set<number>();

export async function syncEmailAccount(emailAccountId: number, opts: { full?: boolean } = {}): Promise<SyncSummary> {
  const empty = { messages_scanned: 0, statements_inserted: 0, skipped: 0 };
  if (running.has(emailAccountId)) return empty;
  running.add(emailAccountId);
  try {
    return await doSync(emailAccountId, opts.full === true);
  } finally {
    running.delete(emailAccountId);
  }
}

async function fullSync(accessToken: string, banks: Bank[]): Promise<{ messageIds: string[]; historyId: string }> {
  // historyId ต้องอ่านก่อน list เสมอ ไม่งั้นเมลที่เข้ามาระหว่าง sync หายถาวร
  const profile = await getProfile(accessToken);
  const ids = new Set<string>();
  for (const bank of banks) {
    for (const id of await listMessagesFromSender(accessToken, bank.sender_email)) ids.add(id);
  }
  return { messageIds: [...ids], historyId: profile.historyId };
}

async function doSync(emailAccountId: number, requestFull: boolean): Promise<SyncSummary> {
  const summary: SyncSummary = { messages_scanned: 0, statements_inserted: 0, skipped: 0 };

  const { rows } = await query<{ id: number; user_id: number; refresh_token_enc: string; history_id: string | null }>(
    'select id, user_id, refresh_token_enc, history_id from email_account where id = $1',
    [emailAccountId],
  );
  const account = rows[0];
  if (!account) return summary;

  const banks = (await query<Bank>('select * from bank where is_active = true')).rows;
  if (!banks.length) return summary;

  const accessToken = await refreshAccessToken(decrypt(account.refresh_token_enc));

  let sync: { messageIds: string[]; historyId: string };
  if (requestFull || !account.history_id) {
    sync = await fullSync(accessToken, banks);
  } else {
    try {
      sync = await listHistory(accessToken, account.history_id);
    } catch (e) {
      if (e instanceof GmailHistoryStaleError) sync = await fullSync(accessToken, banks);
      else throw e;
    }
  }

  // ความล้มเหลวต่อ 1 ข้อความถูกกันไว้ในนี้ ไม่ให้ข้อความเดียวที่พังทำให้ทั้งกล่องไม่ขยับ cursor
  for (const messageId of sync.messageIds) {
    summary.messages_scanned++;
    try {
      const inserted = await processMessage(accessToken, messageId, emailAccountId, banks);
      // statements_inserted นับไฟล์ ไม่ใช่อีเมล เพราะ SCB ย้อนหลังแนบหลาย statement ใน message เดียว
      summary.statements_inserted += inserted;
      if (inserted === 0) summary.skipped++;
    } catch (e) {
      console.error(`[worker] mailbox=${emailAccountId} message=${messageId} ล้มเหลว:`, e);
      summary.skipped++;
    }
  }

  // สำเร็จทั้งรอบ (list ได้ครบ) ถึงขยับ cursor — ถ้า list เองล้มเหลว (throw ก่อนถึงตรงนี้) cursor จะไม่ขยับ
  await query('update email_account set history_id = $2, last_synced_at = now() where id = $1', [
    emailAccountId,
    sync.historyId,
  ]);

  // จับคู่โอนภายในหลังเขียน txn ของรอบนี้เสร็จ — คู่ชัดเจนยืนยันเอง กรณีคลุมเครือเก็บเป็น suggestion
  // ไม่ผูกกับ tx() ของ statement ไหนโดยเฉพาะ พังแล้วไม่ควรทำให้ sync รอบนี้ fail ทั้งรอบ
  try {
    await reconcileTransfers(pool, account.user_id);
  } catch (e) {
    console.error(`[worker] mailbox=${emailAccountId} reconcileTransfers ล้มเหลว:`, e);
  }

  // ไม่มีขั้น reconcile แผนกับ statement อีกแล้ว — statement เข้ามาแล้วจบที่ txn เท่านั้น
  // การจ่าย/การรับเงินในแผนเป็นสิ่งที่ผู้ใช้บันทึกเอง ไม่มีอะไรต้องไล่จับคู่ตามหลัง

  return summary;
}

type ExtractResult = { ok: true; text: string } | { ok: false; reason: string };

/** qpdf ถอดรหัส (รหัสผ่านผ่าน stdin ไม่ใช่ argv) → pdftotext สกัดข้อความ ทั้งหมดอยู่ใน pipe ไม่แตะดิสก์ */
function extractText(pdfPath: string, password: string): Promise<ExtractResult> {
  return new Promise((resolve, reject) => {
    const qpdf = spawn('qpdf', ['--password-file=-', '--decrypt', pdfPath, '-']);
    const pdftotext = spawn('pdftotext', ['-layout', '-', '-']);

    // EPIPE ถ้าอีกฝั่งปิดสตรีมก่อน (เช่น PDF พังจนอ่านไม่จบ) — ไม่ใส่ listener แล้ว Node ถือเป็น uncaught exception ทั้งโปรเซส
    // ปล่อยให้ exit code ของแต่ละโปรเซสเป็นตัวตัดสินผลแทน ไม่ใช่ error event นี้
    qpdf.stdin.on('error', () => {});
    pdftotext.stdin.on('error', () => {});
    qpdf.stdout.pipe(pdftotext.stdin);
    qpdf.stdin.write(password + '\n');
    qpdf.stdin.end();

    const textChunks: Buffer[] = [];
    pdftotext.stdout.on('data', (d: Buffer) => textChunks.push(d));

    let qpdfCode: number | null = null;
    let pdftotextCode: number | null = null;
    let settled = false;

    function finish(): void {
      if (settled || qpdfCode === null || pdftotextCode === null) return;
      settled = true;
      // exit 0 = ผ่าน, exit 3 = มี warning แต่สำเร็จ (ต้องนับเป็นผ่าน), อื่น ๆ = พัง (รวมรหัสผิด)
      if (qpdfCode !== 0 && qpdfCode !== 3) {
        resolve({ ok: false, reason: 'decrypt_failed' });
      } else if (pdftotextCode !== 0) {
        resolve({ ok: false, reason: 'pdftotext_failed' });
      } else {
        resolve({ ok: true, text: Buffer.concat(textChunks).toString('utf8') });
      }
    }

    qpdf.on('error', reject);
    pdftotext.on('error', reject);
    qpdf.on('close', (code) => {
      qpdfCode = code ?? -1;
      finish();
    });
    pdftotext.on('close', (code) => {
      pdftotextCode = code ?? -1;
      finish();
    });
  });
}

async function writeParseFailed(
  bankAccountId: number,
  messageId: string,
  attachmentId: string,
  pdfSha256: string,
  rawPdfPath: string,
  reason: string,
): Promise<boolean> {
  const result = await query(
    `insert into statement (bank_account_id, gmail_message_id, gmail_attachment_id, pdf_sha256, period_start, period_end, raw_pdf_path, status, error_detail)
     values ($1, $2, $3, $4, null, null, $5, 'parse_failed', $6)
     on conflict (bank_account_id, pdf_sha256) where pdf_sha256 is not null do update
       set gmail_message_id = excluded.gmail_message_id,
           gmail_attachment_id = excluded.gmail_attachment_id,
           raw_pdf_path = excluded.raw_pdf_path,
           error_detail = excluded.error_detail
       where statement.status = 'parse_failed'
     returning id`,
    [bankAccountId, messageId, attachmentId, pdfSha256, rawPdfPath, JSON.stringify({ reason })],
  );
  return result.rowCount === 1;
}

async function writePending(
  bankAccountId: number,
  messageId: string,
  attachmentId: string,
  pdfSha256: string,
  rawPdfPath: string,
  text: string,
): Promise<boolean> {
  const truncated = text.length > 20_000;
  const errorDetail = {
    // ponytail: เก็บข้อความดิบทั้งก้อน (ตัดที่ 20,000 ตัวอักษร) ไว้ตรวจก่อนมี parser จริง
    // ต้องล้างทิ้งตอน Slice 3 — นี่คือประวัติธุรกรรมเต็ม ๆ อยู่ใน jsonb ที่ถูก backup
    slice2_text: truncated ? text.slice(0, 20_000) : text,
    truncated,
    chars: text.length,
    masked_candidates: findMaskedAccountCandidates(text),
  };
  const result = await query(
    `insert into statement (bank_account_id, gmail_message_id, gmail_attachment_id, pdf_sha256, period_start, period_end, raw_pdf_path, status, error_detail)
     values ($1, $2, $3, $4, null, null, $5, 'pending', $6)
     on conflict (bank_account_id, pdf_sha256) where pdf_sha256 is not null do update
       set gmail_message_id = excluded.gmail_message_id,
           gmail_attachment_id = excluded.gmail_attachment_id,
           raw_pdf_path = excluded.raw_pdf_path,
           status = 'pending',
           error_detail = excluded.error_detail
       where statement.status = 'parse_failed'
     returning id`,
    [bankAccountId, messageId, attachmentId, pdfSha256, rawPdfPath, JSON.stringify(errorDetail)],
  );
  return result.rowCount === 1;
}

async function writeParsedStatement(
  bankAccountId: number,
  messageId: string,
  attachmentId: string,
  pdfSha256: string,
  rawPdfPath: string,
  parsed: ParsedStatement,
): Promise<boolean> {
  return tx(async (client) => {
    const status = parsed.checksumValid ? 'parsed' : 'checksum_failed';
    const errorDetail = parsed.checksumValid ? null : JSON.stringify({ reason: 'checksum_failed' });
    const insertedStatement = await client.query<{ id: number }>(
      `insert into statement (
         bank_account_id, gmail_message_id, gmail_attachment_id, pdf_sha256, period_start, period_end,
         opening_balance_satang, closing_balance_satang, raw_pdf_path, status, error_detail
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (bank_account_id, pdf_sha256) where pdf_sha256 is not null do update set
         gmail_message_id = excluded.gmail_message_id,
         gmail_attachment_id = excluded.gmail_attachment_id,
         period_start = excluded.period_start,
         period_end = excluded.period_end,
         opening_balance_satang = excluded.opening_balance_satang,
         closing_balance_satang = excluded.closing_balance_satang,
         raw_pdf_path = excluded.raw_pdf_path,
         status = excluded.status,
         error_detail = excluded.error_detail
       where statement.status = 'parse_failed'
       returning id`,
      [
        bankAccountId,
        messageId,
        attachmentId,
        pdfSha256,
        parsed.periodStart,
        parsed.periodEnd,
        parsed.openingBalanceSatang,
        parsed.closingBalanceSatang,
        rawPdfPath,
        status,
        errorDetail,
      ],
    );
    const statementId = insertedStatement.rows[0]?.id;
    if (!statementId) return false;
    if (!parsed.checksumValid) return true;

    let rowsInserted = 0;
    for (const transaction of parsed.transactions) {
      const result = await client.query(
        `insert into txn (
           statement_id, bank_account_id, txn_date, txn_time, description, channel,
           amount_satang, direction, running_balance_satang
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (bank_account_id, txn_date, amount_satang, running_balance_satang) do nothing`,
        [
          statementId,
          bankAccountId,
          transaction.txnDate,
          transaction.txnTime,
          transaction.description,
          transaction.channel,
          transaction.amountSatang,
          transaction.direction,
          transaction.runningBalanceSatang,
        ],
      );
      rowsInserted += result.rowCount ?? 0;
    }
    await client.query(
      'update statement set rows_inserted = $2, rows_deduped = $3 where id = $1',
      [statementId, rowsInserted, parsed.transactions.length - rowsInserted],
    );
    return true;
  });
}

async function processMessage(
  accessToken: string,
  messageId: string,
  emailAccountId: number,
  banks: Bank[],
): Promise<number> {
  const message = await getMessage(accessToken, messageId);
  const payload: GmailPayload = message.payload;
  const headers = payload.headers ?? [];
  const from = headers.find((h) => h.name.toLowerCase() === 'from')?.value ?? '';
  const subject = headers.find((h) => h.name.toLowerCase() === 'subject')?.value ?? '';
  const senderAddr = fromAddress(from);

  const bank = banks.find((b) => b.sender_email.toLowerCase() === senderAddr);
  if (!bank) return 0;

  if (!dkimPasses(headers, bank.sender_domain)) {
    console.warn(`[worker] DKIM ไม่ผ่าน mailbox=${emailAccountId} message=${messageId} bank=${bank.name}`);
    return 0;
  }

  const subjectOk = new RegExp(bank.subject_monthly).test(subject) || new RegExp(bank.subject_ondemand).test(subject);
  if (!subjectOk) return 0;

  const attachments = pickPdfAttachments(payload, bank.attachment_filename_pattern);
  if (!attachments.length) return 0;

  const candidates = (
    await query<BankAccountCandidate>(
      // archived_at is not null = ผู้ใช้เก็บบัญชีเข้าคลังแล้ว หยุดรับ statement ใหม่ (ประวัติเดิมยังอยู่ครบ)
      'select id, bank_id, account_number, pdf_password_enc from bank_account where email_account_id = $1 and bank_id = $2 and archived_at is null',
      [emailAccountId, bank.id],
    )
  ).rows;

  if (!candidates.length) {
    console.warn(`[worker] ไม่มีบัญชีที่ผูกกับธนาคารนี้ mailbox=${emailAccountId} bank=${bank.name}`);
    return 0;
  }

  const dir = join(env.pdfStorageDir, String(emailAccountId));
  await mkdir(dir, { recursive: true });
  let inserted = 0;

  for (let index = 0; index < attachments.length; index++) {
    const attachment = attachments[index]!;
    const pdfBuf = await getAttachment(accessToken, messageId, attachment.attachmentId);
    if (!hasPdfMagic(pdfBuf)) {
      console.warn(`[worker] attachment ไม่ใช่ PDF mailbox=${emailAccountId} message=${messageId} file=${attachment.filename}`);
      continue;
    }
    const pdfSha256 = createHash('sha256').update(pdfBuf).digest('hex');
    // Gmail attachmentId เปลี่ยนได้ระหว่าง messages.get; hash ของไฟล์ต้นฉบับคือ identity ที่คงที่
    const duplicate = await query(
      `select 1 from statement s join bank_account a on a.id = s.bank_account_id
       where a.email_account_id = $1 and s.pdf_sha256 = $2 and s.status <> 'parse_failed'`,
      [emailAccountId, pdfSha256],
    );
    if (duplicate.rowCount) continue;
    const pdfPath = join(dir, `${messageId}_${index + 1}.pdf`);
    await writeFile(pdfPath, pdfBuf);

    for (const account of candidates) {
      const extracted = await extractText(pdfPath, decrypt(account.pdf_password_enc));
      if (!extracted.ok) {
        if (candidates.length === 1) {
          if (await writeParseFailed(account.id, messageId, attachment.attachmentId, pdfSha256, pdfPath, extracted.reason)) inserted++;
          break;
        }
        continue;
      }

      const parseFn = parsers[bank.parser_key as keyof typeof parsers];
      if (parseFn) {
        let parsed: ParsedStatement;
        try {
          parsed = parseFn(extracted.text);
        } catch (error) {
          const filenameAccount = resolveAccount(candidates, attachment.filename);
          const failedAccount = candidates.length === 1 ? account : filenameAccount;
          if (failedAccount && await writeParseFailed(
            failedAccount.id,
            messageId,
            attachment.attachmentId,
            pdfSha256,
            pdfPath,
            error instanceof Error ? error.message : 'parse_failed',
          )) inserted++;
          break;
        }
        const resolved = resolveAccount(candidates, parsed.accountNumber);
        if (!resolved) {
          console.warn(`[worker] เลขบัญชีใน statement ไม่ตรงหรือกำกวม mailbox=${emailAccountId} message=${messageId}`);
          break;
        }
        if (await writeParsedStatement(resolved.id, messageId, attachment.attachmentId, pdfSha256, pdfPath, parsed)) inserted++;
        break;
      }

      if (candidates.length === 1) {
        if (await writePending(account.id, messageId, attachment.attachmentId, pdfSha256, pdfPath, extracted.text)) inserted++;
        break;
      }
      const resolved = findMaskedAccountCandidates(extracted.text)
        .map((token) => resolveAccount(candidates, token))
        .find((candidate): candidate is BankAccountCandidate => candidate != null);
      if (resolved) {
        if (await writePending(resolved.id, messageId, attachment.attachmentId, pdfSha256, pdfPath, extracted.text)) inserted++;
        break;
      }
      console.warn(
        `[worker] ถอดรหัสผ่านด้วยรหัสของบัญชี ${account.id} แต่แยกไม่ออกว่าเป็นบัญชีไหน mailbox=${emailAccountId} message=${messageId}`,
      );
      break;
    }
  }
  return inserted;
}

export function startWorker(): void {
  const HOUR = 60 * 60 * 1000;

  const tick = async (): Promise<void> => {
    const { rows } = await query<{ id: number }>('select id from email_account');
    for (const { id } of rows) {
      try {
        const summary = await syncEmailAccount(id);
        if (summary.messages_scanned) {
          console.log(
            `[worker] mailbox=${id} scanned=${summary.messages_scanned} inserted=${summary.statements_inserted} skipped=${summary.skipped}`,
          );
        }
      } catch (e) {
        // แยก try/catch ต่อกล่อง: refresh token ที่ถูก revoke พังทุกครั้งไปตลอด ไม่ให้กล่องเดียวหยุดกล่องอื่น
        console.error(`[worker] mailbox=${id} sync ล้มเหลว:`, e);
      }
    }
  };

  // ต้องมี .catch() เสมอ — Node 22 default unhandled-rejections=throw ปล่อยพลาดคือทั้งโปรเซสตาย
  tick().catch((e) => console.error('[worker] tick แรกล้มเหลว:', e));
  setInterval(() => {
    tick().catch((e) => console.error('[worker] tick ล้มเหลว:', e));
  }, HOUR);
}
