# Seeker caption-editor disappearance and architecture audit

**Status:** ACTION REQUIRED  
**Audit date:** 2026-08-27  
**Repository:** `Hatsunama/Caption-Studio`  
**Audited base:** `main` at `3801109504ce75ba91d5355c903ea52017b367d5`  
**Affected release:** Caption Studio `1.4.1`, Android `versionCode 13`  
**Observed device:** Solana Mobile Seeker, Android 16 / API 36  
**Change type:** report only; this commit does not alter runtime behavior

## Executive decision

Do **not** treat release 1.4.1 as proof that the long-video disappearance is fixed.

The latest change is directionally useful: it lowers configured `expo-video` buffer ceilings, shortens transition preloading, and loads transition sources sequentially. It does not establish a process-memory ceiling and it does not cover the state in which the user is actually editing subtitles.

The highest-confidence failure chain is:

1. The playhead is at or shortly before a composite transition.
2. `VideoTransitionOverlay` mounts a composite preview containing two `useVideoPlayer` instances and two `VideoView` texture surfaces.
3. The editor's main `VideoView` and main `VideoPlayer` remain mounted.
4. Opening the full-screen script editor pauses playback but leaves `currentMs` at the same transition preload position.
5. Because the transition eligibility condition remains true, the two auxiliary players remain mounted and loaded beneath the modal while the keyboard and subtitle editor allocate additional UI and JavaScript state.
6. Depending on the video's codec, resolution, frame surfaces, device pressure, and prior player churn, Android may terminate the process or a native media component may crash.

This chain explains why the symptom appears random: the effective native footprint depends on playhead position and media characteristics, not only on video duration.

The exact exit class is still unproven. It may be a low-memory kill, Java `OutOfMemoryError`, native media/graphics crash, ANR, or unrelated process exit. One Seeker `ApplicationExitInfo` record plus crash-buffer logcat is the next evidence gate.

A separate data-integrity defect is already proven: both subtitle-editing modals keep unsaved text only in React component state. Any process death discards all edits made since the modal opened.

## Release disposition

Treat the incident as a **release blocker for any build described as fixing the disappearance** until all P0 gates in this report pass on the Seeker.

A normal release containing unrelated work may proceed only with an explicit known-issue decision. It must not claim the crash is resolved.

## Scope

This audit covered the failure path and adjacent ownership boundaries:

- main editor composition and lifecycle;
- timeline video and audio controllers;
- transition-preview admission, preload, source replacement, and views;
- caption and dual-caption editing;
- caption rendering and timeline update paths;
- project persistence and process-death recovery;
- background-removal consent and native preview lifecycle;
- Android media URI permission ownership;
- release configuration and CI gates;
- auth, entitlement, provider, security, and privacy boundaries;
- the files changed by `Prevent long-video transition preview crashes`.

This was a static repository and CI audit. No Seeker tombstone, exit record, bug report, memory trace, or exact source-video metadata was available.

## Root-cause confidence

| Hypothesis | Confidence | Evidence | What would confirm or reject it |
|---|---:|---|---|
| Native/process memory pressure from simultaneous video players and surfaces | High | One main player plus two transition players; all three views can be resident; modal does not suspend auxiliary media; existing Expo Android OOM history for multiple players | `ApplicationExitInfo` reports low memory, memory limiter, crash, or native crash; logcat reports OOM/MediaCodec/graphics failure; PSS grows around transition/modal cycles |
| Native resource churn from transition-key remounts and in-flight source replacement | Medium-high | Composite preview is keyed by transition; rapid cross-transition scrubbing destroys and recreates hook owners while native cleanup is asynchronous from the app's perspective | Repro frequency tracks transition hopping; codec/player counts fail to return to baseline; stable coordinator removes failure |
| JavaScript/UI pressure from the 20 Hz screen clock and long-caption allocations | Medium | `currentMs` is screen state; a 98 KB screen and major descendants are eligible to rerender; caption lookup and timeline scans scale with project size | Hermes/JS stack, ANR, profiler, render counts, or heap profile identifies this path |
| Native person-compositor pressure | Low unless background removal is enabled | Native bitmap allocation can be large, but preview work is serialized and only one newest pending request is retained | Failure occurs only with background replacement enabled; native stack identifies bitmap/segmentation path |
| Lost `content://` permission or unavailable provider | Low | Import persists URI grants and release is ledgered; source validation reports an error rather than intentionally exiting | Logcat reports `SecurityException`, provider death, or unreadable source immediately before exit |
| Intentional navigation/activity finish | Low | No normal subtitle-edit path calls exit; modal close is guarded | Activity/navigation logs show `finish`, back dispatch, or route removal without process death |

