import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.ENCRYPTION_KEY = '0'.repeat(64);
const { detectMime, storeFile, readStoredFile } = await import('../src/services/file-vault.js');

test('detectMime: จำ PDF/JPEG/PNG จาก magic bytes ไม่ใช่นามสกุลไฟล์ ปฏิเสธไบต์ขยะ', () => {
  assert.equal(detectMime(Buffer.from('%PDF-1.4 blah')), 'application/pdf');
  assert.equal(detectMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(detectMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(detectMime(Buffer.from('ไม่ใช่ไฟล์ที่รองรับ')), null);
});

test('storeFile: ไฟล์บนดิสก์ต้องเข้ารหัสอยู่ (ไม่ใช่ plaintext) และอ่านกลับได้ไบต์เดิมเป๊ะ', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tax-vault-test-'));
  process.env.TAX_DOC_STORAGE_DIR = dir;
  t.after(() => rm(dir, { recursive: true, force: true }));

  const plaintext = Buffer.from('%PDF-1.4\nเนื้อหาเอกสารภาษีตัวอย่าง');
  const stored = await storeFile(42, plaintext);

  assert.equal(stored.size, plaintext.length);
  assert.match(stored.storagePath, /42/);

  const onDisk = await readFile(stored.storagePath);
  assert.notEqual(onDisk.toString('latin1').slice(0, 5), '%PDF-');

  const roundTripped = await readStoredFile(stored.storagePath);
  assert.ok(roundTripped.equals(plaintext));
});
