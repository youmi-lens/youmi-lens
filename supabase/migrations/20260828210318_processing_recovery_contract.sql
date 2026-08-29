-- Failed post-recording processing recovery.
--
-- 1. A service-role-only lease row provides one durable worker claim per
--    recording across Railway instances/devices. A crashed worker leaves a
--    time-bounded row that a later request can atomically reclaim.
-- 2. A nullable idempotency key lets new processing usage writes be exactly
--    once without rewriting the historical append-only ledger. Existing rows
--    remain valid and are also detected by recording_id/action_type at runtime.

create table if not exists public.recording_processing_leases (
  recording_id uuid primary key references public.recordings(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  lease_token uuid not null,
  lease_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists recording_processing_leases_expiry
  on public.recording_processing_leases (lease_expires_at);

alter table public.recording_processing_leases enable row level security;

-- This table is backend coordination state, not user-facing Data API state.
-- The Railway service role bypasses RLS; authenticated/anonymous clients get
-- no policy and no table privilege.
revoke all on table public.recording_processing_leases from anon, authenticated;
grant select, insert, update, delete on table public.recording_processing_leases to service_role;

alter table public.beta_usage
  add column if not exists idempotency_key text;

create unique index if not exists beta_usage_idempotency_key_unique
  on public.beta_usage (idempotency_key);

comment on table public.recording_processing_leases is
  'Service-role-only, expiring worker claims for post-recording processing.';
comment on column public.beta_usage.idempotency_key is
  'Optional stable key for exactly-once usage events; historical rows remain null.';