## Confirmed findings

### P0-01 — The disappearance is not classified

There is no app-owned diagnostic path for historical process-exit reasons, and CI cannot distinguish:

- Java/Kotlin crash;
- native crash;
- ANR;
- low-memory kill;
- excessive resource use;
- user/OS/package termination;
- activity navigation without process death.

Android provides `ApplicationExitInfo` for this purpose. The app currently restarts without recording or presenting the previous process's exit reason.

**Required correction**

Create a small provider module separate from `caption-media`, for example `modules/caption-diagnostics`, that exposes sanitized local-only metadata from `ActivityManager.getHistoricalProcessExitReasons()`:

- timestamp;
- reason and status;
- process importance;
- last sampled PSS/RSS when available;
- sanitized system description;
- app version and versionCode;
- a bounded app-owned process-state summary containing only non-sensitive state.

Do not include project names, caption text, media URIs, file names, or model prompts. Store a bounded local ring buffer and expose an explicit user action to save/share a sanitized diagnostic package. Do not add analytics or automatic upload.

### P0-02 — Unsaved subtitle edits are volatile

`src/components/editor/script-editor.tsx` initializes all edits in modal-local `draftCaptions` and writes to the project only when Save is pressed.

`src/components/editor/dual-caption-editor.tsx` keeps both subtitle columns in modal-local `drafts` and writes only when Save is pressed.

A process death bypasses `beforeRemove`, component cleanup, Save, and discard prompts. Every unsaved subtitle edit in either modal is lost.

**Required correction**

Add a durable, local edit journal:

- debounce journal writes while typing;
- key by project ID, editor kind, and a base project revision;
- include the minimum caption draft necessary to restore text, splits, merges, and focused row;
- clear only after the corresponding project update is durably committed or the user explicitly discards it;
- on reopen, restore automatically when the base revision matches;
- present a conflict/recovery choice when the base revision changed;
- include a process-death integration test.

The journal contains private subtitle content and must remain in app-private storage with backup disabled.

### P0-03 — Full-screen editors do not own a media suspension boundary

Opening Script Editor, Dual Caption Editor, Font Browser, Scope Sheet, or the text-layer modal does not unmount or suspend the preview tree beneath the modal.

The Script Editor path pauses the transport, but pause is not release or deallocation. If `currentMs` remains in a transition preload window, the composite transition hook stays mounted with both sources loaded for the entire editing session.

`useTimelineAudioController` likewise keeps players for audio clips active at the frozen playhead, although they are paused.

**Required correction**

Add one application-level runtime policy with these inputs:

- React Native `AppState`;
- screen focus;
- any blocking/full-screen modal open;
- export/transcription state;
- current transition eligibility;
- background-removal state.

It must produce explicit resource-admission decisions for main playback, auxiliary transition preview, timeline audio, and person preview.

At minimum, before showing a full-screen editor or when the app is not active:

- pause transport;
- unmount the transition-preview hook owner so Expo performs documented hook cleanup;
- synchronize timeline audio to no targets and dispose inactive players;
- cancel/release person preview work and files;
- prevent new `replaceAsync` calls until active again.

Do not manually call `release()` on players created by `useVideoPlayer`; Expo SDK 57 documents that the hook owns disposal on unmount. The app should control whether the hook owner is mounted.

### P1-01 — The current transition path can hold three video players and three texture surfaces

`src/app/editor.tsx` always mounts the main `VideoView` with `surfaceType="textureView"`.

`src/components/editor/video-transition-overlay.tsx` mounts two additional `VideoView` instances for composite transitions. Both also use `textureView`.

The latest policy caps configured compressed/read-ahead buffers at 24 MiB for the main player and 12 MiB for each transition player. That does not cap:

- decoded YUV/RGB frame surfaces;
- MediaCodec allocations;
- ExoPlayer/native objects;
- TextureView/SurfaceTexture buffers;
- GPU textures;
- Java and native heaps;
- source extractor state;
- simultaneous `replaceAsync` work;
- React Native view and keyboard memory.

