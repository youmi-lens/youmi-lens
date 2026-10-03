import { beforeEach, describe, expect, it, vi } from 'vitest'
const sdk=vi.hoisted(()=>({status:vi.fn(),info:vi.fn(),transaction:vi.fn(),renewal:vi.fn(),environments:[]}))
vi.mock('@apple/app-store-server-library',async original=>{
  const actual=await original()
  return {...actual,AppStoreServerAPIClient:class {constructor(_k,_id,_issuer,_bundle,env){this.env=env;sdk.environments.push(env)}getAllSubscriptionStatuses(id){return sdk.status(id,this.env)}getTransactionInfo(id){return sdk.info(id,this.env)}},SignedDataVerifier:class {constructor(_roots,_online,env){this.env=env}async verifyAndDecodeTransaction(jws){const tx=await sdk.transaction(jws);if(tx.environment!==this.env)throw Error('environment');return tx}verifyAndDecodeRenewalInfo(jws){return sdk.renewal(jws)}}}
})
const decoded={bundleId:'com.aydenz.youmilensipad',environment:'Production',transactionId:'renewal',originalTransactionId:'chain',productId:'com.aydenz.youmilensipad.student.monthly',type:'Auto-Renewable Subscription',purchaseDate:1,expiresDate:2,subscriptionGroupIdentifier:'22109238',inAppOwnershipType:'PURCHASED',appAccountToken:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',signedDate:3}
beforeEach(()=>{
 vi.resetModules();vi.clearAllMocks();sdk.environments.length=0
 for(const [name,value]of Object.entries({APPLE_IAP_PRIVATE_KEY:'fake-key',APPLE_IAP_KEY_ID:'fake-id',APPLE_IAP_ISSUER_ID:'fake-issuer',APPLE_BUNDLE_ID:decoded.bundleId,APPLE_APP_APPLE_ID:'6770884875',APPLE_IAP_ENVIRONMENT:'Sandbox',APPLE_IAP_ROOT_CERTIFICATES_BASE64:Buffer.from('fake-cert').toString('base64')}))vi.stubEnv(name,value)
 sdk.status.mockResolvedValue({data:[{lastTransactions:[{originalTransactionId:'other',status:1,signedTransactionInfo:'foreign',signedRenewalInfo:'foreign-renewal'},{originalTransactionId:'chain',status:1,signedTransactionInfo:'transaction-jws',signedRenewalInfo:'renewal-jws'}]}]})
 sdk.transaction.mockResolvedValue(decoded);sdk.renewal.mockResolvedValue({environment:'Production',originalTransactionId:'chain',appAccountToken:decoded.appAccountToken,autoRenewStatus:1,signedDate:4,renewalPrice:4990,currency:'USD'})
})
describe('authoritative Apple status API wrapper',()=>{
 it('uses the canonical environment and verifies BOTH signed components, ignoring other chains',async()=>{
  const {fetchVerifiedSubscriptionStatus}=await import('./iapApple.mjs');const result=await fetchVerifiedSubscriptionStatus('chain','Production')
  expect(sdk.status).toHaveBeenCalledWith('chain','Production');expect(sdk.transaction).toHaveBeenCalledExactlyOnceWith('transaction-jws');expect(sdk.renewal).toHaveBeenCalledExactlyOnceWith('renewal-jws')
  expect(result.renewal).toMatchObject({autoRenewStatus:true,renewalPrice:4990,currency:'USD'});expect(result.appleEventAt).toBe(new Date(4).toISOString())
 })
 it('missing auto-renew status remains unknown, never becomes cancellation',async()=>{
  sdk.renewal.mockResolvedValue({environment:'Production',originalTransactionId:'chain'});const {fetchVerifiedSubscriptionStatus}=await import('./iapApple.mjs');expect((await fetchVerifiedSubscriptionStatus('chain','Production')).renewal.autoRenewStatus).toBeNull()
 })
 it.each(['signature','token','chain','environment','bundle','group','missing original'])('rejects %s mismatch before any persistence',async mode=>{
  if(mode==='signature')sdk.renewal.mockRejectedValue(Error('invalid signature'))
  else if(mode==='token')sdk.renewal.mockResolvedValue({originalTransactionId:'chain',appAccountToken:'foreign'})
  else sdk.transaction.mockResolvedValue({...decoded,...({chain:{originalTransactionId:'other'},environment:{environment:'Sandbox'},bundle:{bundleId:'foreign'},group:{subscriptionGroupIdentifier:'wrong'},'missing original':{originalTransactionId:undefined}}[mode])})
  const {fetchVerifiedSubscriptionStatus}=await import('./iapApple.mjs');await expect(fetchVerifiedSubscriptionStatus('chain','Production')).rejects.toThrow()
 })
 it('missing signed renewal info is not sufficient status evidence',async()=>{
  sdk.status.mockResolvedValue({data:[{lastTransactions:[{originalTransactionId:'chain',status:1,signedTransactionInfo:'transaction-jws'}]}]});const {fetchVerifiedSubscriptionStatus}=await import('./iapApple.mjs');await expect(fetchVerifiedSubscriptionStatus('chain','Production')).rejects.toThrow('incomplete')
 })
 it('legacy transaction-id lookup can recover Production when the preferred API environment is Sandbox',async()=>{
  sdk.info.mockImplementation(async(_id,env)=>{if(env==='Sandbox')throw Object.assign(Error('not found'),{httpStatusCode:404});return{signedTransactionInfo:'production-jws'}})
  const {verifyAppleTransaction}=await import('./iapApple.mjs');expect((await verifyAppleTransaction({transactionId:'renewal'})).environment).toBe('Production');expect(sdk.info.mock.calls.map(c=>c[1])).toEqual(['Sandbox','Production'])
 })
})
