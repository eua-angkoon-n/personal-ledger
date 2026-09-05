import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from './env.js';

function key(): Buffer {
  const k = Buffer.from(env.encryptionKey, 'hex');
  if (k.length !== 32) throw new Error('ENCRYPTION_KEY ต้องเป็น hex 64 ตัว (32 ไบต์): openssl rand -hex 32');
  return k;
}

/** เก็บเป็น `iv.tag.ciphertext` base64 — tag ทำให้ ciphertext ที่ถูกแก้ถอดไม่ผ่าน */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
}

export function decrypt(blob: string): string {
  const parts = blob.split('.');
  if (parts.length !== 3) throw new Error('ciphertext ผิดรูปแบบ');
  const [iv, tag, body] = parts.map((s) => Buffer.from(s, 'base64')) as [Buffer, Buffer, Buffer];
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}

// ไฟล์ไบนารี (PDF/รูป) ผ่าน encrypt()/decrypt() แบบสตริงไม่ได้ — .toString('utf8') บังคับ decode
// ไบต์ที่ไม่ใช่ UTF-8 ที่ถูกต้อง ทำให้ไฟล์เพี้ยน จึงต้องมีคู่ Buffer แยกไว้สำหรับ tax document vault
// เก็บบนดิสก์เป็น iv|tag|ciphertext ต่อกันดิบ — รูปแบบ base64 คั่นจุดของฟังก์ชันด้านบนเป็นของคอลัมน์ DB เท่านั้น
export function encryptBuffer(plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

export function decryptBuffer(blob: Buffer): Buffer {
  if (blob.length < 28) throw new Error('ciphertext ผิดรูปแบบ');
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const body = blob.subarray(28);
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]);
}