**Required correction**

Instrument actual active player/view/source counts and process memory. Prove the minimum design needed for composite preview.

First acceptance target:

- one main player outside composite transition preview;
- zero auxiliary video players while a blocking modal is open or app is inactive;
- no growth in player/view count after repeated transition entry/exit;
- no overlapping source-load operations per player.

Then evaluate whether the transition can use the main player plus one auxiliary player, or temporarily detach/suspend the main preview while a dedicated transition pair is active. Do not mandate that redesign without device proof.

Expo's versioned documentation states that `surfaceView` should be used in most Android cases because it has better performance and lower power use; `textureView` is appropriate when overlapping video views require it. Benchmark a main-view `surfaceView` path outside composite transitions rather than assuming all preview states require texture surfaces.

### P1-02 — Transition-key remounting creates native allocation churn

`VideoTransitionOverlay` returns:

```tsx
<CompositeVideoTransitionOverlay key={preload.key} {...props} />
```

Crossing between transition keys destroys one hook owner and creates another. Expo owns final disposal, but the app immediately creates the next pair without proving that native player, codec, and surface resources returned to baseline.

The generation flags in `use-video-transition-preview.ts` suppress stale JavaScript publication. They do not cancel a native `replaceAsync` already executing and they do not prove resource reclamation.

**Required correction**

Use a stable transition-preview coordinator:

- create the window list once, not in both parent and child;
- keep one stable hook owner while preview is admitted;
- model `idle`, `loading-outgoing`, `loading-incoming`, `ready`, `suspended`, and `error` explicitly;
- use last-request-wins source intent;
- serialize source replacement;
- prevent a new transition load until the current operation reaches a safe boundary;
- record bounded local counters for player creation, view mount, replacement start/end, and suspension;
- add a stress test that scrubs across many adjacent transition boundaries.

### P1-03 — The “48 MiB budget” test is false runtime assurance

`tests/video-playback-policy.test.mjs` is named as if editor playback has a bounded Android memory budget. It only adds three `maxBufferBytes` configuration values.

That is a configuration contract, not a process-memory test.

**Required correction**

Rename the test and assertion language to “configured player buffer ceilings.” Add a comment only if needed to prevent future misuse; do not claim total memory is bounded.

Add real device evidence:

- process PSS/native heap before and after warm-up;
- player/codec/view counts;
- repeated transition and modal cycles;
- exit reason after failure;
- no monotonic growth after cleanup opportunities.

### P1-04 — A source-text test substitutes for lifecycle behavior

`tests/editor-logic.test.mjs` reads implementation source and asserts that teardown text does not contain player methods.

This protects against one previously unsafe pattern, but it is brittle and does not prove:

- hook-owned players are unmounted at the correct time;
- auxiliary players stop being admitted under a modal/background state;
- native resources are reclaimed;
- stale source replacements cannot publish or remain active;
- no process death occurs.

It can also reject a legitimate future app-level `pause()` performed before unmount, even though the real ownership rule is “do not manually release or use an already released hook-owned player.”

**Required correction**

Retain a narrow contract test for hook ownership only if useful, but replace source slicing/regex as the primary gate with tests against a pure resource-state machine and Android integration/device evidence.

### P1-05 — A 20 Hz playback clock is owned by the 98 KB editor screen

The timeline player emits updates every 50 ms. `EditorWorkspace` stores `currentMs`, so the screen-level component and its broad dependency graph are eligible to rerender on every update.

That graph includes preview overlays, caption resolution, translation-pair derivation, timeline props, tools, and modal elements. React Compiler can reduce work, but it is not an architectural isolation boundary and should not be treated as one.

**Required correction**

Create a playback island/controller:

- keep the high-frequency clock out of the full editor screen;
- expose low-frequency presentation time separately from frame/word timing;
- subscribe only the preview overlay and playhead to high-frequency updates;
- update labels/tool panels at a lower cadence;
- measure render counts on long-caption projects.

### P1-06 — Caption rendering contains avoidable project-size scans

`CaptionOverlay` repeatedly searches the complete transcription word array by ID and performs additional index/style resolution while the clock advances.

`LayerTimeline` filters/maps project arrays and scrolls in response to the same screen clock.

`ScriptEditor` maps the complete caption draft array for every text change.

