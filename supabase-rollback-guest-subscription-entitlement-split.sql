-- ============================================================================
-- Rollback: Guest cross-device Apple subscription entitlement split
-- (STAGING ONLY: keozbnzainrcuiwhmjae)
-- ============================================================================
-- Pairs with supabase-staging-migration-guest-subscription-entitlement-split.sql.
--
-- HONESTY ABOUT LOSSINESS: this rollback is only lossless while every
-- original_transaction_id in app_store_subscription_states still has AT MOST
-- ONE row. That was guaranteed the instant after the forward migration ran
-- (every existing row was single-owner). It stops being true the moment ANY
-- lineage picks up a second row from a real second-Guest-device restore under
-- the new model — collapsing back to a single-row-per-lineage PRIMARY KEY at
-- that point would silently DELETE every non-kept row's entitlement data,
-- which is exactly the bug this migration exists to fix. This script REFUSES
-- to run once that has happened, rather than silently discarding data.
-- ============================================================================

begin;

-- ── Preflight: refuse if any lineage now has more than one row ─────────────
do $$
declare
  multi_row_lineages bigint;
begin
  select count(*) into multi_row_lineages
  from (
    select original_transaction_id
    from public.app_store_subscription_states
    group by original_transaction_id
    having count(*) > 1
  ) t;

  if multi_row_lineages > 0 then
    raise exception 'Refusing rollback: % subscription lineage(s) now have more than one identity holding entitlement. Collapsing to a single-row-per-lineage primary key would silently delete real Guest entitlement data. Resolve or explicitly accept that loss before rolling back.', multi_row_lineages;
  end if;
end $$;

-- ── Restore original_transaction_id-only primary key ───────────────────────
alter table public.app_store_subscription_states
  drop constraint if exists app_store_subscription_states_pkey;
alter table public.app_store_subscription_states
  add constraint app_store_subscription_states_pkey
  primary key (original_transaction_id);

drop index if exists public.idx_subscription_states_original_transaction_id;

-- ── Restore latest_transaction_id uniqueness ────────────────────────────────
alter table public.app_store_subscription_states
  add constraint app_store_subscription_states_latest_transaction_id_key
  unique (latest_transaction_id);

-- ── Restore FK to app_store_subscription_bindings ───────────────────────────
-- Only re-addable if every remaining row still has a matching binding — true
-- immediately post-forward-migration (every row that existed then had one),
-- but if this rollback runs after new pure-Guest states rows were created
-- with NO binding (the new, intended behavior), this FK add will fail on
-- those rows. That failure is correct: it means real data now depends on the
-- new model and this rollback path is no longer applicable without a manual
-- data decision.
alter table public.app_store_subscription_states
  add constraint app_store_subscription_states_original_transaction_id_fkey
  foreign key (original_transaction_id)
  references public.app_store_subscription_bindings (original_transaction_id)
  on delete restrict;

commit;
