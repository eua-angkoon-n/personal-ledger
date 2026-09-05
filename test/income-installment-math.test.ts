import assert from "node:assert/strict";
import test from "node:test";
import {
  expectedNet,
  installmentSchedule,
} from "../src/services/income-installment-math.js";

test("gross less deductions uses exact satang and rejects invalid totals", () => {
  assert.equal(expectedNet(10000, [750, 1000]), 8250);
  assert.equal(expectedNet(100, [100]), 0);
  assert.throws(() => expectedNet(100, [101]));
  assert.throws(() => expectedNet(Number.MAX_SAFE_INTEGER + 1, []));
});
test("installment final remainder, anchored dates, down payment, and bounds", () => {
  const base = {
    total_amount_satang: 10000,
    down_payment_satang: 0,
    interest_satang: 0,
    fee_satang: 0,
    installment_count: 3,
    frequency_unit: "month" as const,
    frequency_interval: 1,
    first_due_date: "2028-01-31",
    down_payment_date: null,
  };
  const rows = installmentSchedule(base);
  assert.deepEqual(
    rows.map((r) => r.amount_satang),
    [3333, 3333, 3334],
  );
  assert.deepEqual(
    rows.map((r) => r.due_date),
    ["2028-01-31", "2028-02-29", "2028-03-31"],
  );
  const withDown = installmentSchedule({
    ...base,
    down_payment_satang: 1000,
    down_payment_date: "2028-01-01",
    interest_satang: 200,
    fee_satang: 100,
  });
  assert.equal(withDown[0]!.installment_no, 0);
  assert.equal(
    withDown.reduce((s, r) => s + r.amount_satang, 0),
    10300,
  );
  assert.deepEqual(
    installmentSchedule({
      ...base,
      frequency_unit: "year",
      first_due_date: "2028-02-29",
    }).map((r) => r.due_date),
    ["2028-02-29", "2029-02-28", "2030-02-28"],
  );
  assert.throws(() =>
    installmentSchedule({
      ...base,
      total_amount_satang: Number.MAX_SAFE_INTEGER,
      fee_satang: 1,
    }),
  );
  assert.throws(() => installmentSchedule({ ...base, total_amount_satang: 2 }));
});
