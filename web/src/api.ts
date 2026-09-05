export async function req<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${r.status} ${r.statusText}`);
  }
  return r.status === 204 ? (undefined as T) : ((await r.json()) as T);
}

export const post = <T>(path: string, body: unknown) =>
  req<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) =>
  req<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const put = <T>(path: string, body: unknown) =>
  req<T>(path, { method: 'PUT', body: JSON.stringify(body) });
export const del = (path: string) => req<void>(path, { method: 'DELETE' });

export type User = {
  id: number;
  email: string;
  display_name: string;
  is_admin: boolean;
  status: 'pending' | 'approved' | 'rejected';
};

export type Bank = {
  id: number;
  name: string;
  sender_email: string;
  sender_domain: string;
  subject_monthly: string;
  subject_ondemand: string;
  attachment_filename_pattern: string;
  parser_key: string;
  is_active: boolean;
};

export type EmailAccount = { id: number; email: string; last_synced_at: string | null };

export type Account = {
  id: number;
  nickname: string;
  account_number: string;
  promptpay_id: string | null;
  bank_id: number;
  bank_name: string;
  email_account_id: number;
  email: string;
};

export type Category = {
  id: number;
  user_id: number | null;
  name: string;
  kind: 'income' | 'expense';
  parent_id: number | null;
  is_system: boolean;
  is_active: boolean;
};

export type Classification = 'income' | 'expense' | 'internal_transfer' | 'excluded';
export type ReviewStatus = 'reviewed' | 'unreviewed';

export type TxnSplitInfo = { category_id: number; category_name: string; amount_satang: number };

export type TxnListRow = {
  id: number;
  txn_date: string;
  txn_time: string | null;
  description: string;
  amount_satang: number;
  direction: 'credit' | 'debit';
  running_balance_satang: number;
  is_internal_transfer: boolean;
  bank_account_id: number;
  account_nickname: string;
  account_purpose: 'personal' | 'business';
  bank_id: number;
  bank_name: string;
  classification: Classification;
  review_status: ReviewStatus;
  categories: TxnSplitInfo[];
  split_count: number;
};

export type TxnListResponse = {
  from: string;
  to: string;
  rows: TxnListRow[];
  total_count: number;
  limit: number;
  offset: number;
};

export type TxnSplit = { id: number; category_id: number; category_name: string; amount_satang: number; note: string | null };

export type TransferMatchRef = {
  id: number;
  status: 'suggested' | 'confirmed' | 'rejected';
  confidence: number;
  matched_by: 'system' | 'user';
  created_at: string;
  reviewed_at: string | null;
  counterpart_txn_id: number;
  counterpart_txn_date: string;
  counterpart_amount_satang: number;
  counterpart_direction: 'credit' | 'debit';
  counterpart_account_nickname: string;
};

export type TxnDetail = {
  id: number;
  txn_date: string;
  txn_time: string | null;
  description: string;
  channel: string | null;
  amount_satang: number;
  direction: 'credit' | 'debit';
  running_balance_satang: number;
  is_internal_transfer: boolean;
  created_at: string;
  bank_account_id: number;
  account_nickname: string;
  account_purpose: 'personal' | 'business';
  bank_id: number;
  bank_name: string;
  classification: Classification;
  review_status: ReviewStatus;
  annotation_note: string | null;
  statement_id: number;
  period_start: string | null;
  period_end: string | null;
  splits: TxnSplit[];
  transfer_matches: TransferMatchRef[];
};

export type SuggestedMatch = {
  id: number;
  status: 'suggested' | 'confirmed' | 'rejected';
  confidence: number;
  matched_by: 'system' | 'user';
  created_at: string;
  reviewed_at: string | null;
  debit_txn_id: number;
  debit_txn_date: string;
  debit_amount_satang: number;
  debit_direction: 'credit' | 'debit';
  debit_account_nickname: string;
  credit_txn_id: number;
  credit_txn_date: string;
  credit_amount_satang: number;
  credit_direction: 'credit' | 'debit';
  credit_account_nickname: string;
};

export type AccountCoverage = {
  bank_account_id: number;
  account_nickname: string;
  bank_id: number;
  bank_name: string;
  account_purpose: 'personal' | 'business';
  email: string;
  last_synced_at: string | null;
  latest_txn_date: string | null;
  latest_parsed_period_end: string | null;
  parsed_statement_count: number;
  pending_statement_count: number;
  parse_failed_count: number;
  checksum_failed_count: number;
  statement_behind: boolean;
};

export type FailedStatement = {
  id: number;
  bank_account_id: number;
  account_nickname: string;
  status: string;
  error_reason: unknown;
  created_at: string;
};

export type ReportSummary = {
  from: string;
  to: string;
  money_in_satang: number;
  money_out_satang: number;
  net_satang: number;
  internal_transfer_excluded_satang: number;
  internal_transfer_count: number;
  uncategorised_count: number;
  unreviewed_count: number;
  total_balance_satang: number;
  statement_health: { status: string; n: number }[];
  failed_statements: FailedStatement[];
  accounts_with_gaps: AccountCoverage[];
  data_coverage_note: string;
};

export type CategoryBreakdownRow = { category_id: number | null; category_name: string; total_satang: number; txn_count: number };
export type CategoryBreakdown = { from: string; to: string; rows: CategoryBreakdownRow[]; data_coverage_note: string };

export type CashFlowRow = { month: string; money_in_satang: number; money_out_satang: number; net_satang: number };
export type CashFlow = { from: string; to: string; rows: CashFlowRow[]; data_coverage_note: string };

export type AccountBalanceRow = { bank_account_id: number; account_nickname: string; txn_date: string; running_balance_satang: number };
export type AccountBalances = { from: string; to: string; rows: AccountBalanceRow[]; data_coverage_note: string };

export type DataCoverage = { rows: AccountCoverage[]; data_coverage_note: string };

export type PlanKind = 'income' | 'payroll_deduction' | 'expense' | 'reserve';
export type PaymentState = 'unpaid' | 'overdue' | 'partial' | 'declared' | 'verified' | 'skipped' | 'cancelled' | 'deducted' | 'not_required';
export type PaymentRowStatus = 'declared' | 'matched' | 'needs_review' | 'cancelled';

export type PlanItemPayment = {
  id: number;
  amount_satang: number;
  paid_date: string;
  bank_account_id: number;
  account_nickname: string;
  txn_id: number | null;
  status: PaymentRowStatus;
  verified_at: string | null;
};

export type PlanItem = {
  id: number;
  income_record_id: number | null;
  recurring_rule_id: number | null;
  installment_due_id: number | null;
  kind: PlanKind;
  name: string;
  category_id: number | null;
  category_name: string | null;
  planned_amount_satang: number;
  due_date: string | null;
  explicit_status: 'active' | 'skipped' | 'cancelled';
  note: string | null;
  paid_satang: number;
  matched_satang: number;
  needs_review_count: number;
  payment_state: PaymentState;
  payments: PlanItemPayment[];
};

export type IncomeDeduction = {
  id: number;
  monthly_plan_item_id: number;
  deduction_type: 'social_security' | 'withholding_tax' | 'other';
  name: string;
  amount_satang: number;
};
export type IncomeRecord = {
  id: number;
  monthly_plan_item_id: number;
  name: string;
  gross_amount_satang: number;
  expected_net_satang: number;
  bank_account_id: number | null;
  income_date: string | null;
  auto_match: boolean;
  deposit_txn_id: number | null;
  match_status: 'pending' | 'needs_review' | 'matched' | 'not_required';
  deductions: IncomeDeduction[];
};
export type IncomeCandidate = {
  id: number;
  txn_date: string;
  description: string;
  amount_satang: number;
  account_nickname: string;
};
export type InstallmentTotals = {
  total_payable_satang: number;
  paid_satang: number;
  matched_satang: number;
  outstanding_satang: number;
};
export type InstallmentPlan = InstallmentTotals & {
  id: number;
  name: string;
  total_amount_satang: number;
  down_payment_satang: number;
  financed_amount_satang: number;
  interest_satang: number;
  fee_satang: number;
  installment_count: number;
  frequency_unit: 'day' | 'month' | 'year';
  frequency_interval: number;
  first_due_date: string;
  down_payment_date: string | null;
  default_account_id: number | null;
  category_id: number | null;
  status: 'active' | 'completed' | 'cancelled';
};
export type InstallmentDue = {
  id: number;
  installment_no: number;
  due_date: string;
  amount_satang: number;
  paid_satang: number;
  matched_satang: number;
  outstanding_satang: number;
  status: 'planned' | 'partially_paid' | 'paid' | 'overdue' | 'skipped' | 'cancelled';
  monthly_plan_item_id: number | null;
  plan_closed: boolean;
  payments: PlanItemPayment[];
};
export type InstallmentDetail = InstallmentPlan & { dues: InstallmentDue[]; structural_editable: boolean };

export type PlanTotals = {
  planned_income_satang: number;
  planned_deduction_satang: number;
  planned_expense_satang: number;
  planned_reserve_satang: number;
  planned_available_satang: number;
};

export type PaymentStatusSummary = {
  total_count: number;
  total_due_satang: number;
  paid_satang: number;
  unpaid_count: number;
  overdue_count: number;
  partial_count: number;
  declared_count: number;
  verified_count: number;
  needs_review_count: number;
};

export type MonthlyPlan = {
  month: string;
  month_start: string;
  status: 'open' | 'closed';
  closed_at: string | null;
  // ภาพ ณ วันปิดเดือน เก็บไว้เพื่อ audit เท่านั้น — หน้าจออ่าน totals/payment_status/items ที่คำนวณสดเสมอ
  closed_snapshot: { totals: PlanTotals; payment_status: PaymentStatusSummary } | null;
  generated_item_count: number;
  totals: PlanTotals;
  payment_status: PaymentStatusSummary;
  items: PlanItem[];
  data_coverage_note: string;
};

export type RecurringRule = {
  id: number;
  name: string;
  kind: PlanKind;
  amount_mode: 'fixed' | 'estimated';
  amount_satang: number;
  frequency_unit: 'day' | 'week' | 'month' | 'year';
  frequency_interval: number;
  anchor_day: number | null;
  start_date: string;
  end_date: string | null;
  default_account_id: number | null;
  default_account_nickname: string | null;
  category_id: number | null;
  category_name: string | null;
  is_active: boolean;
};
