-- App Store offer-code redemptions (offerType 3). Adds public.app_store_offer_redemptions and REPLACES
-- public.persist_verified_subscription (same signature, security invoker, search_path='', service_role-only grants).
-- Difference from 20261004021500:
--  * Offer codes redeemed outside the app arrive without appAccountToken. An interactive (non-notification)
--    verify/restore by a signed-in PERMANENT account may bind such a chain when it has NO existing binding.
--  * A token-less transaction for a chain bound to ANOTHER user is always subscription_owner_conflict.
--  * A token-less transaction for the caller's own chain is accepted only for offer-code chains (later renewals
--    after the offer period carry no offerType and, until Apple applies Set App Account Token, no token).
--  * Guest promotion now requires a NON-NULL matching token (NULL<>uuid previously evaluated to NULL, not true).
--  * Every persisted offer-code transaction is recorded in app_store_offer_redemptions for attribution.
-- Token-less transactions that are not offer codes are still rejected (subscription_token_missing).

create table if not exists public.app_store_offer_redemptions(
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  original_transaction_id text not null,
  transaction_id text not null unique,
  product_id text not null,
  offer_identifier text,
  offer_type integer not null,
  environment text not null check (environment in ('Sandbox','Production','Xcode','LocalTesting')),
  redeemed_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_offer_redemptions_user on public.app_store_offer_redemptions(user_id);
create index if not exists idx_offer_redemptions_chain on public.app_store_offer_redemptions(original_transaction_id,user_id);
create index if not exists idx_offer_redemptions_offer on public.app_store_offer_redemptions(offer_identifier,redeemed_at);

alter table public.app_store_offer_redemptions enable row level security;
revoke all on table public.app_store_offer_redemptions from public,anon,authenticated;
grant select on table public.app_store_offer_redemptions to authenticated;
grant all on table public.app_store_offer_redemptions to service_role;
drop policy if exists offer_redemptions_select_own on public.app_store_offer_redemptions;
create policy offer_redemptions_select_own on public.app_store_offer_redemptions
  for select to authenticated using (user_id = (select auth.uid()));

create or replace function public.persist_verified_subscription(p_user_id uuid,p_transaction jsonb,p_options jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 b public.app_store_subscription_bindings%rowtype;
 old_state public.app_store_subscription_states%rowtype;
 new_state public.app_store_subscription_states%rowtype;
 v_original text=p_transaction->>'originalTransactionId';
 v_env text=p_transaction->>'environment';
 v_token uuid=(p_transaction->>'appAccountToken')::uuid;
 v_offer_code boolean=coalesce(p_transaction->>'offerType','')='3';
 v_offer_bound boolean=false;
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
 if v_original is null or v_purchase is null or v_expiry is null then
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
   if v_token is null then
     -- Only an unbound offer-code chain presented by the signed-in caller's own verify/restore may bind
     -- without a signed token. Notifications have no caller, so they can never bootstrap a token-less chain.
     if not v_offer_code or v_notification then
       raise exception 'subscription_token_missing' using errcode='P0001';
     end if;
     -- A guest binding could never be promoted (promotion needs a matching signed token), stranding the purchase.
     if v_caller_anonymous then raise exception 'subscription_offer_requires_account' using errcode='P0001'; end if;
     v_offer_bound=true;
   elsif v_token<>p_user_id then raise exception 'subscription_token_mismatch' using errcode='P0001';
   end if;
   -- Purchase admission controls STARTING StoreKit, never delivery after Apple succeeds.
   -- A real verified receipt, matching signed token (or first offer-code claim) and canonical ownership are authoritative.
   -- An offer-code binding records the caller as the token the server then asks Apple to set on the chain.
   insert into public.app_store_subscription_bindings(original_transaction_id,user_id,app_account_token,environment,owner_state)
     values(v_original,p_user_id,coalesce(v_token,p_user_id),v_env,'active') returning * into b;
 elsif b.environment<>v_env then
   raise exception 'subscription_environment_not_allowed' using errcode='P0001';
 elsif b.user_id<>p_user_id then
   if v_token is null then raise exception 'subscription_owner_conflict' using errcode='P0001'; end if;
   v_owner_anonymous=billing_private.lock_auth_identity(b.user_id);
   if v_notification or v_caller_anonymous or not v_owner_anonymous then
     raise exception 'subscription_owner_conflict' using errcode='P0001';
   end if;
   if v_token is distinct from p_user_id then raise exception 'subscription_token_mismatch' using errcode='P0001'; end if;
   -- Retire the old guest's state inside this same operation, BEFORE changing
   -- the canonical binding. No owner transfer occurs for permanent accounts.
   update public.app_store_subscription_states set status='expired',apple_event_at=greatest(apple_event_at,v_event)
     where original_transaction_id=v_original and user_id=b.user_id;
   update public.app_store_subscription_bindings set user_id=p_user_id,app_account_token=v_token
     where original_transaction_id=v_original and user_id=b.user_id and owner_state='active' returning * into b;
   if not found then raise exception 'subscription_owner_conflict' using errcode='P0001'; end if;
 elsif v_token is null and not v_offer_code and not exists(select 1 from public.app_store_offer_redemptions
   where original_transaction_id=v_original and user_id=p_user_id) then
   -- The caller's own chain, but token-less evidence is only accepted for chains that began with an offer code.
   raise exception 'subscription_token_missing' using errcode='P0001';
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
   -- A legitimate Apple-signed renewal may be delivered before its period's purchaseDate (Apple renews ahead of
   -- expiry). Access must never be suspended for that: only an implausibly far-future date (anomaly guard) is held.
   when v_purchase>now()+interval '48 hours' then 'verification_pending'
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
 -- Ownership is settled above, so only the canonical owner's offer-code transactions are recorded. One row per
 -- Apple transaction (multi-period offers renew under the same offer); count distinct chains for attribution.
 if v_offer_code and p_transaction->>'transactionId' is not null then
   insert into public.app_store_offer_redemptions(user_id,original_transaction_id,transaction_id,product_id,
     offer_identifier,offer_type,environment,redeemed_at)
   values(p_user_id,v_original,p_transaction->>'transactionId',p_transaction->>'productId',
     nullif(p_transaction->>'offerIdentifier',''),3,v_env,v_purchase)
   on conflict(transaction_id) do nothing;
 end if;
 return to_jsonb(new_state)||jsonb_build_object('stale',v_stale,'offer_bound',v_offer_bound,'active',
   new_state.status in ('active','grace_period','cancelled_but_active_until_expiry') and new_state.expires_at>now());
end;
$$;
revoke all on function public.persist_verified_subscription(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.persist_verified_subscription(uuid,jsonb,jsonb) to service_role;
notify pgrst,'reload schema';