None is sufficient alone to prove the disappearance, but together they increase allocation and CPU pressure exactly when long projects are edited.

**Required correction**

- precompute `Map<wordId, word>` once per transcription revision;
- build memoized caption render models;
- index timeline ranges and use binary search/windowing;
- isolate playhead motion from full timeline rerenders;
- store script drafts by ID/order so a keystroke updates one record rather than mapping the entire array;
- profile before and after on the same long project.

### P1-07 — Project writes are ordered but not coalesced

`src/services/database.ts` serializes each project write, which protects ordering. Each call first `JSON.stringify`s the complete project and queues every intermediate snapshot.

A burst of background saves can retain multiple serialized project snapshots and promises. A process death also terminates pending writes.

**Required correction**

Add an application-layer `EditorWriteCoordinator` above the database:

- one running write plus at most one latest pending revision;
- monotonic revision IDs;
- explicit `dirty`, `saving`, `saved`, and `failed` state;
- `flush()` for explicit save and app-background transitions;
- durable edit journal as the process-death backstop;
- never coalesce across a destructive boundary that requires a specific durable checkpoint.

The database should continue to own atomic storage and write ordering. It should not own editor intent or UI dirty-state policy.

### P1-08 — `editor.tsx` is a god screen with leaked application responsibilities

`src/app/editor.tsx` is approximately 98 KB and currently owns or coordinates:

- route loading and source validation;
- project runtime truth;
- media ownership and URI-permission ledgers;
- persistence errors and durable/optimistic commits;
- undo/redo memory policy;
- video and audio transport;
- transition resource admission through rendering;
- caption generation and cancellation;
- translation synchronization;
- background-processing disclosure flow;
- person-preview scheduling;
- export orchestration;
- save/discard exit policy;
- nearly all editor presentation.

This makes it difficult to prove lifecycle behavior because UI state, domain mutations, provider calls, and resource policy are interleaved.

**Required correction**

Introduce an application-layer editor session, not a global state framework for its own sake:

- `EditorSessionController`: project revision, dirty state, undo/redo, durable save/discard, media ledger, draft journal;
- `EditorRuntimePolicy`: app/modal/focus state to resource admission;
- `PlaybackCoordinator`: main timeline intent and source synchronization;
- presentation components that render state and dispatch intents;
- pure domain functions remain in `src/lib`.

Split by responsibility and test boundary, not by arbitrary file length.

### P2-01 — Timeline audio remains allocated under blocking modals

`TimelineAudioPlaybackController` correctly disposes players when targets disappear. Pausing at a static playhead does not make the active target disappear, so paused audio players can remain loaded while a subtitle modal is open.

Include audio in the runtime suspension policy by synchronizing an empty target list while a blocking modal is visible or app is inactive.

### P2-02 — Native memory-pressure callbacks are not connected to editor policy

The custom media module releases resources in normal completion and module destruction, and person-preview requests are serialized. No app-specific path was found that responds to Android memory-trim callbacks by releasing reconstructible editor resources.

After P0 fixes, add a provider-to-application memory-pressure signal. At minimum, trim person-preview files/bitmaps and suspend optional preview work when UI is hidden or pressure is reported. Do not attempt to control Expo's internal player disposal from `caption-media`.

### P2-03 — CI proves build/release integrity, not runtime stability

The release workflow is strong in these areas:

- pinned actions;
- locked dependency installation;
- production dependency audit;
- TypeScript, lint, and logic tests;
- clean Android prebuild;
- native release unit tests;
- signed APK/AAB production-identity checks;
- target SDK 36;
- 16 KiB ELF alignment;
- release signing and debug-key rejection.

It has no Android instrumentation test, emulator lifecycle test, player stress test, memory test, process-death recovery test, or Seeker hardware gate.

**Required correction**

Add unit/integration gates in CI and retain a documented physical-Seeker acceptance gate for codec/memory behavior that emulators cannot prove.

## Layer-ownership audit

