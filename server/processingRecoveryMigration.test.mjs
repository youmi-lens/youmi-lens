import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../supabase/migrations/20260828210318_processing_recovery_contract.sql', import.meta.url),
  'utf8',
)

describe('processing recovery migration', () => {
  it('adds only the narrow lease and usage-idempotency artifacts', () => {
    expect(migration).toContain('create table if not exists public.recording_processing_leases')
    expect(migration).toContain('recording_id uuid primary key references public.recordings(id)')
    expect(migration).toContain('add column if not exists idempotency_key text')
    expect(migration).toContain('beta_usage_idempotency_key_unique')
    expect(migration).not.toMatch(/app_store_subscription_(bindings|states)|user_entitlements|stripe/i)
  })

  it('keeps lease rows service-role-only', () => {
    expect(migration).toContain('alter table public.recording_processing_leases enable row level security')
    expect(migration).toContain('revoke all on table public.recording_processing_leases from anon, authenticated')
    expect(migration).toContain('grant select, insert, update, delete on table public.recording_processing_leases to service_role')
    expect(migration).not.toMatch(/create policy[\s\S]*recording_processing_leases/i)
  })
})
