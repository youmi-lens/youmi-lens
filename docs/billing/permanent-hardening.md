# Subscription hardening and release gate

Sales must remain closed until the owner approves reopening after the public iOS rollout. This work does not replay or modify the recovered Production subscription.

## Source provenance

September 28 deployment `37600f5a-119b-4f5e-91f7-02f4f2102d86` had no Git SHA. Deployment-session evidence identifies committed base `3ef790e558b8f923c9cff7716b8578bd98f9b601` plus four production overrides. Commit `9fdcebe07bf5a956610f7daded736248f712beca` preserves those overrides (hosted AI, processing recovery, recording processing, and no-speech classification tests). Local file hashes matched the deployment inputs. Container file hashes were not available; provenance is high-confidence reconstruction, not a claimed byte-for-byte container attestation.

`37600f5a` → reconstructed `9fdcebe` → recovered billing hotfix `e0cd77e5cfe0d64784739964340c15ce1a2ed5c4` (deployment `9a2c1660-7726-42fe-a6a8-d1e1b50f5d23`) → `codex/billing-permanent-hardening` → proposed merge to GitHub `main`.

The permanent branch starts at the exact hotfix. Main `33e8f6e` diverges: five main-only commits cover desktop updater and landing-page/documentation work; no main-only server billing edits. The production branch includes twelve previously deployed commits absent from main. The PR must distinguish inherited production-baseline changes from the new billing-only delta (`git diff e0cd77e..HEAD`). Dirty original backend/iPad checkouts remain untouched. Mainline integration is pending PR merge, not implied by deployment.

The iPad RC starts at authoritative public release source `41d1d655e667903ad0822e36b7c8cf8ea266293f` (0.2.1 Build 63). The new delta is billing/client localization only. Product IDs, prices, quota and recording engine remain unchanged; no Course Material delta is included.

## Authorization and persistence

One `originalTransactionId` has one canonical owner. The Apple SDK verifies signatures, bundle, environment and product before the service-only RPC. New claims require signed appAccountToken = authenticated UUID. Existing permanent owners reject all different accounts. Guest claims obey the same invariant. Promotion is limited to an authoritative anonymous prior owner plus a signed token authorizing the permanent claimant. Advisory chain locks, Auth row locks, binding locks, and state writes share one database transaction. Failures roll back binding and state. A state-write trigger rejects every noncanonical owner even for accidental direct service writes.

Account deletion records an ownership tombstone before FK cleanup. Automatic reassignment/recovery is forbidden. Future exceptional recovery requires a separate reviewed process with fresh authority evidence.

Public RPCs use SECURITY INVOKER and service-only EXECUTE. Narrow internal Auth locking/deletion helpers use SECURITY DEFINER in a private schema, empty search_path and no client execute grant. New policy/admission tables enable RLS with no client grants or policies (intentional deny-all). No user_metadata-based authorization is used.

## Chronology

A later Apple purchase period may replace an earlier period. Earlier periods never win. In the same period terminal precedence is refund > revoke > expiry > billing retry > cancellation/grace > active. Older signed event timestamps cannot overwrite known newer events; equal-event conflicts converge on precedence. Terminal states cannot revive in the same period. Nonterminal expiry cannot regress. Grace access ends at the signed grace-period expiry. Existing legacy rows retain null apple_event_at until legitimate reconciliation; no migration invents event timestamps.

## Restore and finishing

Each item returns transactionId, code, granted, safeToFinish and retryable. The client finishes only a successful explicit safeToFinish outcome. Cryptographic validity alone is insufficient. Wrong-owner/token, sales_closed, DB/verification/network failure and revoked/refunded items remain unfinished. A safely reconciled expired item may finish for its canonical owner without granting access. Mixed history reconciles valid items and reports each failure.

## Availability and purchase admission

GET `/api/iap/subscriptions/availability` exposes secret-free catalog availability. Missing products, catalog errors, closed sales, expired sales windows or missing StoreKit products disable purchase. The build master flag remains an additional gate. The client rechecks availability before StoreKit and calls authenticated POST `/api/iap/subscriptions/authorize`.

A generic admission issued while sales are open authorizes one chain for that user and product. The client must start StoreKit within ten minutes. Backend delivery intentionally has no ten-minute completion cutoff, preserving Ask to Buy/pending/offline recovery after closure. Signed purchase date must be at/after admission (30-second clock tolerance). Admission consumption is transactional and cannot authorize another user, product or chain. Closing catalog sales prevents new admissions; already admitted Apple purchases remain reconcilable. The client stores only the opaque admission identifier per account/product so Restore after restart can deliver it. Apple verification and canonical ownership are always required. No incident UUID/chain allowlist exists in runtime logic.

## Environment and migration impact

Before migration: six states/six canonical chains, all owner/environment matched; two active Production owners; four existing Sandbox chains, with one currently active tester. Production states grant access by default. Nonproduction states require explicit `(user, chain, environment)` policy. The additive migration seeds only four existing canonical Sandbox chains, preserving all existing tester access while new unapproved chains fail closed. Future testers need deliberate policy provisioning; no global Sandbox-paid access is enabled.

