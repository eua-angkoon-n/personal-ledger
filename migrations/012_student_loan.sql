-- แผนปลดหนี้ กยศ. — เก็บแต่ "ข้อมูลตั้งต้น" ที่ผู้ใช้อ่านมาจากแอป กยศ. Connect
-- ตารางผ่อนกับวันที่ปิดหนี้เป็นของ derive ทุกครั้งที่อ่าน (src/services/student-loan.ts)
-- ไม่เก็บลง DB เหมือนที่สถานะการจ่ายในแผนรายเดือนก็ derive ผ่าน PAYMENT_STATE_SQL ไม่เก็บ
-- เก็บแล้วมันจะค้างเป็นของเก่าทันทีที่ผู้ใช้เปลี่ยนยอดเก็บออม

create table student_loan (
  id bigserial primary key,
  user_id bigint not null references app_user(id) on delete cascade,

  -- ยอดกู้ตามสัญญา = ฐานของ % ตาราง Step Up ไม่ใช่ยอดคงเหลือ
  -- (งวดที่ n ต้องชำระเงินต้น = STEP_UP_BP[n] % ของยอดนี้ ซึ่งเพิ่มขึ้นทุกปี)
  principal_original_satang bigint not null check (principal_original_satang > 0),
  -- วันครบกำหนดชำระงวดแรก (5 ก.ค. แรกหลังปลอดหนี้ 2 ปี) ใช้นับว่าตอนนี้อยู่งวดที่เท่าไหร่
  first_due_date date not null,

  -- ดอกเบี้ย กยศ. เดินรายวัน (คงเหลือ x 1% / 365) ยอดคงเหลือชุดหนึ่งจึงไม่มีความหมาย
  -- ถ้าไม่รู้ว่าอ่านมา ณ วันไหน — as_of_date เป็นจุดตั้งต้นของการจำลอง ไม่ใช่ metadata
  as_of_date date not null,
  principal_remaining_satang bigint not null check (principal_remaining_satang >= 0),
  interest_accrued_satang bigint not null default 0 check (interest_accrued_satang >= 0),

  -- ยอดที่จ่ายจริงต่อเดือน ถ้าต่ำกว่าขั้นต่ำของงวดนั้น เอนจินใช้ขั้นต่ำแทน
  monthly_payment_satang bigint not null default 0 check (monthly_payment_satang >= 0),
  -- เงินที่เก็บออมไว้จ่ายก้อนเดียว (ไม่ได้ส่งเข้า กยศ. ระหว่างทาง)
  monthly_saving_satang bigint not null default 0 check (monthly_saving_satang >= 0),
  savings_balance_satang bigint not null default 0 check (savings_balance_satang >= 0),

  -- ยอดครบกำหนดปีนี้ตามที่แอปแจ้ง ใช้เทียบกับที่โมเดลคิดได้เพื่อจับว่ากรอกผิดตั้งแต่ต้น
  -- ไม่ได้เข้าสูตรคำนวณ
  app_annual_due_satang bigint check (app_annual_due_satang > 0),

  -- ส่วนลดเงินต้นเมื่อปิดบัญชีก่อนกำหนด หน่วย basis point (300 = 3%)
  -- ไม่ hardcode เพราะเป็นมาตรการที่ กยศ. ปรับได้ ไม่ใช่ตัวเลขในสัญญา
  payoff_discount_bp integer not null default 300 check (payoff_discount_bp between 0 and 10000),
  payment_day integer not null default 5 check (payment_day between 1 and 28),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (principal_remaining_satang <= principal_original_satang)
);

-- ponytail: หนึ่งคนหนึ่งสัญญา กยศ. — ถ้าวันไหนต้องรองรับหลายสัญญา ให้ drop index นี้แล้วเพิ่มคอลัมน์ name
create unique index student_loan_user_uniq on student_loan(user_id);
