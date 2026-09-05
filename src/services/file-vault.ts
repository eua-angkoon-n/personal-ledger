import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdir, readFile as fsReadFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decryptBuffer, encryptBuffer } from '../crypto.js';
import { env } from '../env.js';

export type DetectedMime = 'application/pdf' | 'image/jpeg' | 'image/png';

// ไม่เชื่อ mimetype ที่ client อ้างมา ตรวจ magic bytes เอง — เหมือน hasPdfMagic() ที่ worker.ts ใช้กับ statement PDF
// §10.3 รับ "PDF หรือรูป" ในระยะแรก จึงรับแค่ PDF/JPEG/PNG
export function detectMime(buf: Buffer): DetectedMime | null {
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  return null;
}

export type StoredFile = { storagePath: string; sha256: string; size: number };

export function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** hash ของ plaintext ก่อนเข้ารหัส (GCM สุ่ม IV ทุกครั้ง ciphertext hash ใช้กันซ้ำไม่ได้) — path เป็น server-generated ล้วน กัน path traversal */
export async function storeFile(userId: number, buf: Buffer): Promise<StoredFile> {
  const sha256 = sha256Of(buf);
  const dir = join(env.taxDocStorageDir, String(userId));
  await mkdir(dir, { recursive: true });
  const storagePath = join(dir, `${randomUUID()}.enc`);
  await writeFile(storagePath, encryptBuffer(buf));
  return { storagePath, sha256, size: buf.length };
}

export async function readStoredFile(storagePath: string): Promise<Buffer> {
  return decryptBuffer(await fsReadFile(storagePath));
}
