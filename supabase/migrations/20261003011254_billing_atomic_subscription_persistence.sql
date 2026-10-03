-- Refuse ambiguous legacy data. This migration never repairs ownership by inference.
do $$ begin
 if exists(select 1 from public.app_store_subscription_states s left join public.app_store_subscription_bindings b
   on b.original_transaction_id=s.original_transaction_id where b.original_transaction_id is null or
   (s.status in ('active','grace_period','cancelled_but_active_until_expiry') and s.expires_at>now() and
    (b.user_id is distinct from s.user_id or b.environment is distinct from s.environment or b.owner_state<>'active'))) then
   raise exception 'Billing migration requires review of unbound/noncanonical state';
 end if;
end $$;
-- Additive: no existing billing binding, state, or catalog row is rewritten.
-- Existing Sandbox chains are explicitly grandfathered; new chains fail closed.
create schema if not exists billing_private;
revoke all on schema billing_private from public, anon, authenticated;
grant usage on schema billing_private to service_role;

create table public.subscription_test_chain_policy (
  user_id uuid not null references auth.users(id) on delete cascade,
  original_transaction_id text not null,
  environment text not null check (environment in ('Sandbox','Xcode','LocalTesting')),
  reason text not null,
  created_at timestamptz not null default now(),
  primary key(user_id, original_transaction_id, environment)
);
alter table public.subscription_test_chain_policy enable row level security;
revoke all on public.subscription_test_chain_policy from anon, authenticated;
grant select,insert,update,delete on public.subscription_test_chain_policy to service_role;
insert into public.subscription_test_chain_policy(user_id,original_transaction_id,environment,reason)
select s.user_id,s.original_transaction_id,s.environment,'Existing canonical tester chain preserved by billing migration'
from public.app_store_subscription_states s join public.app_store_subscription_bindings b
  on b.original_transaction_id=s.original_transaction_id and b.user_id=s.user_id
  and b.environment=s.environment and b.owner_state='active'
where s.environment in ('Sandbox','Xcode','LocalTesting')
on conflict do nothing;

-- Generic purchase admission, never an incident/account allowlist. A verified
-- request admitted while sales are open remains deliverable if sales
-- close while Apple's sheet or the network is in flight. One admission/chain.
create table public.subscription_purchase_authorizations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id text not null references public.billing_products(product_id),
  original_transaction_id text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '10 minutes'
);
alter table public.subscription_purchase_authorizations enable row level security;
revoke all on public.subscription_purchase_authorizations from anon,authenticated;
grant select,insert,update,delete on public.subscription_purchase_authorizations to service_role;

alter table public.app_store_subscription_states add column apple_event_at timestamptz;

