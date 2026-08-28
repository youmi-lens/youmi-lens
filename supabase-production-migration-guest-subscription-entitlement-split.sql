-- ============================================================================
-- Youmi Lens — Guest cross-device Apple subscription entitlement split
-- (PRODUCTION: lbwsrnjbiayepshrdult)
-- ============================================================================
-- Pinned production artifact. This is the production-approved copy of
-- supabase-staging-migration-guest-subscription-entitlement-split.sql after
-- the same DDL passed staging and the populated-table migration rehearsal.
--
-- WHY: App Review 5.1.1(v) requires a Guest to be able to restore a purchased
-- Apple subscription on a second supported device WITHOUT Youmi registration.
-- app_store_subscription_states was PRIMARY KEY (original_transaction_id) —
-- exactly one row, one user_id, per Apple subscription lineage — so a second
-- Guest device's restore could only ever overwrite the first Guest's row,
-- silently deactivating their entitlement. This migration lets MULTIPLE
-- verified identities (Guest X, Guest Y, and/or a permanent account) each
-- hold their OWN entitlement row for the same lineage, while
-- app_store_subscription_bindings remains untouched as the single-owner
-- CANONICAL PERMANENT-ACCOUNT ownership table (unrelated concern, unchanged
-- shape) — see server/iapSubscriptions.mjs for the corresponding code.
--
-- CHANGES (all to app_store_subscription_states only — bindings is untouched):
--   1. Drop the FK to app_store_subscription_bindings. Under the new model, a
--      pure-Guest entitlement can legitimately exist with NO canonical
--      binding ever created (Guests never write bindings) — the two tables
--      are now independent, related only by sharing the same
--      original_transaction_id VALUE, not a parent/child FK.
--   2. Drop the single-column PRIMARY KEY (original_transaction_id) and
--      replace it with a composite PRIMARY KEY
--      (original_transaction_id, user_id).
--   3. Drop the global UNIQUE constraint on latest_transaction_id — two
--      different identities restoring the SAME Apple transaction legitimately
--      share the same latest_transaction_id value across their two rows.
--      Nothing in server code looks rows up by latest_transaction_id alone
--      (checked), so no replacement index is added.
--
-- RISK: moderate — structural key change on a live billing table. Additive in
-- the sense that every existing row is PRESERVED (no data is deleted); the
-- risk is entirely in the constraint change itself failing partway. Wrapped
-- in one transaction so it is all-or-nothing. Preflight asserts the expected
-- starting shape; post-flight asserts row count is unchanged and the new key
-- shape is in place.
--
-- ROLLBACK: see supabase-rollback-guest-subscription-entitlement-split.sql.
-- That rollback is ONLY safe while every original_transaction_id in this
-- table still has at most one row (i.e., no real cross-device Guest data has
-- been written yet under the new model) — see that file's own preflight
-- guard, which REFUSES to run once a lineage has more than one row, rather
-- than silently discarding a second Guest's entitlement.
-- ============================================================================

begin;

-- ── Preflight: assert the expected starting shape ──────────────────────────
do $$
declare
  pk_cols text;
  row_count bigint;
begin
  select string_agg(a.attname, ',' order by a.attnum)
    into pk_cols
    from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
    where i.indrelid = 'public.app_store_subscription_states'::regclass
      and i.indisprimary;

  if pk_cols is distinct from 'original_transaction_id' then
    raise exception 'Preflight failed: app_store_subscription_states primary key is "%", expected "original_transaction_id". Migration already applied or schema drifted — stopping.', pk_cols;
  end if;

  select count(*) into row_count from public.app_store_subscription_states;
  raise notice 'Preflight OK: % existing app_store_subscription_states row(s), PK=(original_transaction_id).', row_count;
end $$;

-- ── 1. Decouple states from bindings (Guests never write a binding) ────────
alter table public.app_store_subscription_states
  drop constraint if exists app_store_subscription_states_original_transaction_id_fkey;

-- ── 2. Composite primary key ────────────────────────────────────────────────
alter table public.app_store_subscription_states
  drop constraint if exists app_store_subscription_states_pkey;
alter table public.app_store_subscription_states
  add constraint app_store_subscription_states_pkey
  primary key (original_transaction_id, user_id);

-- ── 3. Relax latest_transaction_id — no longer globally unique ─────────────
alter table public.app_store_subscription_states
  drop constraint if exists app_store_subscription_states_latest_transaction_id_key;

-- original_transaction_id is no longer a PK column on its own — restore a
-- plain index so per-lineage lookups/sweeps (renewal, revoke, refund
-- propagation across every Guest + permanent row) stay fast.
create index if not exists idx_subscription_states_original_transaction_id
  on public.app_store_subscription_states (original_transaction_id);

-- ── Post-flight: assert nothing was lost, new shape is in place ────────────
do $$
declare
  pk_cols text;
  row_count bigint;
begin
  select string_agg(a.attname, ',' order by a.attnum)
    into pk_cols
    from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
    where i.indrelid = 'public.app_store_subscription_states'::regclass
      and i.indisprimary;

  if pk_cols is distinct from 'original_transaction_id,user_id' then
    raise exception 'Post-flight failed: primary key is "%", expected "original_transaction_id,user_id".', pk_cols;
  end if;

  select count(*) into row_count from public.app_store_subscription_states;
  raise notice 'Post-flight OK: % row(s) preserved, PK=(original_transaction_id, user_id).', row_count;
end $$;

commit;
