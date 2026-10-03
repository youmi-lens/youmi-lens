-- One Youmi UUID can own several distinct Apple originalTransactionId chains.
-- Preserve the canonical-chain PK and all rows; replace only token uniqueness.
-- All DDL is in one atomic DO statement. Never use CASCADE or CONCURRENTLY.
do $migration$
declare
  legacy oid=to_regclass('public.idx_subscription_binding_app_account_token');
  replacement oid;
  expected_predicate text=$predicate$((app_account_token IS NOT NULL) AND (owner_state = 'active'::text))$predicate$;
begin
  perform set_config('lock_timeout','5s',true);
  if not exists(select 1 from pg_index i where i.indrelid='public.app_store_subscription_bindings'::regclass
      and i.indisprimary and i.indisunique and i.indisvalid and i.indnkeyatts=1
      and pg_get_indexdef(i.indexrelid,1,true)='original_transaction_id') then
    raise exception 'Canonical original_transaction_id primary key missing or changed';
  end if;
  if legacy is not null and not exists(select 1 from pg_index i where i.indexrelid=legacy
      and i.indrelid='public.app_store_subscription_bindings'::regclass
      and i.indisunique and not i.indisprimary and i.indisvalid and i.indnkeyatts=2 and i.indnatts=2
      and pg_get_indexdef(i.indexrelid,1,true)='app_account_token'
      and pg_get_indexdef(i.indexrelid,2,true)='environment'
      and pg_get_expr(i.indpred,i.indrelid)=expected_predicate
      and not exists(select 1 from pg_constraint c where c.conindid=legacy)) then
    raise exception 'Legacy token index differs from the reviewed standalone unique index';
  end if;
  create index if not exists idx_subscription_binding_token_lookup
    on public.app_store_subscription_bindings using btree (app_account_token,environment)
    where app_account_token is not null and owner_state='active';
  replacement=to_regclass('public.idx_subscription_binding_token_lookup');
  if not exists(select 1 from pg_index i join pg_class c on c.oid=i.indexrelid
      join pg_am a on a.oid=c.relam where i.indexrelid=replacement
      and i.indrelid='public.app_store_subscription_bindings'::regclass
      and not i.indisunique and i.indisvalid and i.indnkeyatts=2 and i.indnatts=2
      and pg_get_indexdef(i.indexrelid,1,true)='app_account_token'
      and pg_get_indexdef(i.indexrelid,2,true)='environment'
      and pg_get_expr(i.indpred,i.indrelid)=expected_predicate and a.amname='btree') then
    raise exception 'Replacement token lookup index differs from the reviewed definition';
  end if;
  drop index if exists public.idx_subscription_binding_app_account_token restrict;
end;
$migration$;