| Layer | Correct responsibility | Current result | Required movement |
|---|---|---|---|
| Presentation (`src/app`, `src/components`) | Render state, collect user intent, accessibility, display errors | **Violation:** editor screen owns session persistence policy, media ledgers, exit workflow, and native resource admission | Move session, write, and runtime policy to application controllers |
| Domain (`src/lib`) | Pure project/caption/timeline transformations and validation | Mostly correct | Keep pure. Move provider-specific player configuration out of generic domain naming into runtime/playback policy |
| Application services (`src/services`, controller hooks) | Use-case orchestration, transactions, cancellation, resource admission, durable boundaries | Partially present and generally good, but no unified editor session/runtime coordinator | Add editor session, runtime policy, coalesced writer, and draft journal |
| Persistence provider (`database`, preferences, private files) | Atomic local reads/writes and schema migration | Correct WAL and ordered write foundation; no journal/coalescing | Keep atomic store; add journal schema and application-controlled coalescing |
| Media/provider adapters (`caption-media`, Expo wrappers, Android URI permissions) | Translate app intent to native/provider APIs and fail closed | URI permission ledger and background consent enforcement are good; transition player admission remains in UI | Wrap playback admission in a coordinator; keep native implementation behind adapters |
| Security/privacy policy | Consent, input distrust, no automatic disclosure/upload | Good service-side background-processing gate and local-first policy | Diagnostics must be local, bounded, sanitized, and explicit-share only |
| Auth/entitlement | Account identity, paid feature authorization, provider credentials | **Not applicable:** no account, purchase, or entitlement subsystem was found | Do not add or invent one for this incident |
| Release system (`app.json`, scripts, CI) | Version identity, permissions, signing, target SDK, reproducibility | Strong and correctly release-owned | Add runtime acceptance evidence; stop using source-text/config tests as crash proof |

## Security, provider, auth, and entitlement conclusions

### Security decisions

The background-removal consent decision is enforced in service entry points, including preview/export paths. The UI is not the only gate. This is correct fail-closed ownership.

Android persisted-read permissions are acquired during import and released through a durable retry ledger only after project-reference checks. This is also correctly service-owned.

The app blocks cloud backup for private project state and does not request broad modern storage access. Keep these boundaries unchanged.

### Provider logic

Document-picker and native media-provider operations are in services/native modules rather than caption components. No provider credential or network-transcription logic was found in the editor UI.

The transition overlay is the exception: presentation currently decides when two native player providers exist. That decision belongs to runtime policy/controller code.

### Auth and entitlement

No auth, account, purchase, subscription, or entitlement dependency/system is present. No leaked entitlement rule was found. This audit records that as not applicable rather than treating absence as a defect.

## Missing connections

The following links do not currently exist and are required:

1. Blocking modal visibility -> auxiliary video/audio/person-preview suspension.
2. AppState/screen focus -> the same resource-admission policy.
3. Android process exit history -> local sanitized diagnostics.
4. Subtitle keystrokes/structural edits -> durable edit journal.
5. Editor revision -> coalesced persistence and visible dirty/saving state.
6. Transition source intent -> stable player coordinator with last-request-wins behavior.
7. Player/view/source counts -> local diagnostic counters and device acceptance gates.
8. Long-project performance -> measured render/allocation regression tests.
9. CI/release readiness -> physical Seeker evidence for this incident class.

## Comment audit

The runtime files changed by the latest transition fix contain no unnecessary explanatory/commented-out blocks that should be removed:

- `src/components/editor/video-transition-overlay.tsx`
- `src/hooks/use-video-transition-preview.ts`
- `src/hooks/use-timeline-video-controller.ts`
- `src/lib/video-playback-policy.ts`

The misleading material is executable test language and test names, not comments.

Do **not** remove:

- pinned GitHub Action version comments in CI;
- security/privacy rationale;
- native resource-ownership rationale that prevents use-after-release;
- non-obvious lifecycle invariants.

In implementation PRs, remove only comments that restate the code, describe obsolete incident history, or preserve dead/commented-out code. Comment deletion is not a substitute for fixing ownership.

## Implementation sequence

Do not combine all work into one high-risk rewrite.

### PR A — Exit classification and sanitized local diagnostics

Files/areas:

- new `modules/caption-diagnostics` Expo module;
- `src/services/local-diagnostics.ts`;
- `src/lib/diagnostic-redaction.ts`;
- startup read in `src/app/_layout.tsx` or a dedicated application bootstrap service;
- `scripts/capture-seeker-crash.ps1` for developer-only capture;
- tests for redaction, bounded retention, and exit-reason decoding.

Exit gate:

