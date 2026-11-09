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
