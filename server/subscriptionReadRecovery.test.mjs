import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSubscriptionDatabase } from './subscriptionDatabaseHarness.mjs'
const apple=vi.hoisted(()=>({fetch:vi.fn()}))
vi.mock('./iapApple.mjs',async original=>({...await original(),appleServerApiConfigured:()=>true,fetchVerifiedSubscriptionStatus:apple.fetch}))
const OWNER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',FOREIGN='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const tx={originalTransactionId:'read-chain',transactionId:'first',productId:'com.aydenz.youmilensipad.student.monthly',environment:'Production',appAccountToken:OWNER,purchaseDate:'2026-10-01T00:00:00Z',appleSignedAt:'2026-10-02T00:00:00Z',appleExpiresDate:'2026-10-02T00:00:00Z',ownershipType:'PURCHASED',subscriptionGroupId:'22109238'}
let db,getEffective,verify
beforeEach(async()=>{
 vi.resetModules();apple.fetch.mockReset();apple.fetch.mockResolvedValue(null)
 db=await createSubscriptionDatabase({users:[OWNER,FOREIGN]})
 const module=await import('./iapSubscriptions.mjs');getEffective=module.getEffectiveSubscription;verify=module.verifyAndPersistSubscription
 await verify(db,OWNER,tx)
})
afterEach(async()=>db.pg.close())
describe('request-time repair uses the real atomic PostgreSQL operation',()=>{
 it('missed renewal becomes active without client verify/Restore and retains the one owner',async()=>{
   apple.fetch.mockResolvedValue({transaction:{...tx,transactionId:'renewed',purchaseDate:'2026-10-02T00:00:00Z',appleSignedAt:'2026-10-03T00:00:00Z',appleExpiresDate:'2099-01-01T00:00:00Z'},renewal:{autoRenewStatus:true},appleStatus:1,appleEventAt:'2026-10-03T00:00:00Z'})
   const active=await getEffective(db,OWNER);expect(active.active).toBe(true);expect(active.latest_transaction_id).toBe('renewed');expect(active.auto_renew_status).toBe(true)
   const rows=await db.snapshots();expect(rows.states).toHaveLength(1);expect(rows.bindings).toHaveLength(1);expect(await getEffective(db,FOREIGN)).toBeNull()
 })
 it('missed refund/revocation removes active access on the next read',async()=>{
   await verify(db,OWNER,{...tx,appleExpiresDate:'2099-01-01T00:00:00Z'})
   apple.fetch.mockResolvedValue({transaction:{...tx,appleExpiresDate:'2099-01-01T00:00:00Z',appleSignedAt:'2026-10-03T00:00:00Z',revoked:true,revokedAt:'2026-10-03T00:00:00Z'},renewal:{autoRenewStatus:false},appleStatus:5,appleEventAt:'2026-10-03T00:00:00Z'})
   expect((await getEffective(db,OWNER)).active).toBe(false);expect((await db.snapshots()).states[0].status).toBe('revoked')
 })
 it('Apple outage cannot extend an expired period',async()=>{
   apple.fetch.mockRejectedValue(Error('offline'));expect((await getEffective(db,OWNER)).active).toBe(false)
 })
 it('foreign users never initiate Apple reads for somebody else\'s state',async()=>{
   expect(await getEffective(db,FOREIGN)).toBeNull();expect(apple.fetch).not.toHaveBeenCalled()
 })
 it('deletion during an Apple read cannot leak a stale grant',async()=>{
   let reply;apple.fetch.mockImplementation(()=>new Promise(r=>{reply=r}))
   const pending=getEffective(db,OWNER)
   while(!reply)await new Promise(r=>setTimeout(r,1))
   await db.pg.query('delete from auth.users where id=$1',[OWNER]);reply(null)
   expect(await pending).toBeNull()
 })
})
