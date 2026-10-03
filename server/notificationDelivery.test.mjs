import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { reserveNotification, markNotificationFailed, markNotificationProcessed } from './iapEntitlements.mjs'
let pg
// Exercise real PostgreSQL unique constraints, compare-and-swap and timestamp trigger.
const db = { from() {
  let mode='select', values, columns='*'; const filters=[]
  const q = {
    insert(v) { mode='insert'; values=v; return q }, update(v) { mode='update'; values=v; return q },
    select(v='*') { columns=v; return q }, eq(k,v) { filters.push([k,v]); return q },
    async single() { const result=await execute(); return { ...result, data: result.data?.[0] } },
    async maybeSingle() { return q.single() }, then(a,b) { return execute().then(a,b) },
  }
  const execute=async()=>{
    const args=[]; const bind=v=>{args.push(v);return `$${args.length}`}
    const entries=Object.entries(values??{})
    const where=()=>filters.length?' where '+filters.map(([k,v])=>`${k}=${bind(v)}`).join(' and '):''
    let sql
    if(mode==='insert') sql=`insert into apple_iap_notifications(${entries.map(([k])=>k)}) values(${entries.map(([,v])=>bind(v))}) returning ${columns}`
    else if(mode==='update') sql=`update apple_iap_notifications set ${entries.map(([k,v])=>`${k}=${bind(v)}`)}${where()} returning ${columns}`
    else sql=`select ${columns} from apple_iap_notifications${where()}`
    try { return { data: (await pg.query(sql,args)).rows.map(r=>({...r,updated_at:r.updated_at?.toISOString()})), error:null } }
    catch(error) { return { data:null,error } }
  }; return q
} }
beforeAll(async()=>{
  pg=new PGlite()
  await pg.exec(`create table apple_iap_notifications(notification_uuid text primary key,notification_type text,subtype text,environment text,transaction_id text,processing_status text,processed_at timestamptz,safe_error text,updated_at timestamptz default clock_timestamp());
    create function notification_timestamp() returns trigger language plpgsql as $$begin new.updated_at=clock_timestamp(); return new; end$$;
    create trigger updated before update on apple_iap_notifications for each row execute function notification_timestamp();`)
})
afterAll(async()=>pg.close());beforeEach(async()=>pg.exec('truncate apple_iap_notifications'))
describe('durable Apple notification delivery',()=>{
  it('processing duplicate is retryable; only processed is deduplicated successfully',async()=>{
    const lease=await reserveNotification(db,{notificationUUID:'n'})
    expect(lease.reserved).toBe(true)
    expect(await reserveNotification(db,{notificationUUID:'n'})).toMatchObject({reserved:false,inFlight:true})
    await markNotificationProcessed(db,'n',lease.lease)
    expect(await reserveNotification(db,{notificationUUID:'n'})).toEqual({reserved:false,notificationUUID:'n'})
  })
  it('concurrent failed retries have one winner; stale worker cannot overwrite its result',async()=>{
    const old=await reserveNotification(db,{notificationUUID:'n'})
    await markNotificationFailed(db,'n',Error('temporary'),old.lease)
    const results=await Promise.all([reserveNotification(db,{notificationUUID:'n'}),reserveNotification(db,{notificationUUID:'n'})])
    expect(results.filter(r=>r.reserved)).toHaveLength(1)
    const winner=results.find(r=>r.reserved)
    await markNotificationProcessed(db,'n',winner.lease)
    await markNotificationFailed(db,'n',Error('late old worker'),old.lease)
    expect((await pg.query('select processing_status from apple_iap_notifications')).rows[0].processing_status).toBe('processed')
  })
  it('process death lease becomes reclaimable without manual replay',async()=>{
    await reserveNotification(db,{notificationUUID:'n'})
    await pg.exec('alter table apple_iap_notifications disable trigger updated; update apple_iap_notifications set updated_at=now()-interval \'6 minutes\'; alter table apple_iap_notifications enable trigger updated')
    expect(await reserveNotification(db,{notificationUUID:'n'})).toMatchObject({reserved:true,retrying:true})
  })
})
