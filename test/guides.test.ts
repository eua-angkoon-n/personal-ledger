// คู่มือระบบ (web/src/guide/guides.ts) อ้าง element ในหน้าเว็บด้วย CSS selector และขั้นที่หา
// element ไม่เจอจะถูก "ข้ามเงียบ ๆ" ตอนรัน — ซึ่งดีต่อผู้ใช้ (tour ไม่พัง) แต่แย่ต่อคนดูแล
// เพราะเปลี่ยนชื่อ id/aria-label แล้วคู่มือจะค่อย ๆ หายไปโดยไม่มีอะไรฟ้อง
//
// environment นี้ไม่มี browser automation จึงตรวจไม่ได้ว่าไฮไลต์ไปตกที่ถูกตัวจริง แต่ตรวจได้ว่า
// selector ที่อ้างถึงยังมีอยู่ใน source — เป็นเทสต์ที่จับ regression คลาสที่เกิดจริงบ่อยที่สุด
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { GUIDES, HELP_ORDER, guideForPath } from '../web/src/guide/guides.js';

const WEB_SRC = join(import.meta.dirname, '..', 'web', 'src');

const sources = readdirSync(WEB_SRC, { recursive: true, encoding: 'utf8' })
  .filter((p) => p.endsWith('.tsx'))
  .map((p) => readFileSync(join(WEB_SRC, p), 'utf8'))
  .join('\n');

/** แปลง selector ที่คู่มือใช้ → ข้อความที่ต้องเจอใน JSX (รองรับเฉพาะ 3 รูปแบบที่ guides.ts ใช้จริง) */
function jsxNeedle(selector: string): string {
  const attr = /^\[([a-z-]+)="(.+)"\]$/.exec(selector);
  if (attr) return `${attr[1]}="${attr[2]}"`;
  const id = /^#([\w-]+)$/.exec(selector);
  if (id) return `id="${id[1]}"`;
  throw new Error(`selector รูปแบบใหม่ที่เทสต์นี้ยังไม่รองรับ: ${selector}`);
}

test('คู่มือ: ทุก selector ที่อ้างถึงยังมีอยู่ใน web/src', () => {
  for (const [path, guide] of Object.entries(GUIDES)) {
    for (const step of guide.steps) {
      if (!step.selector) continue;
      assert.ok(
        sources.includes(jsxNeedle(step.selector)),
        `คู่มือของ ${path} ขั้น "${step.title}" ชี้ไปที่ ${step.selector} ซึ่งหาไม่เจอใน web/src แล้ว`,
      );
    }
  }
});

test('คู่มือ: ทุกหน้ามีอย่างน้อยหนึ่งขั้นที่ไม่ต้องพึ่ง selector', () => {
  // กันเคสที่หน้ายังไม่มีข้อมูล (ตารางเป็น EmptyState) แล้วทุกขั้นถูกกรองออกจนไม่เหลืออะไรให้อ่าน
  for (const [path, guide] of Object.entries(GUIDES)) {
    assert.ok(
      guide.steps.some((s) => !s.selector),
      `คู่มือของ ${path} ต้องมีขั้นแบบการ์ดกลางจอ (ไม่มี selector) อย่างน้อยหนึ่งขั้น`,
    );
  }
});

test('คู่มือ: ทุก path มี route จริงใน App.tsx และหน้า /help แสดงครบทุกหน้า', () => {
  const app = readFileSync(join(WEB_SRC, 'App.tsx'), 'utf8');
  for (const path of Object.keys(GUIDES)) {
    assert.ok(app.includes(`path="${path}"`), `GUIDES มี ${path} แต่ App.tsx ไม่มี route นี้`);
  }
  assert.deepEqual(
    [...HELP_ORDER].sort(),
    Object.keys(GUIDES).sort(),
    'HELP_ORDER กับ GUIDES ต้องมีชุด path เดียวกัน ไม่งั้นหน้า /help จะตกคู่มือของบางหน้าไป',
  );
});

test('คู่มือ: guideForPath ตัดเหลือ segment แรกเหมือน activeNavPath', () => {
  assert.equal(guideForPath('/installments/12'), GUIDES['/installments']);
  assert.equal(guideForPath('/transactions'), GUIDES['/transactions']);
  // /help ตั้งใจไม่มีคู่มือของตัวเอง (มันคือคู่มืออยู่แล้ว) ปุ่มคู่มือจึงไม่ขึ้นที่นั่น
  assert.equal(guideForPath('/help'), undefined);
  assert.equal(guideForPath('/'), undefined);
});
