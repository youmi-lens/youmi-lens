# Youmi Lens Desktop — In-App Auto Update (Phase 2E)

Official **Tauri v2 updater** for Mac + Windows. Users no longer re-download the
installer for every release: the app checks for a newer signed release, shows
release notes, downloads in-app with progress, and installs on restart —
preserving account, recordings, **pending uploads**, settings, and local data.

## Architecture (smallest reliable path)

- **Hosting:** GitHub Releases + a static, signed `latest.json` manifest.
- **Endpoint** (`src-tauri/tauri.conf.json` → `plugins.updater.endpoints`):
  `https://github.com/youmi-lens/youmi-lens/releases/latest/download/latest.json`
- **Signature verification is mandatory** (Tauri refuses unsigned/mismatched
  updates). No unsigned fallback. HTTPS only. Downgrade is prevented (an update is
  offered only for a strictly newer semver — see `src/lib/updater/updaterCore.ts`).
- **Plugins:** `tauri-plugin-updater` + `tauri-plugin-process` (Rust, registered
  desktop-only in `src-tauri/src/lib.rs`); `@tauri-apps/plugin-updater` +
  `@tauri-apps/plugin-process` (JS, wrapped by `src/lib/updater/useUpdater.ts`).
- **Capabilities:** `updater:default`, `process:allow-restart`
  (`src-tauri/capabilities/default.json`).
- **Artifacts:** `bundle.createUpdaterArtifacts: true` produces the updater
  bundles + `.sig` files. Mac: `.app.tar.gz` (+ `.sig`). Windows: NSIS
  `-setup.nsis.zip` (+ `.sig`) — NSIS is the configured installer.

### `latest.json` shape (produced by the release workflow)

```json
{
  "version": "0.1.9",
  "notes": "Long-recording reliability fixes; durable pending-upload recovery.",
  "pub_date": "2026-07-24T00:00:00Z",
  "platforms": {
    "darwin-aarch64": { "signature": "<sig>", "url": "https://github.com/.../Youmi.Lens_0.1.9_aarch64.app.tar.gz" },
    "darwin-x86_64":  { "signature": "<sig>", "url": "https://github.com/.../Youmi.Lens_0.1.9_x64.app.tar.gz" },
    "windows-x86_64": { "signature": "<sig>", "url": "https://github.com/.../Youmi.Lens_0.1.9_x64-setup.nsis.zip" }
  }
}
```

The plugin picks the entry matching the running target — a Mac user is never
offered a Windows package or vice-versa.

## Updater signing keys (REQUIRED before first updater release)

Tauri updater signatures are separate from Apple/Windows code signing.

1. **Generate once** (keep forever — losing it means users can't auto-update):
   ```
   npx tauri signer generate -w ./youmi-updater.key
   ```
   This writes the **private** key to `./youmi-updater.key` and prints the
   **public** key.
2. **Public key → repo:** paste it into `src-tauri/tauri.conf.json` →
   `plugins.updater.pubkey`, replacing `UPDATER_PUBLIC_KEY_PLACEHOLDER_...`. The
   public key is safe to commit.
3. **Private key → secrets only (never commit):**
   - GitHub Actions secrets: `TAURI_UPDATER_PRIVATE_KEY` (file contents) and
     `TAURI_UPDATER_KEY_PASSWORD`.
   - `.gitignore` already blocks `*.key` and key material.
4. **Backup & recovery:** store the private key + password in the team password
   manager and an offline backup. There is no rotation path that keeps existing
   installs updatable — **do not rotate casually**. If rotated, every user must
   do one more manual install with the new public key baked in.

Apple Developer ID signing/notarization is **unchanged** (identity
`Developer ID Application: Chenhe Zhang (VYB6732F9C)`, `Entitlements.plist`); the
updater artifact must remain signed + notarized so Gatekeeper stays quiet.

## Version synchronization (single source of truth)

`package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` must all
carry the same version. `scripts/check-versions.mjs` (also `npm run check:versions`)
fails release prep if they disagree, and `--tag vX.Y.Z` validates the release tag.
Phase 2E corrected `package.json` from the stale `0.0.0` to the real `0.1.8`.

## Recording-safety rule (hard requirement)

Install/restart is **blocked** while a lecture is `recording`, `paused` (unfinished),
or a Stop&Save is in flight (`canInstallUpdate` in `updaterCore.ts`, wired from
`recorder.status` + `saveOrFinishBusy`). The update stays ready; the user is told to
finish saving first. Durable pending uploads survive a restart, so they never block.

## UX

Lower-left sidebar entry (`src/components/UpdaterEntry.tsx`): muted `Youmi Lens vX.Y.Z`
when up to date; an "Update available / Downloading… N% / Restart to update /
Update failed — Retry" chip when actionable. Click → compact modal with current
version, new version, release notes, and Download / Install and restart / Later
(+ Check for updates). Startup runs one bounded, non-blocking silent check; a
temporarily-unavailable service shows no error.

## Existing-user rollout

- **Current production is v0.1.8 with NO updater** (no plugin, no pubkey, no
  endpoint). **Existing users cannot auto-update.** They must **manually install
  the first updater-enabled release once** (from youmilens.com). All later
  releases update in-app.
- **A. Updater-enabled users:** see the in-app "Update available", click, restart.
- **B. Pre-updater (v0.1.8) users:** one manual download of the first
  updater-enabled build (e.g. v0.1.9); auto-updates thereafter.
- **C. Website:** always hosts the latest full installer with visible version +
  date; add a one-time notice for the first updater-enabled release.
- **D. Emergency:** the update notes/manifest can flag a critical fix; never
  force-restart during recording. Mandatory/minimum-version enforcement is a
  future, explicitly-approved option (not enabled now).

## Release workflow

`.github/workflows/release-desktop-draft.yml` (manual, **draft-only**,
`dry_run: true` default): version gate → tests → `tauri-action` builds + **signs**
Mac + Windows updater artifacts, produces `latest.json`, and (only when not
dry-run) uploads to a **draft** release for human review. Old releases are kept
(rollback). Publishing the draft + updating website links are separate reviewed
steps — **not automated here**.

## Manual runtime verification (Mac; not runnable in CI/headless)

1. Generate keys (above); set `pubkey`; bump version to N.
2. Build N (signed+notarized), install, run.
3. Bump to N+1, build+sign, publish as a **draft/prerelease** `latest.json`.
4. In N: confirm lower-left "Update available" appears; open modal → notes + N+1.
5. Download → progress; **start a recording and attempt Install → confirm it is
   blocked** with the finish-saving message; stop & save; Install and restart.
6. Confirm the app reports N+1; login, settings, recordings, and **pending
   uploads** remain; no duplicate app; no Gatekeeper/signature warning.

**Windows:** verify the workflow/config on a real Windows machine (NSIS updater
`.nsis.zip` + `.sig`, install-over, user data preserved). Do not claim Windows
runtime PASS without a real Windows test.
