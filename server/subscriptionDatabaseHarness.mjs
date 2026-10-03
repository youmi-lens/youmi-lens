// Test-only real PostgreSQL engine. No production credentials or network.
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

export const migration = readFileSync(new URL('../supabase/migrations/20261003011254_billing_atomic_subscription_persistence.sql', import.meta.url), 'utf8')
export const tokenIndexMigration = readFileSync(new URL('../supabase/migrations/20261003014819_billing_token_lookup_index.sql', import.meta.url), 'utf8')
export const deliveryMigration = readFileSync(new URL('../supabase/migrations/20261003190154_payment_delivery_recovery.sql', import.meta.url), 'utf8')
const schema = `
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create table auth.users(id uuid primary key,is_anonymous boolean default false);
create table public.billing_products(product_id text primary key,kind text,is_purchasable boolean,sales_end_at timestamptz);
create table public.app_store_subscription_bindings(original_transaction_id text primary key,user_id uuid references auth.users(id) on delete set null,
app_account_token uuid,environment text not null,owner_state text default 'active',account_deleted_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now());
create table public.app_store_subscription_states(original_transaction_id text,user_id uuid references auth.users(id) on delete cascade,
product_id text not null,latest_transaction_id text not null,subscription_group_id text,environment text not null,ownership_type text,app_account_token uuid,
purchased_at timestamptz not null,expires_at timestamptz not null,auto_renew_status boolean,status text not null,revocation_at timestamptz,
source text default 'storekit_jws' check (source in ('storekit_jws','app_store_server_api','notification_v2','reconciliation')),last_notification_type text,last_verified_at timestamptz default now(),created_at timestamptz default now(),updated_at timestamptz default now(),primary key(original_transaction_id,user_id),
-- Mirrors the PRODUCTION check constraints so a value Production would reject fails here too.
constraint app_store_subscription_states_status_check check (status in ('active','expired','grace_period','billing_retry','revoked','refunded','cancelled_but_active_until_expiry','verification_pending','unknown')),
constraint app_store_subscription_states_environment_check check (environment in ('Sandbox','Production','Xcode','LocalTesting')));
grant usage on schema public to service_role; grant all on all tables in schema public to service_role;
insert into public.billing_products values ('com.aydenz.youmilensipad.student.monthly','auto_renewable',true,null),('com.aydenz.youmilensipad.student.annual','auto_renewable',true,null);
`

export async function createSubscriptionDatabase({ bindings = [], states = [], anonymousUserIds = new Set(), users = [], replaceTokenIndex = true } = {}) {
  const pg = new PGlite()
  await pg.exec(schema)
  const aliases = new Map()
  const uuid = (id) => {
    if (!id) return null
    const hash = createHash('sha256').update(id).digest('hex')
    const value = /^[0-9a-f-]{36}$/i.test(id) ? id : `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`
    aliases.set(value, id)
    return value
  }
  const allUsers = [...new Set([...users, ...bindings.flatMap(b=>[b.user_id,b.app_account_token]), ...states.flatMap(s=>[s.user_id,s.app_account_token])].filter(Boolean))]
  for (const id of allUsers) await pg.query('insert into auth.users values ($1,$2) on conflict do nothing',[uuid(id),anonymousUserIds.has(id)])
  for (const b of bindings) await pg.query('insert into public.app_store_subscription_bindings(original_transaction_id,user_id,app_account_token,environment,owner_state) values($1,$2,$3,$4,$5)',[b.original_transaction_id,uuid(b.user_id),uuid(b.app_account_token??b.user_id),b.environment??'Production',b.owner_state??'active'])
  for (const s of states) {
    const row={product_id:'com.aydenz.youmilensipad.student.monthly',latest_transaction_id:'tx-1',environment:'Production',purchased_at:'2026-01-01T00:00:00Z',expires_at:'2099-01-01T00:00:00Z',status:'active',...s}
    await pg.query('insert into public.app_store_subscription_states(original_transaction_id,user_id,product_id,latest_transaction_id,environment,app_account_token,purchased_at,expires_at,status,auto_renew_status) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[row.original_transaction_id,uuid(row.user_id),row.product_id,row.latest_transaction_id,row.environment,uuid(row.app_account_token??row.user_id),row.purchased_at,row.expires_at,row.status,row.auto_renew_status??null])
  }
  await pg.exec(migration.replace("notify pgrst,'reload schema';",''))
  // Production's legacy restriction; replacement is independently regression tested.
  await pg.exec("create unique index idx_subscription_binding_app_account_token on public.app_store_subscription_bindings(app_account_token,environment) where app_account_token is not null and owner_state='active'")
  if (replaceTokenIndex) await pg.exec(tokenIndexMigration)
  await pg.exec(deliveryMigration)
  const decode = row => Object.fromEntries(Object.entries(row).map(([k,v])=>[k, (k==='user_id'||k==='app_account_token')?(aliases.get(v)??v):(v instanceof Date ? v.toISOString() : (typeof v==='string' && k.endsWith('_at') && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : v))]))
  const from = (table) => {
    if (!['app_store_subscription_states','app_store_subscription_bindings','subscription_test_chain_policy'].includes(table)) throw Error('Unexpected test table')
    let columns='*'; const filters=[],orders=[]
    const execute=async()=>{
      const args=filters.map(([,v])=>v)
      const where=filters.length?' where '+filters.map(([k],i)=>`${k}=$${i+1}`).join(' and '):''
      const order=orders.length?' order by '+orders.join(','):''
      return {data:(await pg.query(`select ${columns} from public.${table}${where}${order}`,args)).rows.map(decode),error:null}
    }
    const query={select(v){columns=v;return query},eq(k,v){filters.push([k,v]);return query},order(k,options){orders.push(`${k} ${options?.ascending===false?'desc':'asc'}`);return query},async maybeSingle(){const r=await execute();return {...r,data:r.data[0]??null}},then(a,b){return execute().then(a,b)}}
    return query
  }
  return { pg, uuid, decode, from,
    async rpc(_name,{p_user_id,p_transaction,p_options}) {
      const caller=uuid(p_user_id), token=uuid(p_transaction.appAccountToken)
      await pg.query('insert into auth.users values($1,$2) on conflict do nothing',[caller,anonymousUserIds.has(p_user_id)])
      const tx={purchaseDate:'2026-01-01T00:00:00Z',appleExpiresDate:'2099-01-01T00:00:00Z',productId:'com.aydenz.youmilensipad.student.monthly',transactionId:'tx-1',environment:'Production',...p_transaction,appAccountToken:token}
      try {
        const {rows}=await pg.query('select public.persist_verified_subscription($1,$2,$3) as state',[caller,tx,p_options])
        return {data:decode(rows[0].state),error:null}
      } catch(error) { return {data:null,error:{code:error.code,message:error.message}} }
    },
    async snapshots() { return {
      bindings:(await pg.query('select * from public.app_store_subscription_bindings')).rows.map(decode),
      states:(await pg.query('select * from public.app_store_subscription_states')).rows.map(decode),
    } },
  }
}
