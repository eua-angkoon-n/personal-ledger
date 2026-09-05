import assert from 'node:assert/strict';
import test from 'node:test';

process.env.ENCRYPTION_KEY = '0'.repeat(64);
const { encrypt, decrypt, encryptBuffer, decryptBuffer } = await import('../src/crypto.js');

test('round-trip ข้อความไทยและอักขระพิเศษ', () => {
  const secret = 'รหัส PDF ๑๒๓ !@#$';
  assert.equal(decrypt(encrypt(secret)), secret);
});

test('ciphertext ไม่ซ้ำกันแม้ plaintext เดียวกัน', () => {
  assert.notEqual(encrypt('same'), encrypt('same'));
});

test('ciphertext ที่ถูกแก้ต้องถอดไม่ผ่าน ไม่ใช่คืนขยะ', () => {
  const [iv, tag, body] = encrypt('รหัสผ่าน').split('.') as [string, string, string];
  const flipped = Buffer.from(body, 'base64');
  flipped[0] ^= 0x01;
  assert.throws(() => decrypt(`${iv}.${tag}.${flipped.toString('base64')}`));
});

test('คีย์ผิดขนาดต้องล้มทันที ไม่ใช่เข้ารหัสด้วยคีย์อ่อน', () => {
  process.env.ENCRYPTION_KEY = 'abcd';
  assert.throws(() => encrypt('x'), /64/);
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
});

test('encryptBuffer/decryptBuffer: round-trip ไบต์ที่ไม่ใช่ UTF-8 ที่ถูกต้อง (ยัดผ่าน encrypt สตริงจะพัง)', () => {
  const raw = Buffer.from([0xff, 0xfe, 0x00, 0x50, 0x44, 0x46, 0x89, 0x50, 0x4e, 0x47]);
  const roundTripped = decryptBuffer(encryptBuffer(raw));
  assert.ok(roundTripped.equals(raw));
});

test('encryptBuffer: ciphertext บนดิสก์ไม่ซ้ำกันแม้ plaintext เดียวกัน', () => {
  const raw = Buffer.from('เอกสารภาษี');
  assert.notEqual(encryptBuffer(raw).toString('base64'), encryptBuffer(raw).toString('base64'));
});

test('decryptBuffer: ciphertext ที่ถูกแก้ต้องถอดไม่ผ่าน', () => {
  const blob = encryptBuffer(Buffer.from('รหัสผ่านไฟล์'));
  blob[blob.length - 1] ^= 0x01;
  assert.throws(() => decryptBuffer(blob));
});
