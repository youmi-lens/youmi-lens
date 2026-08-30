# Phase 1C — System Audio capture (design only)

**Status: design. No native code exists and none is proposed for Phase 1B-1.**
Nothing in this document has been implemented. It records what was verified on
the real tree, what is still unproven, and which decisions are yours.

Scope: capture the audio macOS is *playing* (a lecture video, a Zoom call, a
recorded class) and caption it, instead of pointing the microphone at the
speakers.

---

## 1 · What is actually in the tree today

Verified by reading the repository and the built binary, not assumed.

| Fact | Value | How it was checked |
|---|---|---|
| Tauri | 2.10.3 | `src-tauri/Cargo.toml` |
| Native deps | `objc2 0.6`, `objc2-app-kit 0.3` (NSPanel overlay only) | `Cargo.toml` |
| Rust sources | `lib.rs`, `main.rs` — **no audio code at all** | `ls src-tauri/src/` |
| ScreenCaptureKit / CoreAudio / AVAudioEngine / cpal / virtual device | **none present** | repo-wide grep |
| Built binary min OS | **`minos 11.0`** | `otool -l …` → `LC_BUILD_VERSION` |
| Weak-linked frameworks today | **0** | `otool -l` → `LC_LOAD_WEAK_DYLIB` count |
| Entitlements | `com.apple.security.device.audio-input` only | `src-tauri/Entitlements.plist` |
| Signing | `Developer ID Application: Chenhe Zhang (VYB6732F9C)` | `tauri.conf.json` |
| `objc2-screen-capture-kit` crate | exists, `0.3.2` | `cargo search` |

**The current capture path is entirely inside the WebView:**

```
navigator.mediaDevices.getUserMedia()
        │
        ├── MediaRecorder ──────────────▶ durable lecture file (IndexedDB → upload)
        └── AudioContext ScriptProcessor ▶ Int16 PCM frames ▶ live caption engine
```

`src/hooks/useRecorder.ts` owns both branches. This single fact drives
everything below.

---

## 2 · The four capabilities, kept separate

The brief is right to insist these are not one feature:

1. **Capture the microphone** — shipped, works, must not regress.
2. **Capture system output audio** — the Phase 1C goal.
3. **Capture one specific application's audio** — SCK can filter by
   `SCRunningApplication`; explicitly out of scope for the first release.
4. **Mix microphone + system audio** — deferred. Two independent clock domains
   need a real resampler; getting it wrong produces double-speed or
   channel-swapped audio, and a broken mix is worse than no mix.

---

## 3 · macOS API reality

- **ScreenCaptureKit** first ships in **macOS 12.3**.
- **Audio capture** in SCK (`SCStreamConfiguration.capturesAudio`, the
  `.audio` output type) is **macOS 13.0+**.
- Therefore: on macOS 11.x the framework is *absent*; on 12.3–12.x it exists but
  cannot give us audio; from 13.0 it can.
- Screen Recording is a **TCC grant**, not an entitlement. There is no
  `NS…UsageDescription` key for it. The user grants it in
  System Settings → Privacy & Security → Screen Recording, and macOS prompts on
  first use. The app must handle "denied" as a normal state.

This is why the feature is macOS 13+ regardless of anything else.

---

## 4 · Can we keep `minos 11.0`? — probably yes, and it must be proven

You asked not to assume that using SCK forces the global deployment target up.
Checked rather than guessed:

**The mechanism exists.** macOS supports weak framework linking. With
`-weak_framework ScreenCaptureKit`, the load command becomes
`LC_LOAD_WEAK_DYLIB`; on a system where the framework is missing, its symbols
resolve to NULL and **the process still launches**. That is exactly the case we
need for macOS 11.

**What makes it workable here specifically:** objc2 reaches Objective-C classes
through the runtime, so a capability probe can be a plain
`NSClassFromString("SCStream") != nil` (plus an OS-version check for the audio
capability) before any SCK type is touched. No SCK symbol needs to be referenced
on an unsupported system.

**The catch.** `objc2-*` crates emit a *strong* `#[link(kind = "framework")]` by
default. Phase 1C would need a `build.rs` emitting
`cargo:rustc-link-arg=-weak_framework ScreenCaptureKit` and must then verify the
result — `otool -l` should show `LC_LOAD_WEAK_DYLIB` for ScreenCaptureKit and
`minos` should still read `11.0`.

**Unproven, and I could not prove it here.** This host is macOS 26.5. A
weak-link that is wrong does not fail at build time — it fails as a launch crash
on the old OS, which is the worst possible failure mode. Phase 1C must gate on a
real launch test on macOS 11 and macOS 12 (a VM is sufficient) **before** any of
it ships.

**Conclusion: runtime-gated macOS 13 support appears feasible and should be the
plan, contingent on that launch test.** Raising the global minimum is the
fallback, not the starting point.

---

## 5 · Two architectures, stress-tested

### Approach A — native capture owns the file, and streams PCM for captions

```
SCStream (audio only)
   ├── AVAudioFile / ExtAudioFile ──▶ durable .m4a on disk
   └── PCM frames ──▶ Tauri event/channel ──▶ existing live caption engine
```

