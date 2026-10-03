import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createSubscriptionDatabase } from './subscriptionDatabaseHarness.mjs'
import { verifyAndPersistSubscription, upsertSubscriptionState, SubscriptionAccountTokenError,
  SubscriptionAlreadyLinkedError, SubscriptionDeletedAccountError, SubscriptionEnvironmentError } from './iapSubscriptions.mjs'
import { subscriptionAvailability } from './subscriptionAvailability.mjs'

const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', G='cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const product='com.aydenz.youmilensipad.student.monthly'
const transaction=(user=A,extra={})=>({originalTransactionId:'chain',transactionId:'transaction',productId:product,
  appAccountToken:user,environment:'Production',purchaseDate:'2026-10-01T00:00:00Z',appleExpiresDate:'2099-11-01T00:00:00Z',
  appleSignedAt:'2026-10-02T00:00:00Z',offerDiscountType:'FREE_TRIAL',offerType:1,price:0,subscriptionGroupId:'22109238',ownershipType:'PURCHASED',...extra})
let db
beforeAll(async()=>{ db=await createSubscriptionDatabase() })
afterAll(async()=>{await db.pg.close()})
beforeEach(async()=>{
  await db.pg.exec('truncate public.app_store_subscription_states,public.app_store_subscription_bindings,public.subscription_test_chain_policy,public.subscription_purchase_authorizations,auth.users cascade; update public.billing_products set is_purchasable=true')
  await db.pg.query('insert into auth.users values($1,false),($2,false),($3,true)',[A,B,G])
})

