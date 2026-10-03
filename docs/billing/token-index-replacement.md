# Legacy token index replacement

Authorized scope: replace only legacy token uniqueness, preserve canonical ownership and every data row, keep monthly/annual sales false, update PR #47 without merging or backend redeployment.

## Inspection and original intent

Production standalone index `public.idx_subscription_binding_app_account_token` on `public.app_store_subscription_bindings`:

```sql
CREATE UNIQUE INDEX idx_subscription_binding_app_account_token
ON public.app_store_subscription_bindings USING btree (app_account_token, environment)
WHERE app_account_token IS NOT NULL AND owner_state = 'active';
```

Created by production migration `20260723031216_commercialization_v2_subscriptions`. Tracked source: `supabase-migration-commercialization-v2-subscriptions.sql`, introduced in Git commit `08e4b986146e95bbf8afaf1f522de2fc9d3c65f8` with auto-renewable verification. Source/history does not document a separate design rationale. Its effective model was one active binding per appAccountToken/environment; interpreting this as an anti-duplicate safeguard is an inference, not a historical fact.

Six binding rows, all six indexed; no duplicate token/environment groups and no objects depend on the index. It does not back a pg_constraint. Replica identity uses the canonical primary key (default), not the legacy token index. A nonunique replacement accepts all existing rows without conflicts. Binding owner_state=active describes canonical ownership, not whether the subscription period is still active; an expired chain therefore continued occupying the old unique token key.

## Independent security proof

Removing token uniqueness cannot grant the same original_transaction_id to two different canonical owners. The canonical binding's original_transaction_id primary key remains unique. Authenticated backend routes verify Apple signatures and pass the requesting UUID to a service-only RPC. New claims require signed appAccountToken = authenticated UUID. The RPC obtains a chain advisory lock even when the binding does not exist, locks authoritative Auth/binding rows, rejects different permanent/guest claimants, and writes ownership/state in the same transaction. Promotion requires an anonymous prior owner plus a token authorizing the permanent caller, with a conditional update and no losing claimant state. The state trigger independently rejects noncanonical owners. Deletion tombstones and environment policy remain unchanged.

Desired model: user A/token A may own chains 1, 2 and 3; each chain still has exactly one canonical owner. User B cannot claim A's chain using either A's historical token or B's own token. Environment equality and scoped nonproduction policy still apply.

## Migration and locking

Option A: nonunique btree lookup `(app_account_token, environment)` with identical active/non-null predicate. This is the smallest DDL change preserving lookup performance: create replacement, validate its shape, then remove only the old standalone index with RESTRICT.

Migration: `supabase/migrations/20261003014819_billing_token_lookup_index.sql`. The atomic DO block validates canonical primary key and exact legacy/replacement columns/predicate, uses a five-second lock timeout, and is safe to repeat. Unexpected schema fails before removing the legacy index. No CASCADE, data updates/deletes, owner remaps, RPC/policy changes or catalog updates.

Regular DROP INDEX can run transactionally and briefly takes an ACCESS EXCLUSIVE table lock; with only six rows, regular index creation is appropriate. CONCURRENTLY is intentionally not used because it cannot run in the same transaction. [PostgreSQL DROP INDEX](https://www.postgresql.org/docs/current/sql-dropindex.html), [unique indexes and primary keys](https://www.postgresql.org/docs/current/indexes-unique.html).

## Conditional reversal — instructions only, do not run automatically

Reintroducing uniqueness is possible only if no user/token/environment owns multiple active chains. After legitimate second-chain claims, reversal must STOP; never delete/remap data to make it fit. Keep sales closed and review impact before authorizing reversal.

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.app_store_subscription_bindings IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM public.app_store_subscription_bindings
    WHERE app_account_token IS NOT NULL AND owner_state='active'
    GROUP BY app_account_token,environment HAVING count(*)>1
  ) THEN
    RAISE EXCEPTION 'Cannot restore token uniqueness without losing legitimate chains; STOP';
  END IF;
END $$;
CREATE UNIQUE INDEX idx_subscription_binding_app_account_token
ON public.app_store_subscription_bindings(app_account_token,environment)
WHERE app_account_token IS NOT NULL AND owner_state='active';
DROP INDEX public.idx_subscription_binding_token_lookup RESTRICT;
COMMIT;
```

Any error requires ROLLBACK. The transaction leaves replacement and data intact on failure. Canonical primary key never changes.

## Regression evidence

117 tests across subscriptionAtomic, iapSubscriptions, subscriptionHardening and iapRoutes pass. Coverage includes same owner/token with three distinct chains; same-chain wrong owner/history; simultaneous permanent challengers; idempotent reverify; guest duplicate rejection; promotion races; explicit environment policy; migration repeat; unexpected-index guard; data preservation. Live staging migration also accepts two chains for one owner; simultaneous challenger requests must fail without new state. Temporary fixtures are removed after rehearsal.

## Production application and final evidence

Applied successfully October 2, 2026 approximately 22:20 Eastern. Supabase history: `20261003022002_billing_token_lookup_index`. Committed migration/security tests: `8256d7213dafe8ddb71e8ce0d9a6439450193cd0`. Backend runtime remains b87f0dc on deployment b4e1b7d1; no runtime redeployment was required.

Legacy index absent; `idx_subscription_binding_token_lookup` valid/nonunique with exactly the prior columns and predicate. Canonical PK and user lookup index remain. Canonical RPC/Auth-lock/state-guard/PK fingerprint remains `c53b6544e8cf156cd678bd5720938acc` before and after. No authorization or environment policy changed.

| Data table | Pre/post rows | Pre/post full-row digest | Result |
|---|---:|---|---|
| Bindings | 6 | 95905dc07c5078814b88966c1ba18b1d | MATCH |
| States | 6 | f879fc814063b398104cc571f9f3b27e | MATCH |
| Entitlements | 10 | 5759718e44a225403a8817c83ddb5066 | MATCH |
| Catalog | 6 | 054e398d217ec94d2b7ffb0b478fcb19 | MATCH |
| Billing events | 409 | 88920594a9324108d066717af5fa34db | MATCH |

State digest includes EVERY column, including apple_event_at; unlike the earlier additive-migration report, there are no column exclusions here. Zero data-bearing rows modified. Migration-history metadata records the authorized schema application.

Incident A: owner 10b3fa36…, chain …882155, Production active, correct binding/state token, exactly one state, canonical owner unchanged, Student Basic; expiry remains 2026-11-03T00:51:55Z. All six effective-access snapshots match. Duplicate canonical chains=0, duplicate active owners=0, unexplained grants=0.

117 focused regression tests passed before application, and 29 atomic/schema tests passed again afterward. Live staging confirmed two chains with one owner and rejected two concurrent second-user requests with no extra state. All temporary staging bindings, states and Auth accounts were removed. No purchase, Restore, replay or manual Production ownership/state/entitlement mutation was performed.

Live health and availability pass; monthly=false and annual=false. Initial post-migration HTTP window: two successful requests, zero 5xx; preceding five-minute observed window also had zero 5xx. This is an initial low-traffic observation, not a load or long-duration claim. Security-advisor findings are unchanged from the hardening baseline; see deployment-evidence.md for existing notice/remediation links.

The token-index blocker is resolved. Remaining reopening blockers: backend/iPad PRs unmerged, RC 0.2.2 Build 64 not physically qualified/submitted/released publicly. Sales remain NO-GO. Next owner action: authorize physical qualification of the existing RC while sales remain closed. No automatic merge or new iOS build is performed in this task.
