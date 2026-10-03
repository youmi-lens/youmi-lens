create or replace function billing_private.state_precedes(p_old jsonb,p_new jsonb) returns boolean
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
  if old_rank>=40 and new_rank<old_rank and not coalesce((
    (p_new->>'apple_event_at')::timestamptz>(p_old->>'apple_event_at')::timestamptz and
    ((p_new->>'last_notification_type'='REFUND_REVERSED' and old_rank>=50 and p_new->>'revocation_at' is null) or
     (p_old->>'status'='expired' and (p_new->>'status'='grace_period' or p_new->>'source'='app_store_server_api') and
      (p_new->>'expires_at')::timestamptz>(p_old->>'expires_at')::timestamptz))
  ),false) then return false; end if;
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

-- Delivery is independent of sales admission after REAL Apple verification.
-- No catalog, binding, state or tester policy data is rewritten by this migration.
create or replace function public.persist_verified_subscription(p_user_id uuid,p_transaction jsonb,p_options jsonb default '{}'::jsonb)
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
   -- A verified Production notification can deliver a first purchase using its signed token.
   -- Test environments still require an explicit existing test-chain policy.
   if v_notification and (v_env<>'Production' or v_caller_anonymous) then
     raise exception 'subscription_owner_conflict' using errcode='P0001';
   end if;
   if v_token<>p_user_id then raise exception 'subscription_token_mismatch' using errcode='P0001'; end if;
   -- Purchase admission controls STARTING StoreKit, never delivery after Apple succeeds.
   -- A real verified receipt, matching signed token and canonical ownership are authoritative.
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
   when p_options->>'appleStatus'='5' then 'revoked'
   when p_options->>'appleStatus'='2' then 'expired'
   when p_options->>'appleStatus'='3' then 'billing_retry'
   when p_options->>'notificationType'='REFUND' then 'refunded'
   when p_options->>'notificationType'='REVOKE' or coalesce((p_transaction->>'revoked')::boolean,false) then 'revoked'
   when p_options->>'notificationType' in ('EXPIRED','GRACE_PERIOD_EXPIRED') then 'expired'
   when (p_options->>'subtype'='GRACE_PERIOD' or p_options->>'appleStatus'='4') and (v_renewal->>'gracePeriodExpiresDate')::timestamptz>now() then 'grace_period'
   when coalesce((v_renewal->>'isInBillingRetryPeriod')::boolean,false) or p_options->>'subtype'='BILLING_RETRY' or p_options->>'notificationType'='DID_FAIL_TO_RENEW' then 'billing_retry'
   when v_expiry<=now() then 'expired'
   when v_purchase>now() then 'verification_pending'
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
