-- ยอดประมาณการที่จ่ายจริงแล้วต้องไม่ขึ้น "จ่ายบางส่วน" — สถานะการจ่ายจึงต้องรู้ที่ระดับ item ว่า
-- ยอดตามแผนเป็นการเดา (บิลจริงสูง/ต่ำกว่าได้) หรือเป็นยอดที่ต้องจ่ายให้ครบ
--
-- ทำไม copy ลง monthly_plan_item ไม่ join สดจาก recurring_rule.amount_mode:
-- รายการในแผนเป็น snapshot ของกฎ ณ วันที่กาง (§9.2, §16 ข้อ 16) — generateMonthlyItems ถึงข้ามกฎที่
-- กางลงเดือนนั้นไปแล้วทั้งกฎ ถ้า PAYMENT_STATE_SQL ไป join สดกับกฎ การแก้ amount_mode วันนี้จะย้อน
-- เปลี่ยนสถานะของเดือนที่ผู้ใช้ตรวจหรือปิดไปแล้วทันที และรายการเฉพาะเดือน (recurring_rule_id is null)
-- จะเป็นยอดประมาณการไม่ได้เลยเพราะไม่มีกฎให้ join
--
-- default 'fixed': ยอดที่ผู้ใช้กรอกเองคือยอดที่ต้องจ่ายจริง ต้องมีสถานะ partial ตามเดิม
alter table monthly_plan_item add column amount_mode text not null default 'fixed'
  check (amount_mode in ('fixed', 'estimated'));

-- backfill ครั้งเดียวจากกฎ — ข้อยกเว้นเดียวของกติกา "แก้กฎไม่ย้อนแก้เดือนที่กางแล้ว" เพราะคอลัมน์นี้
-- ยังไม่มีอยู่ตอนที่แถวพวกนั้นถูกกาง ไม่ backfill = รายการยอดประมาณการของเดือนที่เปิดดูไปแล้วค้าง
-- 'fixed' แล้วยังขึ้น "จ่ายบางส่วน" ต่อไป ซึ่งเป็นบั๊กที่ migration นี้กำลังแก้อยู่นี่เอง
update monthly_plan_item i
   set amount_mode = r.amount_mode
  from recurring_rule r
 where r.id = i.recurring_rule_id
   and r.amount_mode <> 'fixed';