The migration adds two RLS tables, nullable apple_event_at, service-only RPCs and guard/deletion triggers. It refuses ambiguous legacy ownership; it does not rewrite catalog/bindings/states/entitlements. Migration-impact digests compare all existing rows before and after, excluding only the new nullable column.

A separate proposed index migration replaces the legacy UNIQUE `(appAccountToken, environment)` restriction with a normal lookup index. A UUID can legitimately own distinct original Apple chains; the existing originalTransactionId primary key still prohibits duplicate owners. No rows are removed or rewritten. The owner subsequently authorized this schema-restriction removal. It is now applied with strict definition/primary-key guards; see token-index-replacement.md for pre/post data digests and conditional reversal. A real-Postgres test reproduces the old rejection, proves replacement preserves all rows, and allows two authorized distinct chains.

## Qualification and deployment

Backend: nine focused files, 179 tests, including actual migration/RPC execution in pinned PGlite PostgreSQL, plus live staging simultaneous claim rehearsal (one owner/one state). Temporary staging test accounts/chains were removed. Public/client execute permissions are denied; service execution is granted. Staging advisors found no new billing security warnings; deny-all RLS informational notices are expected. Existing unrelated Auth/profile/search_path warnings are recorded rather than changed in this billing scope.

Backend command: `npx vitest run server/iapApple.test.mjs server/iapEntitlements.test.mjs server/iapSubscriptions.test.mjs server/iapRoutes.test.mjs server/subscriptionHardening.test.mjs server/subscriptionAtomic.test.mjs server/subscriptionEntitlementFallback.test.mjs server/adminSubscriptionResolver.test.mjs server/commercializationV2.test.mjs --silent`.

Client command: `node scripts/run-billing-qualification.mjs`. It runs thirteen relevant payment suites (169 test entries) retaining all behavior/product/quota checks. Two pre-existing Phase 3 release assertions fixed to 0.2.1/Build 57 are isolated only in a temporary runner; their original assertions remain unchanged. Typecheck, targeted lint and diff checks also pass.

The current public Build 63 lacks backend availability gating and explicit per-item finishing. It is not safe evidence for reopening sales. RC 0.2.2 Build 64 must be built, physically qualified, and rolled out publicly before opening sales. Sandbox qualification must use an explicitly provisioned tester chain or staging; it must not open Production sales or replay the recovered incident.

## Rollback

Keep catalog monthly/annual false. If runtime regressions occur, redeploy exact recovery hotfix e0cd77e. Additive schema may remain; its service-only permissions are compatible. Do not roll back by deleting recovered state or transferring ownership. Index rollback would reintroduce a restriction and may fail after legitimate multiple-chain claims; it requires its own data-impact review. Do not claim immediate index reversibility.

## Required regression matrix

| # | Required case | Regression evidence |
|---|---|---|
| 1 | Correct new Production purchase | subscriptionAtomic: correct Production claim |
| 2 | Closed before StoreKit | subscription-permanent-hardening: sales closed prevents request |
| 3 | Wrong signed token/user | subscriptionAtomic: wrong token creates no rows |
| 4–7 | Cancel, pending, timeout, backend failure | payment-hardening, purchase-stall-fix, subscription-permanent-hardening |
| 8–9 | Duplicate and late callback | payment-hardening and linked/late rejection suites |
| 10 | Same owner repeated verify | subscriptionAtomic: idempotent one state |
| 11 | Same owner Restore | subscriptionHardening and payment-hardening |
| 12–13 | Other permanent owner / guest Restore | subscriptionAtomic, subscriptionHardening, iapRoutes |
| 14–15 | No history / mixed history | payment-hardening and subscription-permanent-hardening |
| 16–18 | Closed/conflict unfinished; reconciled success finished | explicit outcomes tests, subscriptionCore, iapRoutes |
| 19 | Concurrent first claim | real SQL subscriptionAtomic plus simultaneous live staging requests |
| 20–22 | Guest promotion race, losing claimant, one owner | real SQL subscriptionAtomic (no losing state) |
| 23 | Deleted account handling | real SQL tombstone/FK deletion tests |
| 24–27 | Renewal, expiry, revoke, refund | subscriptionHardening, subscriptionAtomic |
| 28–29 | Stale replay / out-of-order notification | terminal chronology real SQL tests |
| 30 | Environment mismatch | policy/lineage tests in subscriptionAtomic and iapApple |
| 31–32 | Catalog/Apple AND purchase gate | availability and client gate tests |
| 33–34 | Account switch / discarded stale response | actual Settings/Plans handler tests; A→B→A generation test |
| 35 | Chinese Active copy | localization key-set and permanent hardening tests |
| 36 | Correct Production free-trial when open | accepted monthly auto-renewable Apple normalization and atomic correct-user claim; synthetic fixtures only, never recovered-chain replay |
