# Production deployment evidence (October 2, 2026 Eastern)

Backend runtime commit: `b87f0dcab370b96cbddbd05dcd55803551ac71fa`.
Railway deployment: `b4e1b7d1-6749-46d4-a0ee-170201f7d82b`, SUCCESS; created 21:59:53 Eastern, booted approximately 22:00:45. The additive atomic migration applied successfully before runtime rollout. The separate token unique-index removal has not been approved/applied; it remains a sales-readiness blocker and a tested reviewable proposal.

Health returns ok. Live GET availability returns both monthly/annual purchasable=false. Database catalog readback confirms both false. Unauthorized admission returns 401 and creates no admission. Public/authenticated RPC execute denied; service role granted. Four grandfathered tester chains, zero admissions.

All existing row digests match before/after migration and deployment (new nullable apple_event_at excluded only from state digest):

| Scope | Rows | Digest |
|---|---:|---|
| Canonical bindings | 6 | 95905dc07c5078814b88966c1ba18b1d |
| Subscription states | 6 | b1d2d06b0c8ce6a8bcd21c5ab8381260 |
| Entitlements | 10 | 5759718e44a225403a8817c83ddb5066 |
| Full billing catalog | 6 | 054e398d217ec94d2b7ffb0b478fcb19 |

Effective access snapshots for all six accounts match exactly: three active subscription accounts (two Production, one scoped Sandbox). Incident A remains owner `10b3fa36…`, chain `…882155`, matching binding/state appAccountToken, Production active, expiry `2026-11-03T00:51:55Z` (November 2 19:51:55 Eastern), one canonical state, Student Basic. No purchase/Restore/Apple transaction replay or manual entitlement/binding/state mutation occurred.

Final duplicate checks: zero duplicate bindings, zero duplicate active owners, zero noncanonical active states. No new/unexplained entitlement rows. Eight startup log entries were informational with zero error severity. Initial HTTP observation: three requests (two 200, one expected 401), zero 5xx; this is a low-traffic initial window, not load/long-duration assurance.

Security advisors: no new billing warning. Two new RLS-without-policy informational notices reflect intentionally service-only tables with no client grants. Existing unrelated notices remain unchanged: [mutable search_path](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable), [leaked-password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection), and [anonymous-role policy awareness](https://supabase.com/docs/guides/database/database-advisors?queryGroups=lint&lint=0012_auth_allow_anonymous_sign_ins). Existing owner-only SELECT policies include anonymous Auth users intentionally; they do not authorize writes to these billing RPCs.

Reviewable backend PR: https://github.com/youmi-lens/youmi-lens/pull/47. iPad PR: https://github.com/youmi-lens/youmi-lens-ipad/pull/2. Both target main and remain unmerged; no mainline integration is claimed.

RC source: `a417fcedfde7f9c3bf0d46d2341edc17e6de39ec`, 0.2.2 Build 64, EAS build `3d3400eb-509e-43fa-88a0-2cff48ed4025`. EAS status FINISHED: a signed store archive was created successfully. It has not been submitted to TestFlight or physically qualified. Build completion/physical qualification/public rollout are separate gates. Current public Build 63 lacks the new availability and explicit per-item finishing contracts. Production reopening remains NO-GO.

Completed RC: https://expo.dev/accounts/aydenz/projects/youmi-lens-ipad/builds/3d3400eb-509e-43fa-88a0-2cff48ed4025 . Artifact URL is available through that build page.

Subsequent authorized index-only migration: the token-index blocker was resolved without changing any business rows or runtime code. See [token-index-replacement.md](token-index-replacement.md) for the exact history, digest proof, tests and remaining iOS/mainline gates. Earlier pending-index statements above describe the initial deployment observation.