- one real Seeker disappearance produces a reason classification;
- diagnostic output contains no caption text, project/file names, or media URIs;
- no network permission, analytics SDK, or automatic upload is introduced.

### PR B — Modal/AppState media suspension

Files/areas:

- new pure `src/lib/editor-runtime-policy.ts` state machine;
- new `src/hooks/use-editor-runtime-policy.ts` adapter;
- `src/app/editor.tsx` modal-open intents;
- `VideoTransitionOverlay` admission flag;
- `useTimelineAudioController` suspension input;
- person-preview cancellation/release path.

Exit gate:

- auxiliary video players are absent before a blocking modal becomes interactive;
- audio targets are empty;
- person preview is released;
- app inactive/background state produces the same result;
- hook-owned Expo players are disposed by unmount, not manual `release()`.

### PR C — Recoverable subtitle draft journal

Files/areas:

- `src/services/editor-draft-journal.ts`;
- SQLite migration/table;
- Script Editor and Dual Caption Editor draft adapters;
- restore/conflict UI;
- process-death tests.

Exit gate:

- kill process while typing, reopen project, recover exact draft;
- save clears journal only after durable project commit;
- discard clears journal;
- recovery works after keyboard/modal lifecycle changes.

### PR D — Stable transition-preview coordinator

Files/areas:

- eliminate duplicate preview-window construction;
- remove transition-key player-pair remounting;
- add explicit coordinator states and counters;
- preserve sequential loading and URI-inclusive identity;
- benchmark surface strategy and main-player participation.

Exit gate:

- repeated cross-transition scrubbing does not increase retained player/codec/view counts;
- stale requests cannot publish;
- no visual regression against export semantics;
- memory returns to an agreed baseline band after cleanup.

### PR E — Playback/render isolation and long-caption efficiency

Files/areas:

- isolate playback clock from `EditorWorkspace`;
- word-ID index;
- caption render model cache;
- timeline visible-range index;
- per-caption draft records;
- render/allocation instrumentation in development builds only.

Exit gate:

- measured editor-screen render count is no longer tied to every 50 ms tick;
- long-caption typing updates one draft record;
- preview timing remains acceptable;
- no regression in word highlighting or playhead behavior.

### PR F — Coalesced persistence and explicit editor session

Files/areas:

- `EditorSessionController`;
- `EditorWriteCoordinator`;
- move media ledgers and save/discard policy out of the screen;
- explicit dirty/saving/failed state;
- AppState flush backed by the draft journal.

Exit gate:

- at most one running and one latest pending project write;
- destructive checkpoints are never dropped;
- process death cannot lose journaled caption work;
- screen no longer owns persistence transaction rules.

### PR G — Native memory pressure and release gate

Files/areas:

- Android trim-memory adapter for app-owned reconstructible resources;
- scheduled emulator lifecycle tests;
- documented Seeker hardware matrix;
- CI artifact retention for test reports only, never user media/logs.

Exit gate:

- all P0 and P1 acceptance criteria below pass.

## Seeker evidence capture

Use a release-identical or CI-signed build. Record the APK SHA-256 and exact app version before testing.

### Terminal 1 — capture all log buffers

```powershell
$ErrorActionPreference = 'Stop'
$Package = 'com.hatsunama.captionstudio'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Out = Join-Path $PWD "seeker-caption-studio-$Stamp"
New-Item -ItemType Directory -Path $Out | Out-Null

adb get-state
adb logcat -c
adb shell am force-stop $Package
adb shell monkey -p $Package -c android.intent.category.LAUNCHER 1 | Out-Null

Write-Host "Reproduce the disappearance. Stop this command with Ctrl+C only after it occurs. Output: $Out"
adb logcat -b all -v threadtime | Tee-Object -FilePath (Join-Path $Out 'logcat-live.txt')
```

### Terminal 2 — immediately after disappearance

Use the same `$Out` path printed by Terminal 1.

```powershell
$ErrorActionPreference = 'Continue'
$Package = 'com.hatsunama.captionstudio'

adb logcat -d -b crash -v threadtime > (Join-Path $Out 'logcat-crash.txt')
adb logcat -d -b all -v threadtime > (Join-Path $Out 'logcat-all-final.txt')
adb shell dumpsys activity exit-info $Package > (Join-Path $Out 'activity-exit-info.txt')
adb shell dumpsys meminfo $Package > (Join-Path $Out 'meminfo-after.txt')
adb shell dumpsys media.codec > (Join-Path $Out 'media-codec-after.txt')
adb shell getprop ro.build.fingerprint > (Join-Path $Out 'device-build-fingerprint.txt')
adb shell getprop ro.product.model > (Join-Path $Out 'device-model.txt')
```

