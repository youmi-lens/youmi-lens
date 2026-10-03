-- Data-preserving replacement: a Youmi UUID may own several distinct Apple chains.
-- The original_transaction_id primary key remains the one-owner invariant.
create index if not exists idx_subscription_binding_token_lookup
  on public.app_store_subscription_bindings(app_account_token,environment)
  where app_account_token is not null and owner_state='active';
drop index if exists public.idx_subscription_binding_app_account_token;
