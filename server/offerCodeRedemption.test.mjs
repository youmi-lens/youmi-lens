import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createSubscriptionDatabase } from './subscriptionDatabaseHarness.mjs'
import { verifyAndPersistSubscription, upsertSubscriptionState, assertSubscriptionIdentity, SubscriptionAccountTokenError,
  SubscriptionAlreadyLinkedError, SubscriptionOfferRequiresAccountError } from './iapSubscriptions.mjs'

const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', G='cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const annual='com.aydenz.youmilensipad.student.annual'
// Offer code redeemed in the App Store: offerType 3, no appAccountToken.
const offerCode=(extra={})=>({originalTransactionId:'offer-chain',transactionId:'offer-tx-1',productId:annual,
  appAccountToken:null,environment:'Production',purchaseDate:'2026-11-01T00:00:00Z',appleExpiresDate:'2099-11-01T00:00:00Z',
  appleSignedAt:'2026-11-01T00:00:01Z',offerType:3,offerIdentifier:'DY-annual-40',offerDiscountType:'PAY_UP_FRONT',
  subscriptionGroupId:'22109238',ownershipType:'PURCHASED',...extra})
const tokened=(user,extra={})=>offerCode({originalTransactionId:'normal-chain',transactionId:'normal-tx-1',appAccountToken:user,
  offerType:null,offerIdentifier:null,offerDiscountType:null,...extra})

let db
beforeAll(async()=>{ db=await createSubscriptionDatabase() })
afterAll(async()=>{ await db.pg.close() })
beforeEach(async()=>{
  await db.pg.exec('truncate public.app_store_offer_redemptions,public.app_store_subscription_states,public.app_store_subscription_bindings,public.subscription_test_chain_policy,public.subscription_purchase_authorizations,auth.users cascade')
  await db.pg.query('insert into auth.users values($1,false),($2,false),($3,true)',[A,B,G])
})

describe('offer-code redemption without appAccountToken',()=>{
  it('unbound offer code binds to the signed-in caller and records the redemption',async()=>{
    const state=await verifyAndPersistSubscription(db,A,offerCode())
    expect(state).toMatchObject({user_id:A,status:'active',active:true,offer_bound:true,app_account_token:null})
    const {bindings,states}=await db.snapshots()
    expect(bindings).toEqual([expect.objectContaining({original_transaction_id:'offer-chain',user_id:A,app_account_token:A,owner_state:'active'})])
    expect(states).toHaveLength(1)
    expect(await db.redemptions()).toEqual([expect.objectContaining({user_id:A,original_transaction_id:'offer-chain',
      transaction_id:'offer-tx-1',product_id:annual,offer_identifier:'DY-annual-40',offer_type:3,environment:'Production',
      redeemed_at:'2026-11-01T00:00:00.000Z'})])
  })

  it('replaying the same redemption is idempotent and no longer reports a new binding',async()=>{
    await verifyAndPersistSubscription(db,A,offerCode())
    const replay=await verifyAndPersistSubscription(db,A,offerCode())
    expect(replay).toMatchObject({user_id:A,active:true,offer_bound:false})
    expect(await db.redemptions()).toHaveLength(1)
    expect((await db.snapshots()).bindings).toHaveLength(1)
  })

  it('offer code already bound to another user is rejected with no write for the caller',async()=>{
    await verifyAndPersistSubscription(db,A,offerCode())
    const before=await db.snapshots(), redemptionsBefore=await db.redemptions()
    await expect(verifyAndPersistSubscription(db,B,offerCode())).rejects.toBeInstanceOf(SubscriptionAlreadyLinkedError)
    await expect(verifyAndPersistSubscription(db,B,offerCode({transactionId:'offer-tx-2',purchaseDate:'2026-12-01T00:00:00Z'})))
      .rejects.toBeInstanceOf(SubscriptionAlreadyLinkedError)
    expect(await db.snapshots()).toEqual(before)
    expect(await db.redemptions()).toEqual(redemptionsBefore)
  })

  it('offer code on a chain bound through a normal signed purchase of another user is rejected',async()=>{
    await verifyAndPersistSubscription(db,A,tokened(A))
    await expect(verifyAndPersistSubscription(db,B,offerCode({originalTransactionId:'normal-chain'})))
      .rejects.toBeInstanceOf(SubscriptionAlreadyLinkedError)
    expect(await db.redemptions()).toEqual([])
  })

  it('a guest-owned chain is never promoted by token-less offer evidence',async()=>{
    await verifyAndPersistSubscription(db,G,tokened(G))
    const before=await db.snapshots()
    await expect(verifyAndPersistSubscription(db,A,offerCode({originalTransactionId:'normal-chain'})))
      .rejects.toBeInstanceOf(SubscriptionAlreadyLinkedError)
    expect(await db.snapshots()).toEqual(before)
  })

  it('an anonymous caller cannot bind a token-less offer code',async()=>{
    await expect(verifyAndPersistSubscription(db,G,offerCode())).rejects.toBeInstanceOf(SubscriptionOfferRequiresAccountError)
    expect(await db.snapshots()).toEqual({bindings:[],states:[]})
    expect(await db.redemptions()).toEqual([])
  })

  it('a notification can never bootstrap a token-less offer-code chain',async()=>{
    await expect(upsertSubscriptionState(db,A,offerCode(),{source:'notification_v2',notificationType:'OFFER_REDEEMED'}))
      .rejects.toThrow()
    expect(await db.snapshots()).toEqual({bindings:[],states:[]})
  })

  it('a non-Production offer-code chain still requires an explicit test-chain policy',async()=>{
    await expect(verifyAndPersistSubscription(db,A,offerCode({environment:'Sandbox'}))).rejects.toThrow('not available')
    expect(await db.snapshots()).toEqual({bindings:[],states:[]})
  })

  it('later token-less renewals of the owner\'s offer chain are accepted and recorded only while offerType is 3',async()=>{
    await verifyAndPersistSubscription(db,A,offerCode({purchaseDate:'2026-08-01T00:00:00Z',appleSignedAt:'2026-08-01T00:00:01Z'}))
    const inOffer=offerCode({transactionId:'offer-tx-2',purchaseDate:'2026-09-01T00:00:00Z',appleSignedAt:'2026-09-01T00:00:01Z'})
    await upsertSubscriptionState(db,A,inOffer,{source:'notification_v2',notificationType:'DID_RENEW'})
    const afterOffer=offerCode({transactionId:'full-price-tx-3',purchaseDate:'2026-10-01T00:00:00Z',appleSignedAt:'2026-10-01T00:00:01Z',
      offerType:null,offerIdentifier:null,offerDiscountType:null})
    const state=await upsertSubscriptionState(db,A,afterOffer,{source:'notification_v2',notificationType:'DID_RENEW'})
    expect(state).toMatchObject({user_id:A,latest_transaction_id:'full-price-tx-3',active:true})
    expect((await db.redemptions()).map(r=>r.transaction_id)).toEqual(['offer-tx-1','offer-tx-2'])
  })

  it('every platform offer identifier is kept for attribution',async()=>{
    await verifyAndPersistSubscription(db,A,offerCode())
    await verifyAndPersistSubscription(db,B,offerCode({originalTransactionId:'xhs-chain',transactionId:'xhs-tx',
      productId:'com.aydenz.youmilensipad.student.monthly',offerIdentifier:'XHS-monthly-30'}))
    const {rows}=await db.pg.query('select offer_identifier,count(distinct original_transaction_id)::int as n from public.app_store_offer_redemptions group by 1 order by 1')
    expect(rows).toEqual([{offer_identifier:'DY-annual-40',n:1},{offer_identifier:'XHS-monthly-30',n:1}])
  })
})

