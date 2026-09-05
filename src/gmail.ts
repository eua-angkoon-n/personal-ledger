import { env } from './env.js';

export type GmailHeader = { name: string; value: string };

export type GmailPayload = {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number };
  parts?: GmailPayload[];
};

export type GmailMessage = { id: string; payload: GmailPayload };

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** history.list คืน 404 เมื่อ historyId เก่าเกินไป (Gmail เก็บ history ไม่ตลอดไป) — ผู้เรียกต้องถอยไป full sync */
export class GmailHistoryStaleError extends Error {}

export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`ขอ access token ใหม่จาก Google ไม่สำเร็จ: ${res.status}`);
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

function authHeaders(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}` };
}

export async function getProfile(accessToken: string): Promise<{ historyId: string }> {
  const res = await fetch(`${GMAIL_BASE}/profile`, { headers: authHeaders(accessToken) });
  if (!res.ok) throw new Error(`gmail profile ล้มเหลว: ${res.status}`);
  return (await res.json()) as { historyId: string };
}

/** maxPages จำกัดไว้ให้ tax document picker (ผู้ใช้รอผลสด ๆ) ไม่ต้องไล่ทั้งกล่องเหมือน sync พื้นหลัง */
export async function listMessages(accessToken: string, q: string, opts: { maxPages?: number } = {}): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  let page = 0;
  do {
    const url = new URL(`${GMAIL_BASE}/messages`);
    url.searchParams.set('q', q);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: authHeaders(accessToken) });
    if (!res.ok) throw new Error(`gmail messages.list ล้มเหลว: ${res.status}`);
    const body = (await res.json()) as { messages?: { id: string }[]; nextPageToken?: string };
    for (const m of body.messages ?? []) ids.push(m.id);
    pageToken = body.nextPageToken;
    page++;
  } while (pageToken && (opts.maxPages == null || page < opts.maxPages));
  return ids;
}

export function listMessagesFromSender(accessToken: string, senderEmail: string): Promise<string[]> {
  return listMessages(accessToken, `from:${senderEmail}`);
}

/** startHistoryId เก่าเกินไป → โยน GmailHistoryStaleError ให้ผู้เรียกถอยไป full sync */
export async function listHistory(
  accessToken: string,
  startHistoryId: string,
): Promise<{ messageIds: string[]; historyId: string }> {
  const ids = new Set<string>();
  let pageToken: string | undefined;
  let historyId = startHistoryId;
  do {
    const url = new URL(`${GMAIL_BASE}/history`);
    url.searchParams.set('startHistoryId', startHistoryId);
    url.searchParams.set('historyTypes', 'messageAdded');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: authHeaders(accessToken) });
    if (res.status === 404) throw new GmailHistoryStaleError('historyId เก่าเกินไป');
    if (!res.ok) throw new Error(`gmail history.list ล้มเหลว: ${res.status}`);
    const body = (await res.json()) as {
      history?: { messagesAdded?: { message: { id: string } }[] }[];
      historyId?: string;
      nextPageToken?: string;
    };
    for (const h of body.history ?? []) {
      for (const m of h.messagesAdded ?? []) ids.add(m.message.id);
    }
    if (body.historyId) historyId = body.historyId;
    pageToken = body.nextPageToken;
  } while (pageToken);
  return { messageIds: [...ids], historyId };
}

/** format=full เสมอ — format=metadata ยุบ header ซ้ำ ซึ่งด่าน DKIM ต้องเห็นให้ครบ */
export async function getMessage(accessToken: string, messageId: string): Promise<GmailMessage> {
  const url = new URL(`${GMAIL_BASE}/messages/${messageId}`);
  url.searchParams.set('format', 'full');
  const res = await fetch(url, { headers: authHeaders(accessToken) });
  if (!res.ok) throw new Error(`gmail messages.get ล้มเหลว: ${res.status}`);
  return (await res.json()) as GmailMessage;
}

export async function getAttachment(accessToken: string, messageId: string, attachmentId: string): Promise<Buffer> {
  const url = `${GMAIL_BASE}/messages/${messageId}/attachments/${attachmentId}`;
  const res = await fetch(url, { headers: authHeaders(accessToken) });
  if (!res.ok) throw new Error(`gmail attachments.get ล้มเหลว: ${res.status}`);
  const body = (await res.json()) as { data: string };
  return Buffer.from(body.data, 'base64url');
}

export function hasPdfMagic(data: Buffer): boolean {
  return data.length >= 5 && data.toString('ascii', 0, 5) === '%PDF-';
}

/** `"KPLUS" <KPLUS@kasikornbank.com>` → `kplus@kasikornbank.com` */
export function fromAddress(headerValue: string): string {
  const m = headerValue.match(/<([^>]+)>/);
  const addr = m ? m[1]! : headerValue;
  return addr.trim().toLowerCase();
}

function stripComments(value: string): string {
  let prev: string;
  let s = value;
  do {
    prev = s;
    s = s.replace(/\([^()]*\)/g, '');
  } while (s !== prev);
  return s;
}

function domainOf(value: string): string {
  return value.split('@').pop()!.trim().toLowerCase();
}

/**
 * ด่าน DKIM แบบไม่ขึ้นกับลำดับ header — Gmail prepend Authentication-Results ของตัวเองเสมอ
 * แต่ผู้ส่งใส่ header ปลอมชื่อเดียวกันมาเองได้ ต้องนับให้ตรงว่าเหลือ "อันของ Gmail จริง" พอดี 1 อัน
 */
export function dkimPasses(headers: GmailHeader[], senderDomain: string): boolean {
  const domain = senderDomain.toLowerCase();

  const arHeaders = headers.filter((h) => h.name.toLowerCase() === 'authentication-results');

  const googleHeaders = arHeaders.filter((h) => {
    const stripped = stripComments(h.value);
    const authservId = stripped.split(';')[0]?.trim().split(/\s+/)[0]?.toLowerCase();
    return authservId === 'mx.google.com';
  });

  // เกิน 1 อัน = มีคนปลอม header มาเองด้วย authserv-id เดียวกัน นับผิดไม่ได้ ต้องปฏิเสธ
  if (googleHeaders.length !== 1) return false;

  const stripped = stripComments(googleHeaders[0]!.value);
  const segments = stripped.split(';').map((s) => s.trim());

  for (const seg of segments) {
    const dkimResult = seg.match(/^dkim=(\S+)/i);
    if (!dkimResult || dkimResult[1]!.toLowerCase() !== 'pass') continue;

    const idMatch = seg.match(/header\.i=([^\s;]+)/i);
    const dMatch = seg.match(/header\.d=([^\s;]+)/i);
    const raw = idMatch?.[1] ?? dMatch?.[1];
    if (!raw) continue;

    const d = domainOf(raw);
    if (d === domain || d.endsWith('.' + domain)) return true;
  }
  return false;
}

export type GmailAttachment = { attachmentId: string; filename: string };
export type GmailAttachmentCandidate = { attachmentId: string; filename: string; mimeType: string; size: number };

/** เดินทุก part หา attachment ทั้งหมดไม่กรอง mimetype/ชื่อ — ฐานให้ pickPdfAttachments กรองต่อ และให้ tax document picker ใช้ตรง ๆ */
export function listAttachments(payload: GmailPayload): GmailAttachmentCandidate[] {
  const found: GmailAttachmentCandidate[] = [];

  function walk(part: GmailPayload): void {
    if (part.filename && part.body?.attachmentId) {
      found.push({
        attachmentId: part.body.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
        size: part.body.size ?? 0,
      });
    }
    for (const p of part.parts ?? []) walk(p);
  }
  walk(payload);
  return found;
}

/** SCB ส่ง PDF เป็น octet-stream และอีเมลย้อนหลังแนบหลายเดือน — คืนทุกไฟล์ที่ชื่อและ MIME ตรงเงื่อนไข */
export function pickPdfAttachments(payload: GmailPayload, filenamePattern: string): GmailAttachment[] {
  const re = new RegExp(filenamePattern);
  return listAttachments(payload)
    .filter((a) => (a.mimeType === 'application/pdf' || a.mimeType === 'application/octet-stream') && re.test(a.filename))
    .map((a) => ({ attachmentId: a.attachmentId, filename: a.filename }));
}