**Holds up:**
- Never touches `getUserMedia`, so microphone recording cannot regress — the two
  paths do not share code.
- Produces a real local file, so recovery and pending-upload keep working in
  kind.
- PCM reaches the caption engine at the same layer the ScriptProcessor feeds
  today; the ASR/translation/upload pipeline is untouched.

**Costs, honestly:**
- A **second durable-write implementation** in Rust, parallel to
  `useRecorder`'s IndexedDB chunk writer. Two code paths must agree on session
  id, chunk durability, crash recovery and the pending-upload contract, or a
  system-audio recording is less safe than a microphone one. This is the single
  largest cost in Phase 1C and the main thing to design carefully.
- Upload needs to accept a file produced natively (container/codec must match
  what the pipeline already ingests).

### Approach B — native capture presents a media source to the WebView

Feed native PCM into the existing `MediaRecorder` path so nothing downstream
changes.

**This does not work, and should not be attempted:**
- `MediaRecorder` records a `MediaStream`. There is **no API to push samples
  into one.** The only synthetic sources are `canvas.captureStream()` (video)
  and `AudioContext.createMediaStreamDestination()` — and reaching the latter
  means getting PCM into an `AudioContext` from outside the page, which requires
  streaming every frame across the Tauri IPC boundary into a `Worklet` in real
  time.
- That is a per-frame IPC hot path in a WKWebView, with no back-pressure
  contract and a hard real-time deadline. It is precisely the "unstable hack"
  the brief rules out.
- It also puts the durable file behind an IPC channel that can stall, which
  weakens recording safety rather than preserving it.

**Recommendation: Approach A.** B is documented here so it is not re-proposed.

---

## 6 · Native service shape (design, not code)

A capture service with an explicit, small surface:

| Command | Returns |
|---|---|
| `system_audio_capability()` | `{ supported, reason, osVersion }` — the probe |
| `system_audio_permission()` | `granted \| denied \| undetermined` |
| `system_audio_start(sessionId)` | starts an audio-only `SCStream` |
| `system_audio_stop()` | finalises the file, returns its path + duration |

| Event | Payload |
|---|---|
| `system-audio://pcm` | frames + `{ sampleRate, channels, format, timestampNs, source }` |
| `system-audio://error` | `permission_denied \| unsupported_os \| source_lost \| stream_stopped` |

Non-negotiable properties:

- **`SCStreamConfiguration.capturesAudio = true` and NO video output attached.**
  The stream is created without an `.screen` output, so no frame is ever
  delivered, let alone stored. Only if this holds may the UI say the app does not
  see the screen — that claim has to be true in the code, not in the copy.
- **Exclude Youmi Lens' own audio** via `SCContentFilter`'s excluding-applications
  form, so the Overlay and the lecture player cannot feed back into the capture.
- Every failure is a named state with a recovery action. Permission denial opens
  System Settings and offers Microphone as the fallback the user chooses — never
  a silent downgrade.

**PCM contract:** one shape for both sources, so the caption engine has a single
input format — sample rate, channel count, sample format, monotonic timestamp,
and a `source` tag (`microphone` | `system`).

---

## 7 · Data model (prepared, not shipped)

```
key:      youmi.audioSource
values:   'microphone' | 'system'      // no 'mixed' until mixing exists
default:  'microphone'                 // upgrades never switch a user silently
```

Strict validation on read: anything unrecognised falls back to `microphone`.

**Session snapshot.** The value is frozen at recording start and travels with the
session — the durable session record, the pending-upload record and the recovery
record all carry it. A recovered recording must report the source it was actually
captured with, not whatever the setting says today.

---

## 8 · UI (design only)

- **Settings → Capture** — `Audio source: Microphone | System Audio`.
  System Audio is hidden entirely, not disabled, on macOS < 13.
- **Record Home** — one low-weight read-only line
  (`System Audio · English → 简体中文 · Bilingual`) plus a link to Settings. No
  configuration wall returns to Record Home.
- **Recording V2 header** — the active source as a quiet chip beside the course.
- **First selection of System Audio** — explain the Screen Recording grant, state
  plainly what is captured, link to System Settings, and give a recoverable
  action on denial.
- Six languages for all new copy, as with every other surface.

---

## 9 · Stop conditions for Phase 1C

Implementation halts and reports if it would:

- require a virtual audio driver or any third-party kext;
- break, or share mutable state with, microphone recording;
- bypass durable-recording safety, or fail to produce a recoverable local file;
- need entitlement or signing changes that have not been reviewed;
- receive or persist a single video frame;
- require a provider/protocol change;
- prove unable to keep macOS 11–12 launching, without an explicit decision from
  you to raise the minimum.

---

## 10 · Decisions needed before Phase 1C starts

1. **Weak-link and keep `minos 11.0`** (recommended), accepting that Phase 1C
   must include a real macOS 11 + 12 launch test — or raise the minimum to 13.0
   and drop those users?
2. **Accept a second, native durable-write path** for system-audio recordings,
   with the extra recovery surface that implies?
3. **System Audio alone in the first release**, with mixing deferred — confirmed?

Until 1–3 are answered, no native code should be written.