-- An internal, service-only helper needs auth.users access and locks the Auth
-- row so anonymous promotion cannot race account conversion/deletion.
create function billing_private.lock_auth_identity(p_user uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_anonymous boolean;
begin
  select is_anonymous into v_anonymous from auth.users where id=p_user for update;
  if not found then raise exception 'subscription_account_deleted' using errcode='P0001'; end if;
  return coalesce(v_anonymous,false);
end;
$$;
revoke all on function billing_private.lock_auth_identity(uuid) from public,anon,authenticated;
grant execute on function billing_private.lock_auth_identity(uuid) to service_role;

create function public.authorize_subscription_purchase(p_user_id uuid,p_product_id text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare p public.billing_products%rowtype; admission public.subscription_purchase_authorizations%rowtype;
begin
  perform billing_private.lock_auth_identity(p_user_id);
  select * into p from public.billing_products where product_id=p_product_id for share;
  if p.kind is distinct from 'auto_renewable' or p.product_id not in ('com.aydenz.youmilensipad.student.monthly','com.aydenz.youmilensipad.student.annual') or p.is_purchasable is distinct from true or
     (p.sales_end_at is not null and p.sales_end_at<=now()) then
    raise exception 'subscription_sales_closed' using errcode='P0001';
  end if;
  insert into public.subscription_purchase_authorizations(user_id,product_id) values(p_user_id,p_product_id)
    returning * into admission;
  return jsonb_build_object('authorizationId',admission.id,'expiresAt',admission.expires_at,'productId',p_product_id);
end;
$$;
revoke all on function public.authorize_subscription_purchase(uuid,text) from public,anon,authenticated;
grant execute on function public.authorize_subscription_purchase(uuid,text) to service_role;

create function billing_private.state_precedes(p_old jsonb,p_new jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare os timestamptz; ns timestamptz; oe timestamptz; ne timestamptz; old_rank int; new_rank int;
begin
  if p_old is null then return true; end if;
  os=(p_old->>'purchased_at')::timestamptz; ns=(p_new->>'purchased_at')::timestamptz;
  if ns is null or os is null then return false; end if;
  if ns>os then return true; end if;
  if ns<os then return false; end if;
  old_rank=case p_old->>'status' when 'refunded' then 60 when 'revoked' then 50 when 'expired' then 40 when 'billing_retry' then 30 when 'cancelled_but_active_until_expiry' then 20 when 'grace_period' then 20 when 'active' then 10 else 0 end;
  new_rank=case p_new->>'status' when 'refunded' then 60 when 'revoked' then 50 when 'expired' then 40 when 'billing_retry' then 30 when 'cancelled_but_active_until_expiry' then 20 when 'grace_period' then 20 when 'active' then 10 else 0 end;
  -- Terminal decisions for the same Apple period never resurrect access.
  if old_rank>=40 and new_rank<old_rank then return false; end if;
  oe=(p_old->>'apple_event_at')::timestamptz; ne=(p_new->>'apple_event_at')::timestamptz;
  if oe is not null and (ne is null or ne<oe) then return false; end if;
  if oe is not null and ne=oe and new_rank<old_rank then return false; end if;
  if oe is null and ne is null and new_rank<old_rank then return false; end if;
  if new_rank>=40 then return true; end if;
  return (p_new->>'expires_at')::timestamptz >= (p_old->>'expires_at')::timestamptz;
end;
$$;
revoke all on function billing_private.state_precedes(jsonb,jsonb) from public,anon,authenticated;
grant execute on function billing_private.state_precedes(jsonb,jsonb) to service_role;

-- Defense in depth for ALL state writers, including a future accidental direct
-- upsert. The binding row lock serializes against ownership promotion/deletion.
create function billing_private.guard_subscription_state() returns trigger
language plpgsql security invoker set search_path='' as $$
declare b public.app_store_subscription_bindings%rowtype;
begin
  select * into b from public.app_store_subscription_bindings
    where original_transaction_id=new.original_transaction_id for update;
  if not found or b.owner_state<>'active' or b.user_id is distinct from new.user_id
    or b.environment is distinct from new.environment then
    raise exception 'subscription_owner_conflict' using errcode='P0001';
  end if;
  if tg_op='UPDATE' then
    if old.original_transaction_id<>new.original_transaction_id or old.user_id<>new.user_id then
      raise exception 'subscription_owner_conflict' using errcode='P0001';
    end if;
    if not billing_private.state_precedes(to_jsonb(old),to_jsonb(new)) then return null; end if;
  end if;
  return new;
end;
$$;
revoke all on function billing_private.guard_subscription_state() from public,anon,authenticated;
grant execute on function billing_private.guard_subscription_state() to service_role;
create trigger subscription_state_authorized_write before insert or update on public.app_store_subscription_states
for each row execute function billing_private.guard_subscription_state();

-- Preserve a lineage tombstone BEFORE Auth's FK sets the owner to NULL.
-- No transfer/recovery is automatic after deletion. Auth deletion owns this
-- trigger; the private definer needs narrowly scoped billing-table access.
create function billing_private.tombstone_subscription_owner() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  update public.app_store_subscription_bindings set owner_state='account_deleted',account_deleted_at=now()
    where user_id=old.id and owner_state='active';
  return old;
end;
$$;
revoke all on function billing_private.tombstone_subscription_owner() from public,anon,authenticated;
create trigger billing_subscription_owner_deleted before delete on auth.users
for each row execute function billing_private.tombstone_subscription_owner();

-- Public RPC is INVOKER, executable ONLY by service_role. Caller UUID is supplied
-- by requireUser after Supabase Auth validation; Apple fields are verified on
-- the backend. No client or signed-in user can invoke this function directly.
create function public.persist_verified_subscription(p_user_id uuid,p_transaction jsonb,p_options jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 b public.app_store_subscription_bindings%rowtype;
 old_state public.app_store_subscription_states%rowtype;
 new_state public.app_store_subscription_states%rowtype;
 v_original text=p_transaction->>'originalTransactionId';
 v_env text=p_transaction->>'environment';
 v_token uuid=(p_transaction->>'appAccountToken')::uuid;
 v_caller_anonymous boolean;
 v_owner_anonymous boolean;
 v_notification boolean=coalesce(p_options->>'source','storekit_jws')='notification_v2';
 v_renewal jsonb=p_options->'renewal';
 v_purchase timestamptz=(p_transaction->>'purchaseDate')::timestamptz;
 v_expiry timestamptz=(p_transaction->>'appleExpiresDate')::timestamptz;
 v_status text;
 v_event timestamptz=coalesce((p_options->>'appleEventAt')::timestamptz,(p_transaction->>'appleSignedAt')::timestamptz,(p_transaction->>'revokedAt')::timestamptz,v_purchase);
 v_auto boolean;
 v_stale boolean=false;
 v_product public.billing_products%rowtype;
 v_admission public.subscription_purchase_authorizations%rowtype;
 v_admitted boolean=false;
begin
 if v_original is null or v_token is null or v_purchase is null or v_expiry is null then
   raise exception 'subscription_invalid_identity' using errcode='P0001';
 end if;
 -- Lock absent as well as existing chains. All RPC claims use the same key.
 perform pg_advisory_xact_lock(hashtextextended('youmi_subscription:'||v_original,0));
 v_caller_anonymous=billing_private.lock_auth_identity(p_user_id);
 select * into b from public.app_store_subscription_bindings where original_transaction_id=v_original for update;
 if b.original_transaction_id is not null and b.owner_state<>'active' then
   raise exception 'subscription_account_deleted' using errcode='P0001';
 end if;
 if v_env<>'Production' and not exists(select 1 from public.subscription_test_chain_policy
   where user_id=p_user_id and original_transaction_id=v_original and environment=v_env) then
   raise exception 'subscription_environment_not_allowed' using errcode='P0001';
 end if;
 select * into v_product from public.billing_products where product_id=p_transaction->>'productId' for share;
 if v_product.kind is distinct from 'auto_renewable' or v_product.product_id not in
   ('com.aydenz.youmilensipad.student.monthly','com.aydenz.youmilensipad.student.annual') then
   raise exception 'subscription_unknown_product' using errcode='P0001';
 end if;
 if b.original_transaction_id is null then
   if v_notification then raise exception 'subscription_owner_conflict' using errcode='P0001'; end if;
   if v_token<>p_user_id then raise exception 'subscription_token_mismatch' using errcode='P0001'; end if;
   if p_options->>'purchaseAuthorizationId' is not null then
     select * into v_admission from public.subscription_purchase_authorizations
       where id=(p_options->>'purchaseAuthorizationId')::uuid for update;
     -- expires_at bounds starting the Apple request, not eventual delivery:
     -- Ask to Buy/pending and offline verification can settle much later.
     -- This one-chain approval never bypasses token or canonical ownership.
     v_admitted=v_admission.user_id=p_user_id and v_admission.product_id=p_transaction->>'productId'
       and v_purchase>=v_admission.created_at-interval '30 seconds'
       and (v_admission.original_transaction_id is null or v_admission.original_transaction_id=v_original);
     if not coalesce(v_admitted,false) then
       raise exception 'subscription_invalid_authorization' using errcode='P0001';
     end if;
     update public.subscription_purchase_authorizations set original_transaction_id=v_original where id=v_admission.id;
   end if;
   if v_env='Production' and not coalesce(v_admitted,false) and (v_product.is_purchasable is distinct from true or
     (v_product.sales_end_at is not null and v_product.sales_end_at<=now())) then
     raise exception 'subscription_sales_closed' using errcode='P0001';
   end if;
   insert into public.app_store_subscription_bindings(original_transaction_id,user_id,app_account_token,environment,owner_state)
     values(v_original,p_user_id,v_token,v_env,'active') returning * into b;
 elsif b.environment<>v_env then
   raise exception 'subscription_environment_not_allowed' using errcode='P0001';
 elsif b.user_id<>p_user_id then
   v_owner_anonymous=billing_private.lock_auth_identity(b.user_id);
   if v_notification or v_caller_anonymous or not v_owner_anonymous then
     raise exception 'subscription_owner_conflict' using errcode='P0001';
   end if;
   if v_token<>p_user_id then raise exception 'subscription_token_mismatch' using errcode='P0001'; end if;
   -- Retire the old guest's state inside this same operation, BEFORE changing
   -- the canonical binding. No owner transfer occurs for permanent accounts.
   update public.app_store_subscription_states set status='expired',apple_event_at=greatest(apple_event_at,v_event)
     where original_transaction_id=v_original and user_id=b.user_id;
   update public.app_store_subscription_bindings set user_id=p_user_id,app_account_token=v_token
     where original_transaction_id=v_original and user_id=b.user_id and owner_state='active' returning * into b;
   if not found then raise exception 'subscription_owner_conflict' using errcode='P0001'; end if;
 end if;
 select * into old_state from public.app_store_subscription_states
   where original_transaction_id=v_original and user_id=p_user_id for update;
 v_auto=coalesce((v_renewal->>'autoRenewStatus')::boolean,old_state.auto_renew_status);
 v_status=case
   when p_options->>'notificationType'='REFUND' then 'refunded'
   when p_options->>'notificationType'='REVOKE' or coalesce((p_transaction->>'revoked')::boolean,false) then 'revoked'
   when p_options->>'notificationType' in ('EXPIRED','GRACE_PERIOD_EXPIRED') then 'expired'
   when p_options->>'subtype'='GRACE_PERIOD' and (v_renewal->>'gracePeriodExpiresDate')::timestamptz>now() then 'grace_period'
   when coalesce((v_renewal->>'isInBillingRetryPeriod')::boolean,false) or p_options->>'subtype'='BILLING_RETRY' or p_options->>'notificationType'='DID_FAIL_TO_RENEW' then 'billing_retry'
   when v_expiry<=now() then 'expired'
   when v_auto=false then 'cancelled_but_active_until_expiry' else 'active' end;
 if v_status='grace_period' then v_expiry=(v_renewal->>'gracePeriodExpiresDate')::timestamptz; end if;
 new_state.original_transaction_id=v_original; new_state.user_id=p_user_id;
 new_state.product_id=p_transaction->>'productId'; new_state.latest_transaction_id=p_transaction->>'transactionId';
 new_state.subscription_group_id=p_transaction->>'subscriptionGroupId'; new_state.environment=v_env;
 new_state.ownership_type=p_transaction->>'ownershipType'; new_state.app_account_token=v_token;
 new_state.purchased_at=v_purchase; new_state.expires_at=v_expiry; new_state.auto_renew_status=v_auto;
 new_state.status=v_status; new_state.revocation_at=(p_transaction->>'revokedAt')::timestamptz;
 new_state.source=coalesce(p_options->>'source','storekit_jws'); new_state.last_notification_type=p_options->>'notificationType';
 new_state.last_verified_at=now(); new_state.apple_event_at=v_event;
 if old_state.original_transaction_id is not null and not billing_private.state_precedes(to_jsonb(old_state),to_jsonb(new_state)) then
   new_state=old_state; v_stale=true;
 else
   insert into public.app_store_subscription_states(original_transaction_id,user_id,product_id,latest_transaction_id,
     subscription_group_id,environment,ownership_type,app_account_token,purchased_at,expires_at,auto_renew_status,status,
     revocation_at,source,last_notification_type,last_verified_at,apple_event_at)
   values(new_state.original_transaction_id,new_state.user_id,new_state.product_id,new_state.latest_transaction_id,
     new_state.subscription_group_id,new_state.environment,new_state.ownership_type,new_state.app_account_token,
     new_state.purchased_at,new_state.expires_at,new_state.auto_renew_status,new_state.status,new_state.revocation_at,
     new_state.source,new_state.last_notification_type,new_state.last_verified_at,new_state.apple_event_at)
   on conflict(original_transaction_id,user_id) do update set
     product_id=excluded.product_id,latest_transaction_id=excluded.latest_transaction_id,subscription_group_id=excluded.subscription_group_id,
     environment=excluded.environment,ownership_type=excluded.ownership_type,app_account_token=excluded.app_account_token,
     purchased_at=excluded.purchased_at,expires_at=excluded.expires_at,auto_renew_status=excluded.auto_renew_status,status=excluded.status,
     revocation_at=excluded.revocation_at,source=excluded.source,last_notification_type=excluded.last_notification_type,
     last_verified_at=excluded.last_verified_at,apple_event_at=excluded.apple_event_at
   returning * into new_state;
 end if;
 return to_jsonb(new_state)||jsonb_build_object('stale',v_stale,'active',
   new_state.status in ('active','grace_period','cancelled_but_active_until_expiry') and new_state.expires_at>now());
end;
$$;
revoke all on function public.persist_verified_subscription(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.persist_verified_subscription(uuid,jsonb,jsonb) to service_role;
notify pgrst,'reload schema';