A full `adb bugreport` can be captured separately when needed, but it may contain sensitive device and account metadata. Never attach an unsanitized bug report or device log to a public issue or PR.

### Required non-sensitive repro metadata

- app version, versionCode, APK SHA-256;
- video duration, width, height, frame rate, codec, HDR/SDR, and approximate file size;
- clip and transition counts;
- caption count and visible translation-track count;
- whether background removal was enabled;
- playhead location relative to a transition;
- whether the script or dual editor was open;
- whether the keyboard was visible;
- whether the app had recently backgrounded/resumed;
- device thermal/battery state when practical.

Do not record video title, file path, URI, caption text, or project name.

## Acceptance matrix

### Process stability

- 30 minutes continuous subtitle editing on the original repro project.
- 100 Script Editor open/close cycles at a composite transition boundary.
- 100 Dual Caption Editor open/close cycles.
- 200 rapid scrubs across different composite transitions.
- 50 app background/foreground cycles while editor and modal states vary.
- No Java crash, native crash, ANR, LMK, memory-limiter exit, or unexpected activity finish.

### Resource stability

- auxiliary video player count is zero during blocking modals and inactive/background state;
- player/view/codec counts return to baseline after transition exit;
- no overlapping source replacement per player;
- after warm-up, repeated test cycles do not produce monotonic PSS/native-heap growth;
- final memory returns within the agreed device-specific baseline band after cleanup and GC opportunities;
- timeline audio and person-preview resources are absent while suspended.

### Data integrity

- kill the backgrounded process while unsaved Script Editor text exists; exact draft is restored;
- repeat for dual subtitles;
- durable Save clears the recovery journal;
- explicit Discard clears it;
- a persistence failure remains visible and does not silently mark the revision saved.

### Performance

- high-frequency clock does not rerender the complete editor screen;
- typing latency remains stable as caption count grows;
- no visual timing regression in caption highlighting, timeline playhead, transitions, audio, or background preview.

### Privacy/security

- diagnostics contain no captions, media identifiers, project names, or file paths;
- no new network call or analytics/telemetry SDK;
- background-processing consent still fails closed in service/native entry paths;
- URI permissions and backup policy remain unchanged.

### Release

- existing lint, typecheck, logic, native release tests, signing checks, target SDK 36, and 16 KiB alignment pass;
- new lifecycle/journal tests pass;
- a named Seeker test record with build SHA and sanitized evidence is attached to the release decision.

## Correct code and non-findings

The audit deliberately did not label these as defects:

- `useVideoPlayer` owns disposal on hook unmount under Expo SDK 57; manual `release()` is not recommended for these players.
- Transition preview keys include source IDs and URIs, so the inspected identity does not have the suspected stale-URI omission.
- Person preview uses a serialized newest-request-wins queue and cleans superseded files.
- Background-removal consent is enforced below the UI.
- Media-permission release uses a retry ledger and verifies project references before releasing access.
- SQLite WAL and per-project ordering are sound foundations.
- Release signing, target SDK, permission, and artifact checks are strong.
- No account/entitlement subsystem exists, and none is required to fix this incident.

## References

- Audited commit: `3801109504ce75ba91d5355c903ea52017b367d5`
- Expo SDK 57 `expo-video`: https://docs.expo.dev/versions/v57.0.0/sdk/video/
- Expo Android multiple-player OOM report: https://github.com/expo/expo/issues/32712
- Android `ApplicationExitInfo`: https://developer.android.com/reference/android/app/ApplicationExitInfo
- Android memory-trim guidance: https://developer.android.com/games/optimize/memory-monitoring

## Next true blocker

Static analysis cannot determine whether the Seeker event is LMK, Java OOM, native crash, ANR, or activity exit. The next required evidence is one sanitized `ApplicationExitInfo`/logcat capture from a real disappearance on the exact tested APK. All implementation work that reduces risk can proceed in parallel, but the incident must remain unclassified until that evidence exists.
