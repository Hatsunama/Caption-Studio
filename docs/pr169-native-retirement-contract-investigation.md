# PR169 native retirement investigation (2026-11-15)

Current status: a native masking candidate is now implemented below. The original
RED investigation is retained as history. This is **not native/device GREEN**;
HEAD remains `0cc376aab819ce951718e67140d7b69b5fe828ab`, and native compilation,
Robolectric execution, independent review and fresh APK tests remain with parent.

Initial investigation stopped at RED; the subsequent candidate and parent checks are recorded below. Baseline:
`fix/pip-move-order-20261112`, `0cc376aab819ce951718e67140d7b69b5fe828ab`.
Installed packages are Expo Video 57.0.5 and RN 0.86.3. Dependencies and model
remain unchanged. Read root AGENTS.md and exact versioned Expo docs before edits.

The parent reports black native frames at the first two A/B/A/B boundaries and
a clean last boundary without another preload. That supports investigating
outgoing-player reuse but does not establish its cause conclusively. The new
tests demonstrate a missing ownership invariant, not reproduced black pixels.

## Actual contracts inspected

- `src/hooks/use-timeline-video-controller.ts`: `preloadNext` releases preparation
  after `committedPreviewRef` has the new active slot and transition-tail time.
  A passive effect updates that ref. No native ownership evidence is required.
- `src/components/editor/video-transition-overlay.tsx`: the retained pair changes
  layer zIndex and uses `slot:nativeViewEpoch` keys. Composite styles can keep
  both surfaces visible; zIndex alone cannot certify outgoing retirement.
- `modules/caption-media/android/src/main/java/app/captionstudio/media/VideoFrameReceipt.kt`
  (the actual class name, not NativeFrameReceipt): combines current item/target,
  current VideoView/player binding, reading-source analytics, current-output
  first-frame and SDK layout validity. It does not observe ancestor visibility,
  sibling draw order, composite-tail completion or frame submission.
- `VideoPlaybackWindow.kt`: owns preparation, not presentation ownership. Its
  native install pauses, sets the media source and prepares. Starting this
  operation is already too late to protect the old decoder. Successful readiness
  removes the receipt listeners; it cannot certify a later handoff.
- `CaptionMediaModule.kt`, its TS declaration and the playback-window service
  export configure/cancel only. No native handoff/retirement receipt exists.
- Installed Expo `VideoPlayer.kt` sets ExoPlayer's application looper to main.
  `changeVideoView` switches PlayerView target and changes currentVideoView.
  Its `FirstFrameEventGenerator.kt` checks layout ratio and deduplicates item/view
  events. `VideoView.kt` then exposes the surface and dispatches first frame.
  None of these callbacks acknowledges Fabric sibling presentation ownership.
- Installed RN `ReactViewGroup.kt` says z-order is managed by Fabric C++; its
  legacy updateDrawingOrder is a no-op. `ConcreteViewShadowNode.h` sets orderIndex
  from zIndex. Reading a React prop or the obsolete Java drawing-order helper
  therefore cannot be substituted for actual mounted native hierarchy state.

Official references read:

- [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/)
- [Expo Video 57](https://docs.expo.dev/versions/v57.0.0/sdk/video/)
- [Android ViewTreeObserver](https://developer.android.com/reference/android/view/ViewTreeObserver#registerFrameCommitCallback(java.lang.Runnable)):
  frame-commit notification requires API 29 and hardware rendering, and denotes
  swap-chain submission, not necessarily display. It cannot cover min API 24.
  OnDraw/OnPreDraw notification precedes drawing; it is not a submitted-frame ACK.
- [Texture update listener](https://developer.android.com/reference/android/view/TextureView.SurfaceTextureListener#onSurfaceTextureUpdated(android.graphics.SurfaceTexture)):
  observes updateTexImage, not sibling ownership or transition completion.

This bounded investigation has not established an API-24 native hierarchy/draw
contract sufficient for safe retirement. This is not a claim that such an owner
cannot be built. A first-party native presentation owner needs a separately
justified contract before implementation; adding a promise around JS commit,
pre-draw, elapsed time or SDK first frame would not meet the requested invariant.

## RED evidence

`tests/timeline-video-surface-recovery.test.mjs` adds an independent held-native
owner snapshot and four new regressions. React effects and render settle while
that snapshot stays unchanged. Both outgoing slots are tested with both:

1. Same URI reused: configureVideoPlaybackWindow mutates the held player.
2. Different URI: replaceAsync followed by configureVideoPlaybackWindow mutates it.

The assertions also protect epoch and view path. In this run both stayed stable;
the demonstrated violations are source/window mutations. No invented native
receipt callback or fake successful gate was added. There is no positive receipt
release test because no supported receipt implementation was established.

One Node process, `node --max-old-space-size=128 tests/timeline-video-surface-recovery.test.mjs`,
ran while holding `Local\CaptionStudioNodeChecks`; free physical memory immediately
before launch was 1,579,664 KiB (>768 MiB). Result: **141 tests, 137 pass, 4 fail**,
exit 1. All four failures are the new held-native-owner cases. Full output:
`evidence/pr169-native-retirement-red-20261115.txt`. No GREEN repair is claimed.
`git diff --check` passed. No native tests/builds, devices or Gradle were run.

## Required owner proof and subsequent tests (not implemented)

The eventual native owner must establish actual view/player/output binding,
generation and active owner, actual native layer/ancestor visibility and ordering,
and completed transition-tail state before any standby source, epoch or surface
mutation. First-frame readiness remains a separate prerequisite. A snapshot that
was valid before another Fabric mount is not a durable ownership lease.

Native checks and the authorization/retirement operation need defined main-thread
ordering against Fabric mounts and player changes. A promise resolved to JS must
not leave a check-to-mutation race in which a seek, mount or generation change
restores the retiring surface before source mutation. An active native lease or
atomic native retirement operation needs proof, not just a callback name.

Cancel/superseding generation must tombstone authorization before queued work;
late receipt, old view/epoch/player/output, or wrong owner must fail closed.
Timeout/error must preserve the outgoing source and settle once. Detach,
background, rotation/rebind, release and module destruction must invalidate the
lease and remove listeners, including callbacks already queued for delivery.

After choosing that contract, add real native owner tests for both directions,
stale receipts, cancellation before/after queued draw, failed receipt, detach,
rotation/rebind, tail still visible and destruction. Add matching hook tests for
successful release, stale receipt, superseding seek, background and failure;
existing JS commit cancellation tests do not certify native receipt handling.
Protect iOS/web paths, composite/cover/gap/tail, audio/rate/preview behavior, two
main-player limit and URI policy. Parent retains CI/native verification ownership.

Only the test file and this investigation document were changed; the new log is
inside the pre-existing untracked evidence directory. No commit/push/merge,
network mutation, dependency/settings/device/build/key or local Gradle changes.


## Native masking candidate (subsequent implementation)

The parent supplied a different, supported exclusion contract: own native masking
before destructive preload, independently of any submitted-frame acknowledgment.
The Samsung evidence is
`../pip-move-order-20261112-evidence/pr169-e410-candidate-tools/samsung-native-source-switch-baselines.json`
and its adjacent PNG. Its two source baselines each contain 192 frames with no
black frames. The parent's subsequent visual review confirms whole-preview black
frames 187/316 at the first two switches and the clean final no-next control at
437. This candidate has not been captured on a device.

### Full preparation and simpler coupling review

`prepareSlotOperation` installs a native window even when its URI is unchanged.
Protecting only `replaceAsync` misses the same-URI mutation. The existing JS commit
and transition-tail scheduling remain useful admission conditions but are not the
lease. The retained Android inactive layer now has parent opacity zero outside
composites. Composite recipes and iOS/web styles are unchanged.

There is also an actual state/visibility coupling: a waiting composite conceals
the **common pair parent** until both source frames are ready. Requiring a visible
peer in that state would deadlock preparation. The native guard distinguishes an
actual shared alpha-zero ancestor from separate alpha-zero sibling layers. Shared
concealment already excludes both surfaces; acquiring a view mask reveals or hides
no additional pixels. Separate masked siblings must wait for the actual peer
surface to become effectively visible. No global visibility toggle or third player
was added.

### Installed APIs checked

Read root AGENTS.md and the exact [Expo SDK 57 reference](https://docs.expo.dev/versions/v57.0.0/)
and [Expo Video 57 reference](https://docs.expo.dev/versions/v57.0.0/sdk/video/)
before implementation. Installed Expo Video is 57.0.5. Its Android
`FirstFrameEventGenerator.isPlayerSurfaceLayoutValid` checks nonzero surface size
and aspect/fill/unknown video size; it does not check alpha, `isShown`, or ancestor
visibility. Alpha-zero TextureView preparation therefore does not suppress that
SDK receipt predicate. `VideoView.onRenderedFirstFrame` writes the texture child's
alpha; it does not own the outer VideoView alpha used by this lease.

`VideoPlayer.changeVideoView` switches the PlayerView then updates
`currentVideoView` synchronously; native target listeners run synchronously on the
main thread. The MutableWeakReference callback reverses its argument labels, so
the observer reads the actual current view and actual Player binding. ExoPlayer's
application looper is main. `VideoModule.replaceImpl` queues source assignment and
`prepare()` together on mainQueue. Java legacy RN z-order helpers are not used.

Media3 is pinned at 1.11.0. Its exact
[AnalyticsListener source](https://raw.githubusercontent.com/androidx/media/1.11.0/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/analytics/AnalyticsListener.java)
and [Android API reference](https://developer.android.com/reference/androidx/media3/exoplayer/analytics/AnalyticsListener#onPlayerReleased(androidx.media3.exoplayer.analytics.AnalyticsListener.EventTime))
provide release notification for cleanup of the permanent dirty-mask owner.
No dependency, min SDK, Expo configuration, source factory or URI policy changed.

### Ownership sequence and cancellation

1. Before any Android preparation pause/source/window mutation, the hook acquires
   a native request scoped to its player, request ID, generation and peer. Native
   resolves actual TextureView-backed VideoView/Player binding. A standby grant
   requires an actual masked ancestor and either an effectively visible peer
   surface (attachment, window, dimensions, global visible rect, visibility and
   alpha through ancestry), or the actual shared concealment described above.
2. The native owner writes **outer VideoView alpha zero before resolving JS**.
   The alpha remains owned through replacement and window preparation. Native
   synchronous target-change observation masks newly bound SDK views; pre-draw
   reasserts already owned masks against hierarchy updates. Pre-draw is exclusion
   maintenance, never a GPU/submission receipt. Initial/recovery preparation of
   the active slot may acquire its own mask directly; this is not permission to
   retire a visible standby.
3. Aborting the JS SDK loader does not cancel its already queued replacement.
   The hook tracks that replacement promise per slot and drains it under the mask
   before another replacement/window install. The drain is abortable and bounded
   at 15 seconds; its timeout keeps dirty exclusion and invalidates the cache.
4. Existing `VideoFrameReceipt` and `VideoPlaybackWindow` validation remain intact.
   Only successful native window completion records a mask-release checkpoint:
   current native item identity, view identity, available SurfaceTexture identity,
   current position, surface dimensions, READY/error state and SDK layout validity.
   The final native commit checks the same request/generation and these current
   values after the hook's position acknowledgment before restoring owned alpha.
5. Cancel tombstones authorization synchronously before queued main work. Before
   a grant there is no owned alpha to restore. After grant, cancellation leaves
   the dirty mask and binding observer in place; it cannot reveal a possibly
   queued replacement. The hook immediately invalidates first-frame/URI/window
   cache when its preparation aborts. A later valid preparation must establish its
   own grant/checkpoint. Request `granted` is reset on renewal; old held exclusion
   cannot authorize a new request. Renewal only reasserts masks it already owns.
   A target callback's dirty-mask preservation is a separate responsibility.

Request callbacks settle once and are cleared after grant/failure/cancellation;
acquire and commit waits are bounded to 5 seconds. There are at most 32 weak-keyed
owners. SDK player references, view masks and ViewTreeObserver references are weak;
the saved original alpha has a weak owner to prevent stale-owner restoration over
a newer owner. Successful commit, unmount disposal, player analytics release and
module destruction remove permanent listeners. Background tombstones pending and
granted requests and keeps dirty exclusion; foreground enables fresh requests.
Unmasking requires a new successful checkpoint. Empty timelines never start a mask
request, including translation and unmount. PiP's separate playback-window consumer
and export paths retain their contracts.

### Candidate validation and remaining owner work

The original four RED held-native-owner regressions remain and now wait for an
explicit native lease grant. Added positive release cases cover both slot
directions and URI patterns; stale grant, cancellation, timeout/failure and dirty
standby cache cases exercise the real hook. Direct real-service tests cover acquire
and commit abort/timeout with late native resolution and the empty-timeline control.
The harness explicitly models the native boundary; none of these tests prove pixels.

`VideoMaskLeaseTest` exercises the actual production observer through a binding
seam using Android Views, alpha/ancestry and a paused main looper on API 24/28.
It covers masked/visible peers, shared concealment, stale renewal, dirty masks,
queued cancellation, current-view rebind, item/output/state mismatch, background,
timeout, player release and listener cleanup. It is **written but not executed**:
no local Gradle/native build was authorized. Native compile/runtime review is still
required, including release ordering and real Fabric remount behavior.

Parent owns independent checks, CI and fresh actual native APK verification on both
phones (Samsung four-clip and Seeker controls). A passing Node suite or a native
observer unit test cannot make this release GREEN. No commit/push/merge, dependency
change, device/key/paging/process operation or native build was performed here.


Final bounded worker checks: **156/156 Node tests pass**, exit 0, using exactly one
`node --max-old-space-size=128 tests/timeline-video-surface-recovery.test.mjs`
process while holding `Local\CaptionStudioNodeChecks`. Final pre-launch free
physical memory was **1,202,064 KiB**, above 768 MiB. Output is preserved in
`evidence/pr169-native-mask-candidate-node-20261115.txt`; the earlier RED log remains
unchanged. `git diff --check` passes. The native test source has 13 tests configured
for API 24 and 28; none were run locally. No typecheck/full check or native compile
result is claimed. Native error handling keeps dirty exclusion rather than dropping
its binding observer; release/unmount/module shutdown perform final cleanup.

## Parent integration review (2026-11-15)

Independent parent execution passes the final 157-case surface/controller suite,
7 native-window adapter cases, 27 PiP readiness cases, 1 PiP suspension case,
8 translation ownership cases, 2 two-decoder/audio ownership checks and 12 timeline
extent cases. The unchanged product-contract check passes. These are JavaScript,
mock-boundary and source-contract evidence, not native pixel or compilation proof.

A legacy audio-ownership assertion required the exact direct-player loader call.
Its failure was reproduced after the Android adapter was connected. It now parses
the actual awaited loader call and checks its unchanged URI/15-second/abort-signal
arguments, direct non-Android player, and Android forwarding of SDK status,
listeners and replacement. The two-player and shared-preload assertions remain.
Behavioral SDK replacement and cancellation coverage lives in the controller suite.

Parent isolated execution of the production exhaustive-deps rule reproduced two
new cleanup wiring errors. The effect now captures the stable mutable ID array in
commit phase and declares its player dependency. A control verifies disposal uses
the latest actual IDs after renewed preparations, rather than mount-time numbers.
That rule and the 157 behavioral cases pass after the correction. No lint rule or
production lint configuration was changed. This isolated diagnostic is not the
full Expo lint gate.

Full local typecheck and normal Expo lint each reached the authorized 128 MiB
Node heap limit (exit134) before completion. Their logs remain private under
`evidence/pr169-parent-mask-{typecheck,lint}-20261115.txt`. No local GREEN claim,
heap escalation, dependency reinstall, paging change or other-agent termination
is made. Full clean CI, native compilation and native observer tests are mandatory.

Impact trace: main transport -> source-loader adapter -> mask lease -> unchanged
SDK load and native playback-window receipt -> position acknowledgment -> native
lease release -> slot readiness -> retained pair. PiP still calls the unchanged
playback-window service without acquiring a main-pair lease; absent native owners
make its checkpoint notification a no-op. Export, URI policy, persisted schema,
model, dependencies and keys are unchanged. Composite/cover/gap/tail and iOS/web
coverage remain in the behavioral suite. No additional issue was found in this
inspected scope; that is not proof of native correctness.

Samsung's exact0cc CI APK remains the failing baseline. Seeker's A/B/A/B setup is
complete with its original three overlays unchanged; its final tool-only return
check was resumed after observing a Y-clipped ruler. No split/append/reorder was
repeated. Both phones were guarded back to Home. A fresh candidate must be tested
on both before PR169 can leave draft; final store-key artifacts require their own
later verification. No store artifact was changed or published.
## Hosted harness follow-up

Commercial CI43689822160 rejected54 cases:53 transition tests had no Platform
mock and one historical integrity check expected the previous source literal.
No typecheck/lint or APK build was reached. The failures were reproduced locally.
The integrity check now executes the actual sourceChanged expression across source,
window, pending-mutation and transient-status cases and exercises the real parsed
SDK adapter for Android/iOS/web success and rejection. Its authority/timeout/signal
and retirement assertions remain.

The transition harness declares its platform explicitly. Parent review also ran
all original cases on Android, reproducing two obsolete exit-opacity expectations.
Every original host/geometry/failure/lifecycle obligation now runs on BOTH Android
and iOS; only Android's intended inactive-layer exclusion has a separate precise
assertion. Active/composite/iOS/web alpha and retained-host checks span every
existing recipe. Parent execution passes112 transition cases and4 integrity cases.
No production file, dependency or lint configuration changed in this follow-up.
Native compilation and fresh exact-APK runtime evidence are still required.

## Native fixture window follow-up

Native76ef CI compiled the production code and ran269 cases. All20 failures are
in the new26-case observer suite: ordinary fixtures never receive a grant; the
shared-concealment and cancellation controls pass. Parent downloaded the334475-byte
raw report artifact14152232603 and verified SHA-256
27cd03ceb518ba57bbc1b7b243eb9f1f92c0fc37e5fcb0b0b716bb69282d81b5.
Actual XML totals match26 cases,20 failures,0 errors/skips. This does not identify
the exact failed visibility predicate and does not establish a product defect.

The fixture previously made an empty activity visible, then installed content and
measured only its leaf root. Robolectric4.16.1 setup() already calls visible();
Android clips visible rectangles through all window ancestors. The revised
fixture installs its explicit100x100 content before attachment and measures/layouts
from the320x480 decor. Preflight assertions now expose actual attachment, token,
window, ancestor dimensions, global rectangles and alpha before any lease request.
Health and real ancestor-clipping controls were added; all13 original observer
methods/assertions remain. No production guard, visibility implementation or
fake grant changed. This is a fixture repair hypothesis awaiting hosted evidence,
not a native GREEN claim. The new suite has15 methods across API24/28.

## Proven Robolectric legacy-window cause

The ae8 raw health report disproves ancestor layout as the complete explanation:
both views are attached, shown, share a token and have positive global rectangles,
but every ancestor reports windowVisibility=8 (GONE). All30 new observer cases
therefore fail the fixture health precondition before exercising a lease.
The381889-byte artifact14152692035 has parent-verified SHA-256
e2da99e92b1dbc29d64021543f5c446487e5bfaf99ba9633dd28d98d890fde0b.

Robolectric4.16.1 ShadowWindowManagerGlobal.java, addToDisplay lines463-470,
explicitly documents that legacy graphics omits ADD_FLAG_APP_VISIBLE by default.
Its supported migration property is robolectric.areWindowsMarkedVisible=true.
Pinned source: https://raw.githubusercontent.com/robolectric/robolectric/robolectric-4.16.1/shadows/framework/src/main/java/org/robolectric/shadows/ShadowWindowManagerGlobal.java
Android9 ViewRootImpl sets mAppVisible from that add flag, and getHostVisibility
returns GONE when it is absent. This agrees with the actual hosted diagnostics.

Only this test class now opts into the framework migration in JUnit Before and
restores the exact prior property (including absence) in After. The production
visibility predicate is unchanged. A negative control uses the default hidden
framework window with a shown/attached/measured/alpha1 view and confirms it is
still rejected. All prior assertions and API24/28 coverage remain;16 methods
produce32 expected cases. Native hosted execution must establish GREEN.
