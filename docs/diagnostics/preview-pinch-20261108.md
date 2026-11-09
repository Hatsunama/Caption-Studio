# Preview pinch repair — integration record

Baseline: `4938006e1a83c43b8f2bfff08b5ff506d8b1bf05` (PR #167 merged).
The private Seeker recording was reviewed locally; it is not included in this
repository. Its visible target switch motivates the audit but does not identify
every native event or prove that every large resize in the recording is wrong.

## Confirmed defects and repairs

1. `preview-scene-controller.ts` changed the owner on the next pointer-down after
   an overlapping tap, before distinguishing another tap from a drag/pinch.
   Overlap cycling now waits for an unmoved, single-contact release. Genuine tap
   cycling remains available. A second contact disqualifies tap cycling even when
   that contact is rejected as a foreign foreground object.
2. A foreground owner's second contact was rejected when it landed on the main
   video. The controller now admits a contact over a lower target explicitly
   marked `yieldToForeground`. Other foreground objects, extra pointers, and
   drained contact sequences retain their existing rejection rules.
3. Main-video geometry used foreground extent bounds during manipulation, then
   different numerical component bounds when saved. A draft scale of `.001`
   could become `.05` on release. Valid saved maximum/anisotropic video transforms
   could also shrink during a no-op/move. Main-video targets now supply the same
   scale/axis bounds used by `mergeVideoTransform`, applied before pivot math.
   Foreground extent bounds and the saved project format remain unchanged.
4. The new deferred overlap candidate needed lifecycle validation: deleting or
   moving it during the tap could otherwise select stale content on release.
   Release resolves that candidate against current targets and captured geometry.

## Impact and preserved contracts

The permanent preview input surface, hook event adapter, hit-test utility,
controller, gesture math, project setters, schema decoder, and render-plan
consumers were inspected. PiP video, image/sticker, text, watermark, primary
captions, translated captions, and main video use the shared controller. Media
contain-fit letterboxing is intentional and is not classified as distortion.

There is no layout, chrome, typography, model, dependency, permission, media
timing, audio-policy, or project-format change. Moves stay transient until a
single captured-identity commit; cancel/reflow/context invalidation discard the
draft. Existing foreign-object and pointer-drain protections remain enforced.
The selected main-video model range stays `.05..20`, with independent axes
`.001..200`; it is not lowered to conceal a release jump.

## Regression evidence

- Follow-up against `907629b0e8018f5834c2bb39115a9ef6af5524af`: suppressing
  owner reselection on a pending overlap tap left Audio tools open after the
  toolbar changed tools without clearing the selected layer. Restored selection
  on every grant, after ownership is installed. The new test compiles the real
  editor selection/tool callbacks with esbuild: all 12 cases failed before the
  repair (six foreground kinds, staggered/simultaneous starts). All 260 focused
  tests then passed serially with `--max-old-space-size=128 --import tsx`.
  Duplicate-tap tests now assert grant/end/release state, completed identities
  `[copy, original]`, exact raw callbacks `[copy, copy, original]`, and no geometry
  commits. Existing pause paths remain active. Local evidence is in
  `C:\caption_studio\crash-audit-20261106\pinch-tool-handoff-red.log`,
  `pinch-tool-handoff-green.log`, and `pinch-tool-handoff-focused-green.log`.
- Ownership regressions: baseline **40 failures / 1 pass**, then green after the
  repair; additional stale-candidate tests were reproduced red before correction.
- Real controller → project setters → JSON decode/reopen tests cover all six
  foreground kinds, repeat-touch pinches, cancellation, unchanged background
  footage/audio/source data, and PiP audio/source-duration preservation. The same
  assertions fail against the baseline controller.
- Model round-trip tests cover portrait/landscape sources and canvases, uniform
  pinch/corner and independent edge bounds, anchored pivot calculations, valid
  maximum shapes, no-op/move, cancellation, and foreground extent preservation.

Tests, compilation, and the recording alone are not native acceptance. Full
checks and CI results must be attached to the final PR head. A repaired native
APK must still be cold-started and exercised on Samsung and Seeker, including
two-finger scaling of each foreground kind, release/reopen, rotation in both
directions, background/resume, cancellation, and wrong-target protection.
Normal text/display settings apply; the user's excluded enlarged-font stress
tests are not reintroduced.

## Release disposition

Unsigned build `42534612847` (private identity `1.4.143` / `155`) was canceled
because these confirmed defects require different source. It was not signed or
published. A replacement final artifact needs a fresh identity, trusted-main
build, separate local Solana/Play signing keys, and exact-artifact verification
on both phones. Release remains blocked until that evidence exists. No raw user
recording, phone metadata, credentials, or signing material belongs in this PR.

## Paused PiP presentation follow-up (November 9)

The exact CI APK from head `4ab6cd07` reproduced a separate Samsung defect:
newly added paused PiP had its selection outline but no video pixels. Its
resized frame appeared after Home/resume and after force-stop/draft reopen.
The same controlled repeat-touch gesture retained the PiP owner on both phones;
Samsung also retained the exact image and text owners in their native cases.
These native cases used the existing landscape fixture in portrait UI. They do
not certify other source/UI orientations, every interruption, or final store bytes.

The overlay previously treated constructor preparation, a queued seek, and SDK
readiness as sufficient presentation; target zero skipped seeking. It now reuses
the main preview's existing source/view-owned Android presentation contract for
an unclipped source. Preparation stays paused and muted, follows the latest
committed clock/play intent, and aborts its own native request when retired.
Geometry edits retain the texture view. No artificial playback, thumbnail
fallback, dependency, model, layout, or project-format change was introduced.

Change-impact review also caught milliseconds passed to an API requiring source
duration in seconds. Realistic stored-duration and native Float/EOF fixtures now
exercise that connection. Preparation failures reach the existing inline alert
without replacing another error or logging private native error details; another
PiP becoming ready cannot silently clear the failure.

Evidence: the initial readiness component regressions failed 13 cases before the
repair; the new caller/error handoff then failed 6 of 27 parent-run tests before
its wiring was completed. All 27 final readiness/caller tests pass with a 64 MiB
Node heap. Earlier combined main/PiP tests passed on the preceding readiness
revision. Full required checks, type/lint validation, and runtime verification of
these new bytes remain pending. The earlier green CI/artifact cannot certify this
follow-up. PR #168 remains draft and release blocked. Private device captures,
recordings, signing material, and test-tool state are excluded from the commit.
