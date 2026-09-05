import { HttpError, isoDate, satang } from "../http.js";

export function expectedNet(gross: number, deductions: number[]): number {
  satang({ gross }, "gross");
  let net = BigInt(gross);
  for (const amount of deductions) {
    satang({ amount }, "amount");
    net -= BigInt(amount);
  }
  if (net < 0n) throw new HttpError(400, "รายการหักรวมเกินรายได้เต็ม");
  return Number(net);
}

export type InstallmentInput = {
  total_amount_satang: number;
  down_payment_satang: number;
  interest_satang: number;
  fee_satang: number;
  installment_count: number;
  frequency_unit: "day" | "month" | "year";
  frequency_interval: number;
  first_due_date: string;
  down_payment_date: string | null;
};

export function installmentSchedule(input: InstallmentInput) {
  for (const field of [
    "total_amount_satang",
    "down_payment_satang",
    "interest_satang",
    "fee_satang",
  ] as const)
    satang(input, field);
  const principal = expectedNet(input.total_amount_satang, [
    input.down_payment_satang,
  ]);
  const total =
    BigInt(principal) +
    BigInt(input.interest_satang) +
    BigInt(input.fee_satang);
  if (
    total + BigInt(input.down_payment_satang) >
    BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new HttpError(400, "ยอดรวมเกินขอบเขตที่รองรับ");
  if (
    !Number.isInteger(input.installment_count) ||
    input.installment_count < 1 ||
    input.installment_count > 1200 ||
    total < BigInt(input.installment_count)
  )
    throw new HttpError(
      400,
      "จำนวนงวดต้องอยู่ระหว่าง 1–1200 และแต่ละงวดต้องมียอดมากกว่า 0",
    );
  if (
    !Number.isInteger(input.frequency_interval) ||
    input.frequency_interval < 1 ||
    input.frequency_interval > 1200 ||
    !["day", "month", "year"].includes(input.frequency_unit)
  )
    throw new HttpError(400, "รอบผ่อนไม่ถูกต้อง");
  isoDate(input, "first_due_date");
  const first = new Date(`${input.first_due_date}T00:00:00Z`);
  const rows: {
    installment_no: number;
    due_date: string;
    amount_satang: number;
  }[] = [];
  if (input.down_payment_satang > 0)
    rows.push({
      installment_no: 0,
      due_date: isoDate(input, "down_payment_date"),
      amount_satang: input.down_payment_satang,
    });
  const each = total / BigInt(input.installment_count);
  for (let n = 0; n < input.installment_count; n++) {
    const date = new Date(first);
    const delta = n * input.frequency_interval;
    if (input.frequency_unit === "day")
      date.setUTCDate(first.getUTCDate() + delta);
    else {
      date.setUTCDate(1);
      date.setUTCMonth(
        first.getUTCMonth() +
          delta * (input.frequency_unit === "year" ? 12 : 1),
      );
      const end = new Date(date);
      end.setUTCMonth(end.getUTCMonth() + 1);
      end.setUTCDate(0);
      date.setUTCDate(Math.min(first.getUTCDate(), end.getUTCDate()));
    }
    if (date.getUTCFullYear() > 9999)
      throw new HttpError(400, "วันครบกำหนดเกินขอบเขตที่รองรับ");
    rows.push({
      installment_no: n + 1,
      due_date: date.toISOString().slice(0, 10),
      amount_satang: Number(
        n === input.installment_count - 1 ? total - each * BigInt(n) : each,
      ),
    });
  }
  return rows;
}
