# Youmi Lens

AI Lecture Companion for International Students  
留学生 AI 课堂辅助工具

> **This is the canonical Youmi Lens repository for Desktop / Web / Backend.**  
> The iPad / iOS client lives in
> **[youmi-lens/youmi-lens-ipad](https://github.com/youmi-lens/youmi-lens-ipad)**.

Youmi Lens is an AI-powered lecture learning tool for students. It records a
lecture, shows live captions with translation while the professor speaks, and
afterwards turns the recording into a transcript and bilingual (EN + ZH)
summaries that students can review later.

- Demo: <https://youtu.be/A8gJnwJlhC4>
- Website and downloads: <https://youmilens.com>
- Releases: <https://github.com/youmi-lens/youmi-lens/releases>

## Platforms

| Platform | Repository | Stack |
| --- | --- | --- |
| Desktop (macOS, Windows) / Web / Backend | **[youmi-lens/youmi-lens](https://github.com/youmi-lens/youmi-lens)** (this repo) | React + Vite, Tauri 2, Node API server |
| iPad / iOS | [youmi-lens/youmi-lens-ipad](https://github.com/youmi-lens/youmi-lens-ipad) | Expo / React Native |

Both clients share one account system and one backend (this repo's `server/`
and Supabase schema), so changes to APIs, entitlements or the database affect
the iPad app too. Check the sibling repo before changing a shared contract.

## What it does

- **Live captions and translation** while recording a lecture.
- **Lecture recording** with local safety (pending-upload recovery) and cloud sync.
- **AI processing**: transcription, then English and Chinese summaries.
- **Library**: courses and lectures organised per account, synced across devices.
- **Desktop app**: Tauri-based Mac/Windows app with signed in-app auto-update.
- **Website**: marketing site plus sign-in, registration and account pages.

## Repository structure

| Path | What lives here |
| --- | --- |
| `src/` | React + TypeScript frontend (shared by the web build and the Tauri app): `components/`, `lib/` (recording, live captions, AI client, billing), `hooks/`, `design-system/`, `youmi-watch/` (internal admin dashboard, access-gated server-side) |
| `src-tauri/` | Tauri 2 desktop shell (Rust), app/updater config, capabilities, icons |
| `server/` | Node.js API server (ES modules): auth, AI processing, quota/entitlements, Stripe and Apple IAP verification. Tests sit next to the code as `*.test.mjs` |
| `landing/` | Static website served at youmilens.com (no build step) |
| `supabase/`, `supabase-*.sql` | Database schema, migrations and rollbacks |
| `docs/` | Design notes, runbooks, updater and deployment documentation |
| `scripts/` | Release and tooling scripts (e.g. `check-versions.mjs`) |
| `.github/workflows/` | Manual-trigger desktop release / Windows build workflows |

## Development setup

### Prerequisites

- **Node.js 22** and npm
- **Rust** (stable, via [rustup](https://rustup.rs)) and the Tauri 2 platform
  prerequisites, only needed to run or build the desktop app
  (macOS: Xcode Command Line Tools)

### Install and run

```bash
npm ci                 # install dependencies
cp .env.example .env   # then fill in your own values (see below)

npm run dev            # local API server (port 3847) + web app (http://localhost:5173)
npm run dev:web        # web app only
npm run dev:server     # API server only
npm run dev:desktop    # Tauri desktop app (needs Rust)
```

In local development the Vite dev server proxies `/api` to the local Node
server. Packaged desktop builds do not: they need a remote API origin, see
[docs/tauri-desktop-trial-p0.md](docs/tauri-desktop-trial-p0.md).

### Environment variables

`.env.example` lists every variable with comments. `.env` is git-ignored.

- Frontend variables are prefixed `VITE_` and are **public** (they are bundled
  into the app). Examples: `VITE_SUPABASE_URL`, `VITE_API_BASE_URL`.
- Everything else is **server-only** and must never be committed, bundled or
  pasted into issues or PRs. Examples: `SUPABASE_SERVICE_ROLE_KEY`,
  `DASHSCOPE_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `APPLE_IAP_PRIVATE_KEY`.
- Use your own development Supabase project and test-mode keys. Ask the project
  lead for access to shared non-production resources; never use production
  credentials locally.

### Checks

```bash
npm run typecheck      # tsc -b
npm run lint           # eslint
npm test               # vitest (frontend + server tests)
npm run build          # type-check + production web build
npm run release:check  # version sync + typecheck + tests + build
```

Run the checks relevant to your change before opening a PR.

## Development workflow

```
Issue / task → dedicated branch → implementation → tests → Pull Request → review → Squash merge
```

- `main` is protected by repository rules: changes go through a Pull Request and
  are squash-merged. **Do not develop directly on `main`** and **never force-push
  it**.
- **One task, one clear owner.** Keep each PR scoped to its assigned task.
- Create a branch per task (for example `feat/…`, `fix/…`, `docs/…`).
- Run the relevant checks locally before opening the PR, and describe what you
  tested in the PR.
- Product and engineering direction is coordinated by the project lead.
  High-risk changes (below) get additional review before merging.

> **Heads-up:** pushes to `main` deploy automatically. The backend (`server/`)
> redeploys on Railway and the website (`landing/`) redeploys on Cloudflare
> Pages. Treat every merge to `main` as a production release.

## High-risk areas

Take extra care, add tests, and request extra review when touching:

- Recording and audio durability
- Billing: Stripe, Apple StoreKit / IAP, subscriptions
- Entitlement and quota logic
- Authentication
- Database schema and migrations (`supabase*`), which are shared with the iPad app
- Production infrastructure and environment configuration
- Release signing, notarization and updater keys (`src-tauri/`, release workflows)

Never commit credentials, signing keys, service-role keys or production data.

## Contributing

There is no separate `CONTRIBUTING.md` yet; the workflow above is the
contributor guide. Open an issue or ask the project lead before starting
anything large or touching a high-risk area.

## For users 使用说明

- Download the latest build from <https://youmilens.com> or the
  [Releases](https://github.com/youmi-lens/youmi-lens/releases/latest) page
  (macOS Apple Silicon, Windows 10/11).  
  最新版本请到 <https://youmilens.com> 或 Releases 页面下载。
- Open Youmi Lens, click **Start** to begin recording, follow the live captions,
  and generate summaries after the lecture.  
  打开应用，点击 **Start** 开始录制，查看实时字幕，课后生成总结。

<details>
<summary>macOS shows “Youmi Lens is damaged and can’t be opened” (older beta builds only)</summary>

Early beta builds (v0.1.7-beta and earlier) were not notarized, so Gatekeeper may
block them. 早期测试版（v0.1.7-beta 及更早）未经 Apple 公证，可能被系统拦截。
Run these in Terminal (you may be asked for your Mac password):

```bash
sudo xattr -dr com.apple.quarantine "/Applications/Youmi Lens.app"
codesign --force --deep --sign - "/Applications/Youmi Lens.app"
sudo xattr -cr "/Applications/Youmi Lens.app"
open "/Applications/Youmi Lens.app"
```

</details>

Status: beta, under active development. 测试版本，持续优化中。

Feedback 反馈: youmilens@gmail.com