describe('real PostgreSQL atomic subscription operation',()=>{
  it('one authorized owner may own distinct Apple chains without duplicating either chain',async()=>{
    await verifyAndPersistSubscription(db,A,transaction())
    await verifyAndPersistSubscription(db,A,transaction(A,{originalTransactionId:'second-chain'}))
    await verifyAndPersistSubscription(db,A,transaction(A,{originalTransactionId:'third-chain'}))
    const snapshot=await db.snapshots()
    expect(snapshot.bindings).toHaveLength(3)
    expect(snapshot.states.every(s=>s.user_id===A)).toBe(true)
  })
  it('legacy unique token index reproduces rejection and index replacement preserves all rows',async()=>{
    const legacy=await createSubscriptionDatabase({replaceTokenIndex:false})
    try {
      await verifyAndPersistSubscription(legacy,A,transaction())
      const before=await legacy.snapshots()
      await expect(verifyAndPersistSubscription(legacy,A,transaction(A,{originalTransactionId:'second-chain'}))).rejects.toThrow('persistence failed')
      expect(await legacy.snapshots()).toEqual(before)
      const {tokenIndexMigration}=await import('./subscriptionDatabaseHarness.mjs')
      await legacy.pg.exec(tokenIndexMigration)
      expect(await legacy.snapshots()).toEqual(before)
      await verifyAndPersistSubscription(legacy,A,transaction(A,{originalTransactionId:'second-chain'}))
      expect((await legacy.snapshots()).bindings).toHaveLength(2)
    } finally { await legacy.pg.close() }
  })
  it('index migration repeats idempotently without changing rows or canonical PK',async()=>{
    await verifyAndPersistSubscription(db,A,transaction())
    const before=await db.snapshots()
    const {tokenIndexMigration}=await import('./subscriptionDatabaseHarness.mjs')
    await db.pg.exec(tokenIndexMigration)
    await db.pg.exec(tokenIndexMigration)
    expect(await db.snapshots()).toEqual(before)
    expect((await db.pg.query("select indisprimary,indisunique from pg_index where indexrelid='public.app_store_subscription_bindings_pkey'::regclass")).rows[0]).toEqual({indisprimary:true,indisunique:true})
  })
  it('unexpected replacement definition stops before legacy uniqueness is removed',async()=>{
    const legacy=await createSubscriptionDatabase({replaceTokenIndex:false})
    try {
      await verifyAndPersistSubscription(legacy,A,transaction())
      const before=await legacy.snapshots()
      await legacy.pg.exec('create index idx_subscription_binding_token_lookup on public.app_store_subscription_bindings(user_id)')
      const {tokenIndexMigration}=await import('./subscriptionDatabaseHarness.mjs')
      await expect(legacy.pg.exec(tokenIndexMigration)).rejects.toThrow('Replacement token lookup index differs')
      expect(await legacy.snapshots()).toEqual(before)
      expect((await legacy.pg.query("select indisunique from pg_index where indexrelid='public.idx_subscription_binding_app_account_token'::regclass")).rows[0].indisunique).toBe(true)
    } finally {await legacy.pg.close()}
  })
  it('two concurrent permanent challengers fail against the same already-bound chain',async()=>{
    const C='dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    await db.pg.query('insert into auth.users values($1,false)',[C])
    await verifyAndPersistSubscription(db,A,transaction())
    const before=await db.snapshots()
    const results=await Promise.allSettled([verifyAndPersistSubscription(db,B,transaction(B)),verifyAndPersistSubscription(db,C,transaction(C))])
    expect(results.every(r=>r.status==='rejected' && r.reason instanceof SubscriptionAlreadyLinkedError)).toBe(true)
    expect(await db.snapshots()).toEqual(before)
    await expect(verifyAndPersistSubscription(db,B,transaction())).rejects.toThrow(SubscriptionAlreadyLinkedError)
  })
  it('correct Production free trial claim is active and idempotent',async()=>{
    for(let n=0;n<2;n++)expect((await verifyAndPersistSubscription(db,A,transaction())).active).toBe(true)
    expect((await db.snapshots()).states).toHaveLength(1)
  })
  it('wrong token creates neither binding nor state',async()=>{
    await expect(verifyAndPersistSubscription(db,B,transaction())).rejects.toThrow(SubscriptionAccountTokenError)
    expect(await db.snapshots()).toEqual({bindings:[],states:[]})
  })
  it('concurrent first claim authorizes one permanent owner',async()=>{
    const results=await Promise.allSettled([verifyAndPersistSubscription(db,A,transaction()),verifyAndPersistSubscription(db,B,transaction(B))])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect((await db.snapshots()).states).toHaveLength(1)
  })
  it('guest history cannot duplicate a permanent chain',async()=>{
    await verifyAndPersistSubscription(db,A,transaction())
    await expect(verifyAndPersistSubscription(db,G,transaction())).rejects.toThrow(SubscriptionAlreadyLinkedError)
    expect((await db.snapshots()).states).toHaveLength(1)
  })
  it('promotion is atomic, exactly one winner, old guest inactive',async()=>{
    await verifyAndPersistSubscription(db,G,transaction(G))
    const results=await Promise.allSettled([verifyAndPersistSubscription(db,A,transaction()),verifyAndPersistSubscription(db,B,transaction(B))])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    const {bindings,states}=await db.snapshots()
    expect(bindings).toHaveLength(1)
    expect(states.filter(s=>s.status==='active')).toHaveLength(1)
    expect(states.find(s=>s.user_id===G).status).toBe('expired')
  })
  it('state constraint failure rolls back a newly inserted binding',async()=>{
    await expect(verifyAndPersistSubscription(db,A,transaction(A,{transactionId:null}))).rejects.toThrow('persistence failed')
    expect(await db.snapshots()).toEqual({bindings:[],states:[]})
  })
  it('direct non-owner write is rejected by the database guard',async()=>{
    await verifyAndPersistSubscription(db,A,transaction())
    await expect(db.pg.query('insert into public.app_store_subscription_states select original_transaction_id,$1,product_id,latest_transaction_id,subscription_group_id,environment,ownership_type,app_account_token,purchased_at,expires_at,auto_renew_status,status,revocation_at,source,last_notification_type,last_verified_at,created_at,updated_at,apple_event_at from public.app_store_subscription_states',[B])).rejects.toThrow('subscription_owner_conflict')
  })
  it('deleted account tombstone cannot silently transfer',async()=>{
    await verifyAndPersistSubscription(db,A,transaction())
    await db.pg.query("update public.app_store_subscription_bindings set owner_state='account_deleted',user_id=null where original_transaction_id='chain'")
    await expect(verifyAndPersistSubscription(db,B,transaction(B))).rejects.toThrow(SubscriptionDeletedAccountError)
  })
  it('Auth deletion preserves ownership tombstone and removes account state',async()=>{
    await verifyAndPersistSubscription(db,A,transaction())
    await db.pg.query('delete from auth.users where id=$1',[A])
    const snapshot=await db.snapshots()
    expect(snapshot.bindings[0].owner_state).toBe('account_deleted')
    expect(snapshot.bindings[0].user_id).toBeNull()
    expect(snapshot.states).toHaveLength(0)
    await expect(verifyAndPersistSubscription(db,B,transaction(B))).rejects.toThrow(SubscriptionDeletedAccountError)
  })
  it('purchase admitted while open delivers even if sales close during Apple sheet',async()=>{
    const {rows}=await db.pg.query('select public.authorize_subscription_purchase($1,$2) as admission',[A,product])
    await db.pg.exec('update public.billing_products set is_purchasable=false')
    const purchase=transaction(A,{purchaseDate:new Date().toISOString(),appleSignedAt:new Date().toISOString()})
    expect((await verifyAndPersistSubscription(db,A,purchase,{purchaseAuthorizationId:rows[0].admission.authorizationId})).active).toBe(true)
  })
  it('pending Apple completion remains deliverable after the start deadline',async()=>{
    const {rows}=await db.pg.query('select public.authorize_subscription_purchase($1,$2) as admission',[A,product])
    await db.pg.query("update public.subscription_purchase_authorizations set expires_at=now()-interval '1 second' where id=$1",[rows[0].admission.authorizationId])
    await db.pg.exec('update public.billing_products set is_purchasable=false')
    const purchase=transaction(A,{purchaseDate:new Date().toISOString(),appleSignedAt:new Date().toISOString()})
    expect((await verifyAndPersistSubscription(db,A,purchase,{purchaseAuthorizationId:rows[0].admission.authorizationId})).active).toBe(true)
  })
  it('admission is not ownership proof and cannot override the signed token',async()=>{
    const {rows}=await db.pg.query('select public.authorize_subscription_purchase($1,$2) as admission',[A,product])
    const options={purchaseAuthorizationId:rows[0].admission.authorizationId}
    const purchase=transaction(A,{purchaseDate:new Date().toISOString(),appleSignedAt:new Date().toISOString()})
    await expect(verifyAndPersistSubscription(db,B,purchase,options)).rejects.toThrow(SubscriptionAccountTokenError)
    await verifyAndPersistSubscription(db,A,purchase,options)
    expect((await verifyAndPersistSubscription(db,A,{...purchase,originalTransactionId:'other'},options)).active).toBe(true)
  })
  it('signed Production notification can deliver first purchase while sales stay closed',async()=>{
    await db.pg.exec('update public.billing_products set is_purchasable=false')
    const state=await upsertSubscriptionState(db,A,transaction(),{source:'notification_v2',notificationType:'SUBSCRIBED',renewal:{autoRenewStatus:true}})
    expect(state.active).toBe(true);expect(state.auto_renew_status).toBe(true)
    expect((await db.snapshots()).bindings).toHaveLength(1)
  })
  it('notification cannot bootstrap an anonymous account or a wrong signed token',async()=>{
    await expect(upsertSubscriptionState(db,G,transaction(G),{source:'notification_v2'})).rejects.toThrow(SubscriptionAlreadyLinkedError)
    await expect(upsertSubscriptionState(db,B,transaction(),{source:'notification_v2'})).rejects.toThrow(SubscriptionAccountTokenError)
    expect(await db.snapshots()).toEqual({bindings:[],states:[]})
  })
  it('signed cancellation preserves access until actual Apple expiry',async()=>{
    const state=await upsertSubscriptionState(db,A,transaction(),{source:'notification_v2',notificationType:'DID_CHANGE_RENEWAL_STATUS',renewal:{autoRenewStatus:false}})
    expect(state.status).toBe('cancelled_but_active_until_expiry');expect(state.active).toBe(true)
  })
  it('authoritative status API repairs missed renewal and treats revoked status as inactive',async()=>{
    await verifyAndPersistSubscription(db,A,transaction(A,{appleExpiresDate:'2026-10-02T00:00:00Z'}))
    const renewed=await upsertSubscriptionState(db,A,transaction(A,{purchaseDate:'2026-10-02T00:00:00Z',appleSignedAt:'2026-10-03T00:00:00Z'}),{source:'app_store_server_api',appleStatus:1,renewal:{autoRenewStatus:true}})
    expect(renewed.active).toBe(true)
    const revoked=await upsertSubscriptionState(db,A,transaction(A,{purchaseDate:'2026-10-02T00:00:00Z',appleSignedAt:'2026-10-03T01:00:00Z'}),{source:'app_store_server_api',appleStatus:5})
    expect(revoked.active).toBe(false);expect(revoked.status).toBe('revoked')
  })
  it('later REFUND_REVERSED can restore the same period; ordinary newer replay cannot',async()=>{
    await verifyAndPersistSubscription(db,A,transaction())
    await upsertSubscriptionState(db,A,transaction(A,{revoked:true,revokedAt:'2026-10-03T00:00:00Z'}),{source:'notification_v2',notificationType:'REFUND',appleEventAt:'2026-10-03T00:00:00Z'})
    expect((await verifyAndPersistSubscription(db,A,transaction(A,{appleSignedAt:'2026-10-03T01:00:00Z'}))).active).toBe(false)
    expect((await upsertSubscriptionState(db,A,transaction(),{source:'notification_v2',notificationType:'REFUND_REVERSED',appleEventAt:'2026-10-03T02:00:00Z'})).active).toBe(true)
  })
  it('NULL event evidence cannot bypass terminal replay protection',async()=>{
    const old={purchased_at:'2026-10-01',expires_at:'2099-01-01',status:'refunded',apple_event_at:'2026-10-03'}
    const incoming={...old,status:'active',apple_event_at:null}
    expect((await db.pg.query('select billing_private.state_precedes($1,$2) as allowed',[old,incoming])).rows[0].allowed).toBe(false)
  })
  it('authoritative grace expiry grants access, billing retry without grace does not',async()=>{
    const grace=await upsertSubscriptionState(db,A,transaction(A,{appleExpiresDate:'2026-10-02T00:00:00Z'}),{source:'app_store_server_api',appleStatus:4,renewal:{isInBillingRetryPeriod:true,gracePeriodExpiresDate:'2099-01-01T00:00:00Z'}})
    expect(grace.active).toBe(true);expect(grace.status).toBe('grace_period')
    const retry=await upsertSubscriptionState(db,A,transaction(A,{appleSignedAt:'2026-10-03T01:00:00Z'}),{source:'app_store_server_api',appleStatus:3,renewal:{isInBillingRetryPeriod:true}})
    expect(retry.active).toBe(false)
  })
  it('closed sales cannot issue an admission before StoreKit',async()=>{
    await db.pg.exec('update public.billing_products set is_purchasable=false')
    await expect(db.pg.query('select public.authorize_subscription_purchase($1,$2)',[A,product])).rejects.toThrow('subscription_sales_closed')
  })
  it.each(['revoked','refunded','expired'])('%s cannot resurrect through same/older active replay',async status=>{
    await verifyAndPersistSubscription(db,A,transaction())
    await upsertSubscriptionState(db,A,transaction(),{source:'notification_v2',notificationType:{revoked:'REVOKE',refunded:'REFUND',expired:'EXPIRED'}[status],appleEventAt:'2026-10-03T00:00:00Z'})
    expect((await verifyAndPersistSubscription(db,A,transaction())).status).toBe(status)
    expect((await verifyAndPersistSubscription(db,A,transaction(A,{purchaseDate:'2026-09-01T00:00:00Z'}))).active).toBe(false)
    expect((await verifyAndPersistSubscription(db,A,transaction(A,{purchaseDate:'2026-10-02T00:00:00Z',appleSignedAt:'2026-10-03T00:00:00Z'}))).active).toBe(true)
  })
  it('older notification cannot revoke a later renewal',async()=>{
    await verifyAndPersistSubscription(db,A,transaction(A,{purchaseDate:'2026-10-02T00:00:00Z'}))
    expect((await upsertSubscriptionState(db,A,transaction(),{notificationType:'REFUND',source:'notification_v2',appleEventAt:'2026-12-01T00:00:00Z'})).active).toBe(true)
  })
  it('equal-event conflicts converge on terminal state regardless of order',async()=>{
    await verifyAndPersistSubscription(db,A,transaction())
    await upsertSubscriptionState(db,A,transaction(),{notificationType:'REVOKE',source:'notification_v2',appleEventAt:'2026-10-02T00:00:00Z'})
    expect((await verifyAndPersistSubscription(db,A,transaction())).status).toBe('revoked')
  })
  it('new Sandbox chain is rejected with no write',async()=>{
    await expect(verifyAndPersistSubscription(db,A,transaction(A,{environment:'Sandbox'}))).rejects.toThrow(SubscriptionEnvironmentError)
    expect(await db.snapshots()).toEqual({bindings:[],states:[]})
  })
  it('explicit test-chain policy preserves only that account and chain',async()=>{
    await db.pg.query('insert into public.subscription_test_chain_policy(user_id,original_transaction_id,environment,reason) values($1,$2,$3,$4)',[A,'chain','Sandbox','Approved test fixture'])
    expect((await verifyAndPersistSubscription(db,A,transaction(A,{environment:'Sandbox'}))).active).toBe(true)
    await expect(verifyAndPersistSubscription(db,A,transaction(A,{environment:'Sandbox',originalTransactionId:'other'}))).rejects.toThrow(SubscriptionEnvironmentError)
  })
  it('environment mismatch cannot overwrite Production owner',async()=>{
    await verifyAndPersistSubscription(db,A,transaction())
    await db.pg.query('insert into public.subscription_test_chain_policy(user_id,original_transaction_id,environment,reason) values($1,$2,$3,$4)',[A,'chain','Sandbox','Approved test fixture'])
    await expect(verifyAndPersistSubscription(db,A,transaction(A,{environment:'Sandbox'}))).rejects.toThrow(SubscriptionEnvironmentError)
  })
  it('RPC execute permission is service-only',async()=>{
    await db.pg.exec('set role authenticated')
    try { await expect(db.pg.query('select public.persist_verified_subscription($1,$2,$3)',[A,transaction(),{}])).rejects.toThrow('permission denied') }
    finally { await db.pg.exec('reset role') }
    await db.pg.exec('set role service_role')
    try { expect((await db.pg.query('select public.persist_verified_subscription($1,$2,$3) as state',[A,transaction(),{}])).rows[0].state.active).toBe(true) }
    finally {await db.pg.exec('reset role')}
  })
  it('closed sales preserve valid Production delivery including legacy clients without admission',async()=>{
    await db.pg.exec('update public.billing_products set is_purchasable=false')
    expect((await verifyAndPersistSubscription(db,A,transaction())).active).toBe(true)
    expect((await db.snapshots()).states).toHaveLength(1)
    await db.pg.exec('update public.billing_products set is_purchasable=true')
    await verifyAndPersistSubscription(db,A,transaction())
    await db.pg.exec('update public.billing_products set is_purchasable=false')
    expect((await verifyAndPersistSubscription(db,A,transaction())).active).toBe(true)
  })
})

describe('backend catalog availability',()=>{
  it('missing/closed products fail closed; open products use catalog',async()=>{
    const adapter={from:()=>({select:()=>({in:async()=>({data:(await db.pg.query('select * from public.billing_products')).rows,error:null})})})}
    expect((await subscriptionAvailability(adapter)).every(p=>p.purchasable)).toBe(true)
    await db.pg.exec('update public.billing_products set is_purchasable=false')
    expect((await subscriptionAvailability(adapter)).every(p=>!p.purchasable)).toBe(true)
  })
})
