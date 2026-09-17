import { useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Badge, IconButton, Tooltip } from '@mui/material';
import HelpOutlineRounded from '@mui/icons-material/HelpOutlineRounded';
import { GuideTour } from './GuideTour.js';
import { guideForPath } from './guides.js';

const seenKey = (path: string) => `hyacinthia.guide.seen.${path}`;

/** localStorage โดนบล็อกได้ (โหมดส่วนตัว/ตั้งค่าเบราว์เซอร์) — อ่านไม่ได้ให้ถือว่า "ยังไม่เคยดู" */
function hasSeen(path: string): boolean {
  try {
    return localStorage.getItem(seenKey(path)) === '1';
  } catch {
    return false;
  }
}
function markSeen(path: string): void {
  try {
    localStorage.setItem(seenKey(path), '1');
  } catch {
    /* เขียนไม่ได้ = จุดแดงขึ้นทุกครั้ง ยอมรับได้ ไม่ใช่เหตุให้พัง */
  }
}

/**
 * ปุ่มคู่มือของหน้าปัจจุบัน — เรนเดอร์อยู่ใน `PageHeader` (level 1) จึงขึ้นครบทุกหน้าจากที่เดียว
 *
 * **ไม่เปิดเองอัตโนมัติ** ผู้ใช้ต้องกด แต่จุดสีบนปุ่มจะคาอยู่จนกดครั้งแรกของหน้านั้น
 * เพื่อให้คนใช้ครั้งแรก ๆ เห็นว่ามีคู่มืออยู่ (จำต่อเบราว์เซอร์ ไม่ได้เก็บบนเซิร์ฟเวอร์ —
 * ถ้าวันหนึ่งต้องจำข้ามเครื่อง ค่อยเพิ่มตาราง user_pref)
 */
export function GuideButton() {
  const { pathname } = useLocation();
  const guide = guideForPath(pathname);
  const topPath = '/' + (pathname.split('/')[1] ?? '');
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(() => hasSeen(topPath));
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (!guide) return null;

  const start = () => {
    markSeen(topPath);
    setSeen(true);
    setOpen(true);
  };
  // คืน focus ให้ปุ่มต้นทางหลังปิด ไม่งั้น focus หลุดไปต้นเอกสาร
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <>
      <Tooltip title={`คู่มือหน้า${guide.title}`}>
        <Badge color="primary" variant="dot" invisible={seen} overlap="circular">
          <IconButton ref={triggerRef} onClick={start} aria-label={`เปิดคู่มือหน้า${guide.title}`}>
            <HelpOutlineRounded />
          </IconButton>
        </Badge>
      </Tooltip>
      {open && <GuideTour guide={guide} onClose={close} />}
    </>
  );
}
