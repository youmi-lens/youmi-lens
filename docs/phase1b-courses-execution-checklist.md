# Phase 1B · Courses — Manual Execution Checklist

For running the migration package by hand in the **Supabase SQL Editor**
(project `lbwsrnjbiayepshrdult`).

Work top to bottom. **Do not skip a step and do not run two steps in one paste.**
Every step names its own rollback point.

Baseline recorded at design time, from the production REST API:

| Fact | Value |
|---|---|
| `recordings` rows | **194** |
| distinct users | **17** |
| distinct normalized course names | **29** |
| courses the backfill will create | **36** |
| recordings that would stay Unfiled | **0** |
| normalization collisions | **0** |

If step 1 reports numbers materially different from these, the data moved since
design. That is not automatically a failure — but re-read CHECK 7/8/10 output
before continuing.

---

## Step 0 · Before you start

- [ ] Open the Supabase dashboard → **Database → Backups** and confirm a recent
      point-in-time backup exists.
- [ ] Note the current timestamp. Rollback needs it if PITR is ever used.
- [ ] Have `supabase-phase1b-courses-99-rollback.sql` open in a second tab.

**Rollback point:** nothing has changed yet.

---

## Step 1 · Pre-migration verification (READ ONLY)

**Command**
```
Paste and run the whole of: supabase-phase1b-courses-02-verification.sql
```

**Expected output** — ten result blocks.

| Check | Pass condition | Fail condition |
|---|---|---|
| 1 · columns | 27 rows; **no** `course_id`, **no** `updated_at`; `course` is `text`, `NOT NULL` | either column already present → **STOP**, report its type |
| 2 · courses absent | **0 rows** | any row → **STOP**, inspect before anything else |
| 3 · RLS state | `relrowsecurity = true` | `false` → **STOP**, isolation not guaranteed |
| 4 · policy text ★ | an **UPDATE** policy exists; `using_expr` and `with_check_expr` reference only `user_id` / `auth.uid()`, **no column list** | no UPDATE policy, or a column-restricted one → **STOP**. Paste the expression; the policy must be widened before Phase 4 can dual-write |
| 5 · indexes | no index named `recordings_user_course_idx` | name taken → **STOP** |
| 6 · constraints | PK is the single column `id`; no `recordings_user_course_fk` | composite PK, or FK name taken → **STOP** |
| 7 · dry-run | ~36 rows, names look like real courses | wildly different count → **STOP**, re-check 8 |
| 8 · collisions ★ | **0 rows** | any row → **STOP**. Do not backfill. Report user + colliding names |
| 9 · unfiled | any number (informational) | — |
| 10 · totals | **write the three numbers down** | — |

★ = the two checks that can independently block the whole phase.

**Rollback point:** nothing has changed. Close the tab and walk away.

---

## Step 2 · Migration

Only if **every** check in step 1 passed.

**Command**
```
Paste and run the whole of: supabase-phase1b-courses-01-migration.sql
```

**Expected output**
`Success. No rows returned.` Runtime well under one second.

**Pass condition**
No error. The statement block committed.

**Fail condition**
- `42P07 relation already exists` → step 1 check 2 was misread. **STOP.**
- `42710 constraint already exists` → a previous partial run. Re-run step 1 to
  see the actual state before deciding.
- Any permission error → you are not on the service/owner role. **STOP.**

**Rollback point:** run `99-rollback.sql`. Because this step only added a table
and two columns, rollback is complete and lossless.

---

## Step 3 · Structural validation

**Command**
```
Paste and run the whole of: supabase-phase1b-courses-04-post-validation.sql
```

**Expected output** — assertions A1–A7 and D1–D7.

| Assertion | Pass condition |
|---|---|
| A1 courses shape | `verdict = PASS`, 9 columns |
| A2 new columns | `verdict = PASS`, `course_id` nullable = **YES** |
| A3 legacy `course` intact ★ | `verdict = PASS` |
| A4 composite FK | `verdict = PASS`, definition contains `(user_id, course_id)` and `ON DELETE SET NULL` |
| A5 indexes | `verdict = PASS`, all three present |
| A6 RLS | `verdict = PASS`, `rls_enabled = true`, `policy_count = 4` |
| A7 policies row-scoped | each expression references `user_id` |
| D1 lecture count ★ | equals the number written down in step 1 check 10 (**194**) |
| D2 unlinked | **FAIL is expected here** — the backfill has not run yet |
| D3–D7 | `PASS` (trivially, with no courses yet) |

**Fail condition**
Any of A1–A7 failing, or **D1 differing from step 1** → **STOP and roll back
immediately.** A changed D1 means rows moved, which this migration cannot cause;
treat it as an incident.

**Rollback point:** `99-rollback.sql`.

---

## Step 4 · Backfill

Only if step 3's A-assertions all passed.

**Command**
```
Paste and run the whole of: supabase-phase1b-courses-03-backfill.sql
```

**Expected output**
`Success.` Two statements committed.

**Pass condition**
No error. Runtime under a second at this data size.

**Fail condition**
- `23505 unique violation` on `courses_user_active_name_key` → step 1 check 8
  was misread and two names collided. **STOP and roll back.**
- Any error mentioning a column other than `course_id` → **STOP immediately**
  and roll back; the script must never write another column.

**Rollback point:** `99-rollback.sql`. `recordings.course` was only read, never
written, so no course label can have been damaged.

---

## Step 5 · Data validation

**Command**
```
Re-run: supabase-phase1b-courses-04-post-validation.sql
```

**Expected output** — now everything must pass.

| Assertion | Pass condition | Fail condition |
|---|---|---|
| D1 lecture count ★ | still **194** | any change → **STOP, roll back, treat as incident** |
| D2 unlinked | `verdict = PASS`, `0` | non-zero → a course name failed to match; **STOP** |
| D3 orphans | `verdict = PASS`, `0` | non-zero → **STOP** |
| D4 duplicates | `verdict = PASS`, `0` | non-zero → **STOP** |
| D5 label vs row | `verdict = PASS`, `0` | non-zero → dual-write drift; re-run backfill step 2 |
| D6 inventory | ~36 rows; counts sum to 194; each user's courses have distinct icons | — |
| D7 delete rule | `verdict = PASS`, `0` | non-zero → **STOP** |

**Rollback point:** `99-rollback.sql`. Still fully lossless.

---

## Step 6 · Hand back to Desktop

- [ ] Paste the output of step 5 into the working session.
- [ ] Desktop then flips `CoursesRepository` from the derived (read-only)
      implementation to the Supabase implementation. **No architecture changes
      are required** — the interface, mappers, dual-write and fallback are
      already written and shipped behind
      `src/lib/courses/coursesRepositoryFactory.ts`.
- [ ] Run the Phase 6 end-to-end scenario list.

**Rollback point after this step:** rolling back the database now also requires
reverting the Desktop repository selection, because Desktop will be reading
`courses`. The factory falls back automatically if the table disappears, but do
not rely on that as a planned path.

---

## Emergency rollback — any step

```
Paste and run the whole of: supabase-phase1b-courses-99-rollback.sql
```

Then confirm its three trailing checks:

- `R1` total_recordings = **194**
- `R2` `verdict = PASS`, 0 rows missing a course label
- `R3` all three counters = **0**

If R1 or R2 fails, the rollback did not restore a clean state — stop and
escalate rather than re-running anything.
