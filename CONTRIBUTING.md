# Contributing to Youmi Lens

This repository, **[youmi-lens/youmi-lens](https://github.com/youmi-lens/youmi-lens)**,
is the **Desktop / Web / Backend** side of Youmi Lens.
The iPad / iOS client lives in
**[youmi-lens/youmi-lens-ipad](https://github.com/youmi-lens/youmi-lens-ipad)**.
The two repositories share one backend and one account system, and follow the
same collaboration rules described here (the iPad repo has its own
`CONTRIBUTING.md` with the same workflow). Setup and check commands differ, so
use each repository's README for those: see [README.md](README.md).

Youmi Lens is maintained by a small team. The goal of this guide is a workflow
that is short enough to actually follow.

## The workflow

```
Issue / task → one owner → dedicated branch → develop → self-test → push
→ Pull Request → automated checks (where available) → human review
→ Squash and merge → delete the branch
```

### Convention vs. what GitHub enforces

Be clear about which is which. Do not assume a safety net exists.

**Enforced by GitHub** (ruleset "Protect main", no bypass list):

- Changes reach `main` only through a Pull Request. Direct pushes are rejected.
- Force-pushes to `main` are blocked.
- `main` cannot be deleted.
- Squash is the only allowed merge method.

**Team convention only (not enforced; we rely on each other):**

- Having a human review before merge. GitHub does **not** currently require an approval.
- Passing checks. No status check is required, and this repository's GitHub
  Actions workflows are manual-trigger only, so a PR gets no automatic CI beyond
  the Cloudflare preview build. Running the checks is the author's job.
- One owner per task, branch naming, keeping PRs scoped, and extra review for
  high-risk areas.
- Deleting the branch after merge.

## 1. Task ownership

- Every meaningful task has **one clear owner** (DRI). One task, one primary owner.
- Others may review, discuss or help, but should not independently modify the
  same active work without coordinating with the owner.
- Before starting significant work: confirm the task, the owner and the scope,
  and check that nobody else is already working on the same area.
- Use GitHub Issues for bugs and features worth tracking. Don't add process for
  trivial documentation changes.

## 2. Never develop directly on `main`

`main` is the integration branch, not a working branch. For each task:

```bash
git switch main && git pull --ff-only
git switch -c fix/short-description
```

Make scoped changes on that branch, push it, and open a PR against `main`.
Never force-push `main`, delete it, or try to bypass the repository rules.

## 3. Branch naming

Use `<type>/<short-description>`; no personal names needed:

`feat/`, `fix/`, `docs/`, `refactor/`, `test/`, `chore/`

Examples: `feat/lecture-search`, `fix/notebook-image-resize`,
`docs/update-contributing`, `test/recording-recovery`.

## 4. Keep changes scoped

One PR solves one coherent problem. Don't mix in unrelated cleanup, formatting,
refactoring or features. If you find another problem, record it (an Issue or a
note to the task owner) instead of silently expanding the PR. Prefer the
smallest safe change that solves the problem.

## 5. AI-assisted development

We use AI coding tools (Claude Code, Codex and similar). AI-generated changes
meet **exactly the same standards** as human-written ones, and the human task
owner is responsible for the resulting PR.

Agents should: understand the assigned scope first; read the existing
implementation before editing; prefer root-cause fixes to speculative ones; keep
changes minimal; run the relevant validation; and report what changed, what was
tested and what was **not** verified. They must never claim a physical or device
verification that didn't happen.

Autonomy is not permission to: modify unrelated code, push to `main`, bypass
review, silently change production configuration, expose secrets, or perform
unrelated refactors.

## 6. Validate before opening a PR

Run the checks that are relevant to what you changed. The actual commands live
in the [README](README.md#checks) and in `package.json`; don't invent others.
Depending on the change that may mean tests, type-checking, linting, a build, or
targeted regression tests.

- If you couldn't run a check, say so in the PR.
- Never write "all tests pass" unless you ran them and they did.
- Be precise about the state of behavior you can't fully test automatically
  (recording, device or OS-specific behavior). These are **not** equivalent:
  `CODE FIXED` · `AUTOMATED PASS` · `BUILT` · `DEPLOYED` · `PHYSICALLY VERIFIED`.

## 7. Pull requests

A good PR description covers:

- **What** changed and **why**
- **Scope** (what is deliberately not included)
- **Validation** performed
- **Known limitations** and anything **not verified**
- Screenshots or video for UI changes
- The related Issue or task

Reviewers look at: scope, correctness, unintended changes, test evidence,
security and privacy implications, and whether the behavior matches the intended
product.

A red check normally blocks the merge until its root cause is understood. Don't
blindly retry or bypass a failing check; if a failure is unrelated or caused by
infrastructure, write down why before proceeding.

## 8. Merging

Use **Squash and merge** (the only method the repository allows). After merging,
confirm the PR shows as merged and **delete the feature branch**.

> **Merging to `main` deploys.** Pushes to `main` automatically redeploy the
> backend (`server/`, Railway) and the website (`landing/`, Cloudflare Pages).
> Treat every merge as a production release.

## 9. High-risk areas

These need stronger validation and review by the project lead before merge or
release, as appropriate:

- Recording and audio durability
- Payments: Stripe, StoreKit / IAP
- Entitlement and quota logic
- Authentication
- Database schema and migrations (shared with the iPad app)
- Production infrastructure and environment configuration
- Apple signing, notarization, updater keys and release configuration
- Destructive data operations
- Core AI processing architecture

You may work on these areas when assigned. This isn't about who is allowed to
write the code; it's about reviewing and testing harder. Note that GitHub does not
enforce this review, so it's on the author to ask for it.

## 10. Production safety

Never commit API keys, private keys, service-role credentials, signing
credentials, passwords, production tokens, certificates, or anything from a
local `.env`. Don't change production infrastructure or data as a side effect of
an unrelated task. Production changes must be intentional and called out
explicitly in the PR.

## 11. Communication

| For | Use |
| --- | --- |
| Real-time discussion | Team chat |
| Trackable work | GitHub Issues |
| Code discussion and review | Pull Requests |
| Long-lived engineering and process docs | Repository documentation |

Don't leave important technical decisions only in chat history. When a chat
produces a concrete task, move it into GitHub.