describe('non-offer purchases without appAccountToken are still rejected',()=>{
  it('server check rejects before touching the database',async()=>{
    await expect(verifyAndPersistSubscription(db,A,tokened(null))).rejects.toBeInstanceOf(SubscriptionAccountTokenError)
    expect(()=>assertSubscriptionIdentity(tokened(null))).toThrow(SubscriptionAccountTokenError)
    expect(()=>assertSubscriptionIdentity(offerCode())).not.toThrow()
    expect(await db.snapshots()).toEqual({bindings:[],states:[]})
  })

  it('the database independently rejects a token-less non-offer transaction',async()=>{
    const {error}=await db.rpc('persist_verified_subscription',{p_user_id:A,p_transaction:tokened(null),p_options:{}})
    expect(error?.message).toContain('subscription_token_missing')
    expect(await db.snapshots()).toEqual({bindings:[],states:[]})
  })

  it('token-less evidence for the caller\'s own normally-bound chain is still rejected',async()=>{
    await verifyAndPersistSubscription(db,A,tokened(A))
    const {error}=await db.rpc('persist_verified_subscription',{p_user_id:A,
      p_transaction:tokened(null,{transactionId:'normal-tx-2',purchaseDate:'2027-01-01T00:00:00Z'}),p_options:{}})
    expect(error?.message).toContain('subscription_token_missing')
  })

  it('normal signed purchases keep their existing behaviour and are not recorded as redemptions',async()=>{
    await expect(verifyAndPersistSubscription(db,B,tokened(A))).rejects.toBeInstanceOf(SubscriptionAccountTokenError)
    const state=await verifyAndPersistSubscription(db,A,tokened(A))
    expect(state).toMatchObject({user_id:A,active:true,offer_bound:false})
    expect(await db.redemptions()).toEqual([])
  })
})

describe('app_store_offer_redemptions row-level security',()=>{
  const asRole=async(role,sub,sql)=>{
    await db.pg.exec('begin')
    try {
      await db.pg.query(`select set_config('request.jwt.claim.sub',$1,true)`,[sub??''])
      await db.pg.exec(`set local role ${role}`)
      return await db.pg.query(sql)
    } finally { await db.pg.exec('rollback') }
  }
  beforeEach(async()=>{
    await verifyAndPersistSubscription(db,A,offerCode())
    await verifyAndPersistSubscription(db,B,offerCode({originalTransactionId:'b-chain',transactionId:'b-tx',offerIdentifier:'SPH-annual-50'}))
  })

  it('authenticated users see only their own rows',async()=>{
    const {rows}=await asRole('authenticated',A,'select transaction_id from public.app_store_offer_redemptions')
    expect(rows).toEqual([{transaction_id:'offer-tx-1'}])
  })

  it('authenticated users cannot write',async()=>{
    await expect(asRole('authenticated',A,`insert into public.app_store_offer_redemptions(user_id,original_transaction_id,transaction_id,product_id,offer_type,environment,redeemed_at)
      values('${A}','x','x','${annual}',3,'Production',now())`)).rejects.toThrow(/permission denied/)
    await expect(asRole('authenticated',A,`update public.app_store_offer_redemptions set offer_identifier='forged'`)).rejects.toThrow(/permission denied/)
  })

  it('anon has no access and service_role reads everything',async()=>{
    await expect(asRole('anon',null,'select 1 from public.app_store_offer_redemptions')).rejects.toThrow(/permission denied/)
    const {rows}=await asRole('service_role',null,'select count(*)::int as n from public.app_store_offer_redemptions')
    expect(rows).toEqual([{n:2}])
  })
})
