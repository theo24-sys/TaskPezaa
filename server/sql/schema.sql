-- Users
create table if not exists users (
  id serial primary key,
  email text unique,
  phone text unique not null,
  password_hash text not null,
  avatar_url text,
  balance_kes integer not null default 0,
  failed_login_attempts integer not null default 0,
  locked_until timestamptz,
  blocked boolean not null default false,
  phone_verified_at timestamptz,
  referral_code text unique,
  created_at timestamptz not null default now()
);

-- Packages (10-day model)
create table if not exists packages (
  id serial primary key,
  name text not null,
  price_kes integer not null,
  tasks_per_day integer not null,
  task_type text not null check (task_type in ('basic','standard','premium','bonus')),
  duration_days integer not null default 10
);

-- Platform settings
create table if not exists settings (
  key text primary key,
  value jsonb not null
);
insert into settings(key, value) values
  ('withdrawal', jsonb_build_object('min_kes', 750, 'max_kes', 10000, 'fee_percent', 8)),
  ('commissions', jsonb_build_object(
      'tiers', jsonb_build_array(
        jsonb_build_object('min', 750, 'max', 2000, 'percent', 10),
        jsonb_build_object('min', 2001, 'max', 5000, 'percent', 8),
        jsonb_build_object('min', 5001, 'max', 10000, 'percent', 15)
      )
  )),
  ('mpesa', jsonb_build_object('till', '4567052')),
  ('withdrawalApprovalMode', jsonb_build_object('mode','manual')),
  ('referral', jsonb_build_object('first_purchase_percent', 10)),
  ('loyalty', jsonb_build_object('completion_percent', 5))
  on conflict (key) do nothing;

-- Purchases
create table if not exists purchases (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  package_id integer not null references packages(id) on delete restrict,
  start_date timestamptz not null,
  end_date timestamptz not null,
  is_active boolean not null default true,
  deposit_id integer,
  referral_awarded boolean not null default false
);
create index if not exists idx_purchases_end_date on purchases(end_date);

-- Task pool
create table if not exists tasks (
  id serial primary key,
  title text not null,
  description text not null default '',
  task_type text not null check (task_type in ('basic','standard','premium','bonus')),
  reward_kes integer not null default 10,
  completion_time_limit_sec integer not null default 300,
  active boolean not null default true,
  created_on date not null default (now() at time zone 'utc')::date
);

-- Daily assignments
create table if not exists task_assignments (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  task_id integer not null references tasks(id) on delete cascade,
  assigned_for_date date not null,
  assigned_at timestamptz not null default now(),
  unique(user_id, task_id, assigned_for_date)
);

-- Submissions
create table if not exists submissions (
  id serial primary key,
  assignment_id integer not null references task_assignments(id) on delete cascade,
  user_id integer not null references users(id) on delete cascade,
  task_id integer not null references tasks(id) on delete cascade,
  submitted_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  proof_url text
);

-- Task history (rewards)
create table if not exists task_history (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  task_id integer references tasks(id) on delete set null,
  reward_kes integer not null,
  credited_at timestamptz not null default now(),
  notes text
);

-- Financial ledger
create table if not exists ledger (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  type text not null check (type in ('deposit_credit','package_purchase','task_reward','withdrawal_request','adjustment','referral_bonus','loyalty_bonus')),
  amount_kes integer not null,
  balance_after integer not null,
  ref_id integer,
  notes text,
  created_at timestamptz not null default now()
);

-- Admin audit logs
create table if not exists admin_audit_logs (
  id serial primary key,
  action text not null,
  admin_ip text,
  target_user_id integer references users(id) on delete set null,
  payload jsonb,
  created_at timestamptz not null default now()
);

-- Withdrawals
create table if not exists withdrawals (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  amount_kes integer not null,
  fee_kes integer not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_at timestamptz not null,
  processed_at timestamptz,
  payout_ref text
);

-- Referrals
create table if not exists referrals (
  id serial primary key,
  referrer_user_id integer not null references users(id) on delete cascade,
  referred_user_id integer not null references users(id) on delete cascade,
  reward_kes integer not null default 0,
  rewarded boolean not null default false,
  created_at timestamptz not null default now(),
  unique (referred_user_id)
);

-- Deposits (manual M-Pesa)
create table if not exists deposits (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  mpesa_code text not null unique,
  amount_kes integer not null,
  remaining_kes integer,
  till_number text not null,
  proof_url text,
  status text not null default 'pending' check (status in ('pending','verified','used','rejected')),
  submitted_at timestamptz not null default now(),
  verified_at timestamptz
);
-- Safe alter
DO $$ BEGIN ALTER TABLE deposits ADD COLUMN remaining_kes integer; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
-- Backfill remaining_kes where null (to be handled in app on verify)

-- Verifications (OTP for phone)
create table if not exists verifications (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  phone text not null,
  code text not null,
  expires_at timestamptz not null,
  verified_at timestamptz
);

-- Safe alters for existing deployments
do $$ begin alter table users add column referral_code text unique; exception when duplicate_column then null; end $$;
do $$ begin alter table referrals add column rewarded boolean not null default false; exception when duplicate_column then null; end $$;
do $$ begin alter table purchases add column referral_awarded boolean not null default false; exception when duplicate_column then null; end $$;

-- Link purchases.deposit_id
do $$ begin
  alter table purchases
    add constraint purchases_deposit_fk
    foreign key (deposit_id) references deposits(id) on delete set null;
exception when duplicate_object then null; end $$;

-- Seed packages
insert into packages (name, price_kes, tasks_per_day, task_type, duration_days) values
 ('KES 100', 100, 2, 'basic', 10),
 ('KES 200', 200, 3, 'basic', 10),
 ('KES 300', 300, 3, 'standard', 10),
 ('KES 500', 500, 4, 'standard', 10),
 ('KES 1000', 1000, 4, 'premium', 10),
 ('KES 1500', 1500, 5, 'premium', 10),
 ('KES 2000', 2000, 5, 'premium', 10),
 ('KES 3000', 3000, 6, 'premium', 10)
 on conflict do nothing;
