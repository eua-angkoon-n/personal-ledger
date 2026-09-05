create table income_record (
  id bigserial primary key,
  user_id bigint not null references app_user(id) on delete cascade,
  monthly_plan_id bigint not null references monthly_plan(id) on delete cascade,
  monthly_plan_item_id bigint not null unique references monthly_plan_item(id),
  name text not null,
  gross_amount_satang bigint not null check (gross_amount_satang >= 0),
  expected_net_satang bigint not null check (expected_net_satang between 0 and gross_amount_satang),
  bank_account_id bigint references bank_account(id),
  income_date date,
  auto_match boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table monthly_plan_item add column income_record_id bigint references income_record(id);
create table income_deduction (
  id bigserial primary key,
  income_record_id bigint not null references income_record(id) on delete cascade,
  monthly_plan_item_id bigint not null unique references monthly_plan_item(id),
  deduction_type text not null check (deduction_type in ('social_security','withholding_tax','other')),
  name text not null,
  amount_satang bigint not null check (amount_satang >= 0)
);
create index income_record_month_idx on income_record(user_id, monthly_plan_id);
create index income_deduction_record_idx on income_deduction(income_record_id);
create table installment_plan (
  id bigserial primary key,
  user_id bigint not null references app_user(id) on delete cascade,
  name text not null,
  category_id bigint references category(id),
  total_amount_satang bigint not null check (total_amount_satang > 0),
  down_payment_satang bigint not null default 0 check (down_payment_satang between 0 and total_amount_satang),
  financed_amount_satang bigint generated always as (total_amount_satang - down_payment_satang) stored,
  interest_satang bigint not null default 0 check (interest_satang >= 0),
  fee_satang bigint not null default 0 check (fee_satang >= 0),
  installment_count integer not null check (installment_count between 1 and 1200),
  frequency_unit text not null check (frequency_unit in ('day','month','year')),
  frequency_interval integer not null check (frequency_interval between 1 and 1200),
  first_due_date date not null,
  down_payment_date date,
  default_account_id bigint references bank_account(id),
  status text not null default 'active' check (status in ('active','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (down_payment_satang = 0 or down_payment_date is not null)
);
create index installment_plan_user_idx on installment_plan(user_id);
create table installment_due (
  id bigserial primary key,
  installment_plan_id bigint not null references installment_plan(id) on delete cascade,
  installment_no integer not null check (installment_no >= 0),
  due_date date not null,
  amount_satang bigint not null check (amount_satang > 0),
  explicit_status text not null default 'active' check (explicit_status in ('active','skipped')),
  created_at timestamptz not null default now(),
  unique (installment_plan_id, installment_no)
);
alter table monthly_plan_item add constraint monthly_plan_item_installment_due_fk foreign key (installment_due_id) references installment_due(id);
create unique index monthly_plan_item_installment_due_uniq on monthly_plan_item(installment_due_id) where installment_due_id is not null;
