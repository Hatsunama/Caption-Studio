# Caption Studio no-change compression audit

Audit date: 2026-10-17 UTC. Repository: [Hatsunama/Caption-Studio](https://github.com/Hatsunama/Caption-Studio).

Audited `main` revision: `3ae54ddb3cf3253037a1c53aaf86177d09c7770a` (tree `5d35cc33d91c1fce6b69abdc9b989ef226e5c616`). Source manifest version: `1.4.101`. The release history may use separately stamped versions; this audit is about this exact source snapshot.

**Status: COMPRESSION CANDIDATES FOUND — static audit, no product changes.**

## Scope and limits

This is an assessment, not a product patch. No implementation, dependency installation, lockfile regeneration, build, signing, deployment, device operation, or user-data mutation was performed. An isolated clean clone was used; the user's local working tree was unavailable and its state is not claimed. The proposed PR adds audit documentation only.

Coverage includes all 988 tracked files in a byte/hash inventory and every meaningful application subsystem and direct dependency. Coverage depth is explicit: first-party source responsibilities and candidate call graphs received semantic review; all test files were catalogued by imports and regression names, with selected tests executed; binary assets were measured and registration/format/identity checked, not visually reapproved; third-party vendored code and archived evidence were reviewed as dependency/provenance groups, not independently re-audited for upstream security or every vendor algorithm. This is not a claim that every line in the repository was manually reread, nor proof of behavioral equivalence after an unimplemented change.

The native application was not run. Actual APK/AAB, installed size, Hermes/Metro bundle sizes, startup time, memory, frame timing, export throughput, and model inference measurements were not produced. No estimate below may be substituted for those measurements.

## Baseline dimensions

| Tracked group | Files | Raw tracked bytes |
|---|---:|---:|
| `.claude` | 1 | 71 |
| `.codex` | 1 | 666 |
| `(root)` | 16 | 500,687 |
| `.github` | 12 | 47,617 |
| `.vscode` | 2 | 202 |
| `assets` | 143 | 19,896,175 |
| `config` | 2 | 1,368 |
| `docs` | 53 | 2,265,488 |
| `licenses` | 1 | 2,034 |
| `modules` | 144 | 903,743 |
| `play-store` | 3 | 9,884 |
| `plugins` | 6 | 6,091 |
| `script` | 2 | 1,697 |
| `scripts` | 16 | 94,468 |
| `shared` | 1 | 11,268 |
| `signing` | 1 | 2,639 |
| `src` | 191 | 1,325,776 |
| `tests` | 228 | 1,596,995 |
| `third-party` | 2 | 13,073 |
| `vendor` | 163 | 6,442,133 |
| **Total** | **988** | **33,122,075** |

These are uncompressed file-content bytes at the audited tree, excluding `.git`, ignored/build outputs, installed dependencies, caches, and downloaded models. They are not Git-pack transfer bytes and not distributable/installed application sizes. Source removals may save zero runtime bytes after existing dead-code elimination; duplicate source assets may already collapse or expand during native packaging.

Downloaded model footprint is a separate dimension: `MODEL_NOTICES.md` records Whisper 32,152,673 bytes, VAD 885,098 bytes, and optional Qwen translation 1,597,931,520 bytes. These models are not tracked assets or bundled APK/AAB weights. Replacing/quantizing/removing them changes a protected functional/quality contract and is not recommended by this audit.

## Verification performed

- `git rev-parse HEAD` matched the connected GitHub `main` ref. Initial `git status --porcelain` was empty.
- All 988 tracked file contents were measured and SHA-256 inventoried. Byte-identical groups were identified; repeated licenses, empty Android manifests, historical receipts, and public signing material are not deletion recommendations.
- `node scripts/generate-product-contract.mjs --check`: passed. Its read-only path was inspected before execution.
- Existing Node test subset: 25 test files attempted using installed Node v24.19.0, with 67 tests passed and one test-file load failure. `tests/android-media-runtime-contract.test.mjs` could not load `expo/config-plugins` because this isolated clone has no installed dependencies. The command exited 1; this is not a full-suite pass.
- This runtime differs from CI Node 22.13.1. Full `npm run test:logic`, TypeScript, lint, Expo doctor/compatibility, native Android unit/lint/build, packaging and device equivalence tests were not run. No dependencies were installed to unblock them.
- The 228 files under `tests/` were catalogued for role/imports/regression labels (1,336 literal test labels, not a full dynamic test-count claim). Independent fixtures, source-shape guards, device scripts and runtime harnesses are KEEP unless a specific candidate below identifies a narrow adjustment. Shared helpers do not justify deleting regression coverage.

Attempted subset:

- `tests/android-ci-alignment.test.mjs`
- `tests/android-lint-scope.test.mjs`
- `tests/android-media-runtime-contract.test.mjs`
- `tests/android-patch-resolution.test.mjs`
- `tests/android-release-gate.test.mjs`
- `tests/android-release-identity.test.mjs`
- `tests/audio-readiness-selection.test.mjs`
- `tests/audit-editor-contracts.test.mjs`
- `tests/caption-editing-preview-integrity.test.mjs`
- `tests/caption-translation-contract.test.mjs`
- `tests/export-delivery-contract.test.mjs`
- `tests/layer-ownership-contract.test.mjs`
- `tests/legal-notices.test.mjs`
- `tests/preview-scene-release-contract.test.mjs`
- `tests/privacy-surfaces.test.mjs`
- `tests/product-contract.test.mjs`
- `tests/readme-release-links.test.mjs`
- `tests/retired-background-processing.test.mjs`
- `tests/sidecar-installer-discovery.test.mjs`
- `tests/sidecar-workflow-structure.test.mjs`
- `tests/splash-screen-api-contract.test.mjs`
- `tests/timeline-audio-ownership.test.mjs`
- `tests/translation-partial-success.test.mjs`
- `tests/translation-performance-contract.test.mjs`
- `tests/video-angle-window.test.mjs`

## Repository-wide keep decisions

- Keep tests and native shared timing/preservation fixtures: similarly named tests exercise different boundaries (source shape, runtime harness, serialization, cancellation, native parity, persistence and device behavior). Test-file count alone is not removable complexity.
- Keep documentation/history/provenance groups, including 53 `docs/` files, the DOCX/PDF audit pair, backport RED/GREEN receipts and diagnostic patches. DOCX and PDF are separate editable/readable representations, not duplicate runtime payload. No archive migration is proposed.
- Keep per-font legal notices, module licenses, third-party/model notices, security/privacy text and store disclosures. Byte-identical license text does not prove legal or packaging equivalence after relocation.
- Keep `signing/caption-studio-lineage.bin`: public signing lineage is an installation/update contract, not a disposable binary.
- Keep editor tooling metadata and the generated environment descriptor. Keep the authoritative `config/product-contract.json` and generated TypeScript/Java views together; the existing generator/check owns their intentional duplication.
- Exclude cosmetic reformatting, shorter identifiers, minifying authored source, removing checks/retries/cancellation/validation, or changing features from compression recommendations.

Classification note: **SAFE REMOVE** denotes high-confidence current-source unreachability with a defined validation gate; it is not an assertion that unexecuted tests passed or permission to implement. **CONSOLIDATE/SIMPLIFY** require net reduction without contract drift; **DEPENDENCY/ASSET/RUNTIME/BUILD REDUCTION** identify the dimension, not a guaranteed numerical result. **KEEP** and **NEEDS EVIDENCE** are deliberate outcomes, not gaps disguised as removal advice.

## Findings and independent implementation batches


## Prioritized outcome

**COMPRESSION CANDIDATES FOUND — static audit.** This is not a NO-OP, but no product reduction has been implemented or benchmarked. Candidate status is evidence for a separately approved, tested change, not permission to delete or a claim that a build will become smaller.

| Priority / independent batch | Best supported direction | Evidence confidence and gain dimension | Acceptance boundary |
|---|---|---|---|
| A — safe removals | Remove unreachable UI/native branches and production-unreachable legacy helper paths; keep all active entrypoints | High static control-flow/reference confidence for explicitly proven spans. Source-size reduction; release-size effect may be zero | Candidate-specific call/test cascade, full type/native compile and targeted behavior tests; never delete mixed live tests wholesale |
| B — duplicated logic | Share exact UTF-8 sizing helper, native caption-map serializer and exact whitespace predicate; consider one undo/redo restoration helper | High duplicate identification, medium net-simplification confidence. Maintenance/source only; new helper overhead must be counted | Byte-budget/Unicode, independent storage policy, ordered-event/final-map and history equivalence |
| C — dependencies/build | Two root npm dependency REMOVE candidates; overlapping native CI execution can be consolidated separately | 2 of 32 production declarations; static closure predicts 6 lock placements, subject to regeneration/hoisting. No installed/binary-byte forecast | Pinned npm clean install/lock diff, SDK57 compatibility, navigation/status-bar platform checks; preserve all CI checks, evidence and signed/unsigned boundaries |
| D — assets | Reuse one identical launcher/adaptive foreground PNG source | High decoded-pixel and PNG color/chunk equivalence, excluding timestamp metadata. Exactly 693,320 raw tracked bytes removable; generated package savings unknown | Change only config path, preserve icon dimensions/alpha/safe zone/color, compare Expo generated resources and device appearance |
| E — runtime | Replace repeated audio-source/video-clip scans with indexes after existing uniqueness validation | High static complexity finding; conditional JSON-domain equivalence and medium performance confidence. Exported sparse-input behavior needs evidence. Runtime work, potentially more source/index memory; no measured speedup | Same validation/error order including direct sparse-array calls; reuse existing validated clip-ID Set; round-trip/audio attachment tests and representative profiling |
| F — structure | Keep intentional module boundaries; no broad file-count reduction or generic editor/state-machine rewrite recommended | High evidence that existing boundaries protect distinct responsibilities | Only extract helpers with fewer responsibilities and a positive measured net simplification; do not centralize unrelated lifecycles |
| G — KEEP | All fonts, native modules, model hashes/consent, migration/persistence guards, cancellation/resource ownership, export verification, ABI support, security backports, notices and regression coverage | Active/static/dynamic contracts explicitly traced | Preserve these contracts in every future batch |
| H — needs evidence | Real artifact sizes, dependency dedupe, font loading/representation, vendor package slimming, narrow JNI keep rules, named bridge/test-only legacy APIs | Insufficient evidence for a safe removal or numerical benefit | Obtain the stated measurement/compatibility evidence first; no assumption of savings |

Each row is independently reviewable. Do not combine source cleanup with dependency upgrades, model swaps, ABI removal, release/signing changes, migrations or UI redesign. Small proven source removals are more defensible here than an unmeasured large reduction claim. The detailed sections below identify responsibilities, callers, lifecycle/security risks, exact paths/lines, measured versus estimated savings and tests for each substantive candidate.

## Coverage ledger

The companion [coverage ledger](2026-10-17-compression-coverage.csv) records all 988 original tracked paths, raw bytes and SHA-256 hashes. `KEEP` means retain the file/its evidence; `REPORT` means consult the scoped candidate and KEEP decisions below, not delete the file. Coverage groups:

- 1: Build/configuration/legal/tooling; Responsibility/configuration/reference review
- 2: Bundled assets; Byte/hash inventory, all registrations/license groups, font/PNG metadata; no device visual reapproval
- 3: Documentation and historical evidence; Format, role, inventory and provenance references; archives not rerun
- 4: Native modules and bridges; Semantic responsibility/group review; module registrations and candidate call graphs
- 5: Services, pure logic, types, shims; Complete inventory/reference scan and full direct source reading; responsibility and candidate call graphs
- 6: Editor UI, routes, hooks; Semantic responsibility inspection; candidate call graph and tests reviewed
- 7: Regression and verification; Complete metadata/import/test-label inventory; selected baseline execution; focused candidate cascade review
- 8: Reviewed dependency backports; Manifest, dependency, provenance and pack-consumer review; not full upstream security re-audit

The audit's generated report and coverage ledger are intentionally absent from the baseline inventory. Rehashing all 988 baseline paths after the checks found zero mismatches; source/config/lock/tests/assets/generated contract outputs remained unchanged.

## Publication and follow-through boundary

Only these audit documents are proposed for a draft PR. Use a new documentation branch, a HEAD commit message containing `[skip ci]`, and no edits to workflow or branch-protection configuration. The existing PR workflows otherwise perform expensive Android compilation, packaging and ephemeral CI signing even for a draft. GitHub's [skip-workflow documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs) covers push and pull_request; the audited workflow inventory contains no pull_request_target/workflow_run exception. Verify the exact documentation-only remote commit and absence of newly started runs after opening the PR.

CI is intentionally skipped for this documentation-only submission. Skipped/absent checks are not passing checks; required checks may stay pending and prevent merging. This audit does not authorize merge, workflow dispatch, paid CI, signing, deployment, dependency installation or implementation. Any eventual implementation needs the candidate-specific checks below and a newly authorized execution path. Existing repository CI failures or stale focused runners are evidence limits, not an invitation to modify product code in this PR.



## Editor, components, and hooks: read-only compression audit

Repository: `Hatsunama/Caption-Studio`  
Revision: `3ae54ddb3cf3253037a1c53aaf86177d09c7770a`  
Scope: every file under `src/app/`, `src/components/`, and `src/hooks/`  
Reviewed source: **47 files, 10,864 physical lines, 537,782 UTF-8 bytes**

### Result

**No whole file in this scope is safely deletable.** Every non-route file has a production inbound reference; the app files also have Expo Router convention-based entry points. Large files contain substantial live behavior, rather than large inert scaffolds.

Six narrow candidates remove obsolete contracts or unreachable branches. Exact, in-memory text simulations yield **40 production source lines / 2,031 bytes** removed in aggregate. A single undo/redo implementation could remove another **15 lines / 680 bytes**, subject to history-equivalence testing. These numbers are source-text deltas for the specific minimal proposals below, not applied changes. Test updates, optional type tightening, formatting, bundle bytes, startup time, memory, and rendering performance are not included or measured.

| ID | Classification | Narrow reduction | Source lines | Source bytes | Confidence |
|---|---|---|---:|---:|---|
| A | SAFE REMOVE | Remove unread selection/deletion props from content-only overlays and their callers | 10 | 594 | High |
| B | SAFE REMOVE | Remove unreachable nonincremental translation final-commit and warning fallback | 10 | 479 | High, closed current request constructors |
| C | SAFE REMOVE | Remove unreachable reorder-cancel callback and finish discriminator | 7 | 366 | High |
| D | SAFE REMOVE | Remove unreachable text-layer badge branch in animation browser | 6 | 318 | High |
| E | SAFE REMOVE | Remove unused externally supplied editor revision props | 4 | 130 | High |
| F | SAFE REMOVE | Remove write-only translation-suspension counter | 3 | 144 | High |
| G | CONSOLIDATE, test before adopting | Share the actual undo/redo restore operation | 15 | 680 | Medium-high static equivalence |

The meaningful benefit here is a smaller set of supported internal states and ownership contracts. This is a modest cleanup opportunity, not evidence of a large editor or application-size reduction. Do not replace complex state machines with shorter code merely to increase the count.

### Coverage and verification limits

- Read `AGENTS.md`; its Expo-version requirement applies before implementation. This audit made no application edits.
- Verified the checked-out revision and clean `git status --short` during the audit.
- Inventoried all 47 audited files and inspected their complete semantic responsibilities, including the large editor coordinator, timeline, caption editors, transport controller, rendering adapters, accessibility paths, and lifecycle hooks.
- Candidate locations received line-level review plus inbound callers, private request/callback construction, relevant library/service ownership, test loaders, and native registration checks. The remaining files received whole-file semantic responsibility inspection. This is **not** a claim of an independently annotated line-by-line proof for all 10,864 lines.
- Checked ordinary imports and reference sites beyond the audited directories. In addition, traced Expo Router entries, string-based native view names, callback dispatch, and tests that load/transpile/extract source. Absence of a simple named import was not treated as proof of dead code.
- No installation, build, test run, UI launch, native gesture execution, or renderer benchmark was performed during this UI review. Suggested tests below are validation requirements, not passing results. The overall audit reports 67 narrow Node tests passing and one Expo configuration-plugin load failure; those results are not substituted for the component, TypeScript, or device checks needed here. Dependencies are absent, limiting full validation.
- Source measurements were computed from exact original strings with proposed changes held only in memory. No product files were modified. The sole deliverable write is this report outside the repository.

### A. Remove unread overlay selection/deletion props

Locations:
- `src/components/editor/caption-overlay.tsx:18–19`: `CaptionOverlay` accepts `selected` and `deletable`, but never reads either.
- `src/components/editor/image-layer-overlay.tsx:7`: `ImageLayerOverlay` accepts the same flags, but its body only uses `layer` and `geometry`.
- `src/app/editor.tsx:2024–2026,2045,2061–2062,2072–2073`: all production JSX supplies these inert flags.

Responsibility evidence: these two components are content renderers. Caption content delegates to `CaptionPresentation`; image content resolves its geometry and displays an Expo Image. Both use a pointer-events-disabled wrapper. Actual selection is represented by preview-scene targets at `editor.tsx:1842–1889`, scene gesture ownership at `1896–1919`, and `LayerTransformOverlay` at `2077–2079`, followed by the permanent input surface. There are no other production imports of the content overlay components.

Smallest change: remove only the two unread prop declarations and their eight physical caller lines. For the image component, change its inline prop shape without altering any rendering. Leave `LayerTransformOverlay.selected/deletable`, geometry, pointer events, content order, and scene gesture ownership intact.

Measured delta: **10 lines / 594 bytes**. This reduces a misleading UI contract; it does not establish reduced native rendering work.

Caller/test cascade: `tests/editor-coordinator.test.mjs:18–49` asserts the old `.selected` props even though the renderers ignore them. Replace those assertions with checks on selected preview-scene targets / `LayerTransformOverlay`, rather than weakening the behavioral test. Preserve its checks that inactive-cue selection does not seek, render an off-playhead hit target, mutate the project, or write storage. Other caption-overlay AST consumers include `dual-caption-editor-performance.test.mjs:533+`, `secondary-caption-contract.test.mjs:90+`, and `caption-script-editor-sync.test.mjs:645+`; their live caption/style/draft contracts remain.

Equivalence checks: primary/secondary/text/image selection, no-selection and timeline-gap states; selected active vs inactive cues; drag/resize/rotation/delete handles; draft preview line breaks; visible overlap order. Run `editor-coordinator`, `preview-object-hit-test`, `preview-scene-controller`, `preview-scene-gesture-audit`, `preview-scene-release-contract`, `caption-editing-preview-integrity`, and the overlay consumers above. Device checks must retain accessible handles and ensure the content layer still does not intercept gestures.

#### Related, not included in A: selection-derived geometry

`CaptionOverlay.selectionCaption/selectionStyle` at lines 11–12 and 24–28 are more subtle. Current caller geometry overrides their geometry role: primary uses `geometryForCaption` at `editor.tsx:2015`; translations/text supply explicit geometry at 2041/2059. Removing them could also eliminate the selected-translation helper at 2030–2033 and JSX at 2016–2018/2038–2040. However the existing guard can return an empty, noncollapsable native wrapper when an editor-selected caption exists but `displayCaption` is absent during playback in a gap (`editor.tsx:679–681`). Treat this broader change as **NEEDS EVIDENCE** for exact native-tree and editing-state equivalence. It is excluded from the recommended and measured total. Keep `selectionCaption` assertions until this separate change is validated.

### B. Close the translation request protocol and remove its unreachable fallback

Locations: `src/hooks/use-project-caption-translation.ts:30–38,175–275,277–282,291–326`.

The private `execute` has only two request constructors:
1. `refresh` / nested `makeRequest` at 291–315 always sets `incremental: true`, supplies the incremental operation, and places its completion warning on that request.
2. `synchronize` at 317–326 always supplies `manualEdits` and a trivial baseline-returning operation, with no completion warning.

`retry` either reuses the same request or calls `makeRequest`'s resume constructor. It cannot introduce a third shape. Incremental requests return from lines 214–223. Therefore the remaining request always has manual edits. Its fallback at 228–233, including the baseline-identity error and generic `commitProject`, is unreachable; the later warning block at 234–238 is also unreachable because only incremental requests have `completionMessage`.

Smallest change: keep the manual-edit branch and its closing brace; remove its `else` block and the later completion-warning block. The operation result no longer needs the `next` binding at line 199, but the operation itself must still be awaited. This exact narrow change is **10 lines / 479 bytes**. A discriminated union could document the two legal request shapes, but its extra source text was not included in this measurement and it is not required to make the narrow deletion.

Ownership to preserve: incremental commits at 204–208 apply to the *current* project; manual commits merge the edited text through `commitManualEdits`; cancellation is awaited at 210, error/operation identity and mount guards remain at 211–213, and `activeKindRef` switches to durable manual save at 225. Keep interruption handling, partial translation success, warning/retry state, foreground ownership, and preview-resource restoration. Do not replace current-project batch application with a single baseline commit.

Caller/test cascade: the editor calls the returned `refresh`, `synchronize`, and `retry`, not `execute` directly. The app does not call the service-level `refreshProjectCaptionTranslation`; the live hook batches through `translateNaturalCaptionBatch` in its `refreshIncremental`. `dual-caption-save-persistence.test.mjs:24+` expects the exact manual commit path; keep it. `translation-refresh-policy.test.mjs:112+` exercises selected/all refresh and resumed unfinished work.

Equivalence checks: selected/all and multi-batch refresh; accepted batches surviving later failure; retry from latest project; cancellation during download/translation vs noncancellable save; edits concurrent with translation; error/cleanup/unmount ownership; manual edits merged without overwriting intervening style changes. Relevant suites: `translation-refresh-policy`, `translation-partial-success`, `translation-cancellation-failure`, `dual-caption-save-persistence`, `dual-caption-source-conflict`, `editor-operation-lifecycle`, `translation-preview-ownership`, and `editor-coordinator`.

### C. Remove unreachable reorder-cancel plumbing, while keeping real cancellation

Locations: `src/components/editor/layer-timeline.tsx:453–457,811,991–1146`, specifically `VideoMoveGrip.finishGesture` at 1029–1047.

Both calls to `finishGesture` pass the literal `release`: the PanResponder release at 1115 and the native callback at 1123. PanResponder termination at 1116 and native cancellation at 1123 call `cancelGesture` directly. That callback at 1008–1017 resets feedback/timer/mode/armed state, releases the claimed gesture, and invokes `onGestureCancel`. Layout invalidation and unmount use the same cancellation path at 1127–1130.

Thus `finishGesture`'s `kind === 'release'` discriminator is invariant and its `else onReorderCancel` at 1039 cannot run. The corresponding `VideoClipBlock` prop at 811 and parent callback at 453–457 are unused.

Smallest change: make finish parameterless, unconditionally call `onReorderCommit` in its reorder branch, remove `onReorderCancel` from the prop and parent JSX, and update its two callers. Measured delta: **7 lines / 366 bytes**.

Do **not** replace termination with release, remove `onGestureCancel`, or unify the gap and reorder commit semantics. Cancellation is necessary; only one unreachable duplicate cancellation callback is removable.

Caller/test cascade: `VideoMoveGrip` inherits the `VideoClipBlock` prop shape. Host fixtures in `timeline-resize-lifecycle` and `timeline-video-gap-basis` may retain inert `onReorderCancel` fixture properties or remove them. `timeline-track-repair.test.mjs:176+,206+,292+` covers gap cancellation, native hold/reorder, and responder termination; preserve these behavioral checks.

Equivalence checks: normal release commits once; termination, two touches, geometry invalidation, unmount, and queued native cancellation commit nothing, clear preview feedback, and unlock scroll. Run `timeline-track-repair`, `timeline-resize-lifecycle`, `timeline-native-pan`, `timeline-native-thread-lifecycle`, `timeline-track-native-grab`, `timeline-video-gap-basis`, and `timeline-timing-gesture`.

### D. Remove the unreachable animation badge branch

Location: `src/components/editor/animation-browser.tsx:33,39–53`, `AnimationBrowser`.

Line 33 already returns `LineSpacingControl` whenever `textLayerSelected` is true. The true side of the later ternary, displaying `THIS TEXT LAYER`, is therefore unreachable. The scope buttons on its false side are the only branch that can render there.

Smallest change: remove lines 39–43 and 53, keeping the existing scope-button view and early-return behavior. Measured delta: **6 lines / 318 bytes**. No new abstraction is needed. Editor callers at 2384 and 2447–2458 still select the same modes.

Equivalence checks: text layer renders line spacing only with unchanged start/change/end history callbacks; caption mode renders scope buttons with disabled/no-selection semantics plus all filters, selection, and preview state. Relevant existing tests include `caption-line-spacing`, `caption-menu-behavior`, `text-animation-removal`, and `timeline-handle-layout`. Add a small true/false render assertion if current source-based checks do not establish the branch behavior.

### E. Remove unused external revision props, retain real journal revisions

Locations:
- `src/components/editor/script-editor.tsx:57`: unused `baseRevision` prop.
- `src/components/editor/dual-caption-editor.tsx:42`: unused `baseRevision` prop.
- `src/app/editor.tsx:2534,2559`: caller passes `project.updatedAt` to each.

The actual primary script revision is derived from sorted caption content at `script-editor.tsx:210–214`, stored in opening state at 222–224, and compared with the journal at 267. The dual editor derives its opening revision from caption drafts at `dual-caption-editor.tsx:104–106` and compares it at 144. These content-derived revisions intentionally avoid resetting a live draft on an unrelated project/style update.

Smallest change: remove exactly those two prop lines and two caller lines. Measured delta: **4 lines / 130 bytes**. Do not remove the similarly named internal opening-state field or persisted `EditorDraftJournal.baseRevision`; both remain live.

Caller/test cascade: fixtures in `caption-script-editor-sync`, `dual-caption-editor-performance`, `keyboard-ui-repair-host`, and `editor-draft-journal-byte-boundary` pass this unused prop. JavaScript fixtures do not need semantic changes just because the prop disappears; removing their unused keys is optional. Preserve tests around incoming caption changes even if their accompanying `baseRevision` strings are dropped (`caption-script-editor-sync:857,883,902`). In particular, the dual performance test checking caption changes when `updatedAt` does not change guards the intended revision semantics.

Equivalence checks: recovery vs stale journal, changed text with unchanged updatedAt, style/transform change while a recovery read is pending, reopen, pending-save cleanup, and late asynchronous journal reads. Run both editor suites, journal byte-boundary/recovery suites, and `caption-translation-contract`.

### F. Remove the write-only suspension counter, retain all ownership checks

Locations: `src/hooks/use-timeline-video-controller.ts:96,104,198`.

`translationSuspensionGenerationRef` is initialized at 104 and incremented solely to populate the suspension object's `generation` at 198. Nothing reads that generation. The declared field at 96 is also unused. Actual suspension ownership uses object identity and `restored` at 217–219; transport target invalidation separately increments **`generationRef`** at 207.

Smallest change: remove the three lines for the unused field, ref, and assignment. Measured delta: **3 lines / 144 bytes**. Keep `generationRef`, prepare tokens, AbortControllers, pending target invalidation, suspension identity, and exactly-once restore.

Equivalence checks: repeated restore, stale restore after a new suspension, unmount during native unload, pending preparation during translation admission, release of both players before translation starts, and re-admission at the saved clock. Run `translation-preview-ownership`, `editor-operation-lifecycle`, and `video-transition-preview`; test native decoder release/restore on device before claiming resource benefits.

### G. Share the real undo/redo restore operation

Location: `src/app/editor.tsx:817–849`, `undo` and `redo`.

The handlers differ only in source/destination stack and the local snapshot name. Both pop, push current session into the opposite stack, trim the destination, refresh availability, clear any interaction start, synchronize transport, replace the project, reconcile the same five selection fields, and persist.

Smallest reduction: one local restore helper receiving the source and destination arrays, plus two one-line wrappers. Preserve the exact order. An in-memory proposal replacing the original 33-line span with an 18-line implementation measures **15 lines / 680 bytes** saved. This consolidates one invariant rather than moving two copies into another file. It is optional and is not part of the high-confidence deletion total.

Important constraints: capture `editorSession.current()` before installing the restored snapshot; keep identity/no-entry behavior; keep the 24-entry / estimated 16 MiB history caps at 2907–2908 and their helpers; do not call the normal `pushUndo` helper because that clears redo. Retain transport and selection reconciliation, persistence sequencing, and transactional gesture history.

Equivalence checks: empty stacks, repeated undo/redo, new edit invalidating redo, history caps, selection disappearing/reappearing across snapshot changes, gesture produces one history item, pending writes, failed save followed by newer undo/redo, and queued asynchronous commits. `editor-coordinator.test.mjs:52–115,185+,549+,572+` and related history tests provide much of the required matrix. Typecheck and run these tests before adoption; no UI equivalence was executed here.

### NEEDS EVIDENCE and KEEP decisions

#### Old timeline timer: do not delete on static production-call inspection alone

`VideoMoveGrip` uses `longPressTimerRef` at `layer-timeline.tsx:1005`, its cleanup helpers at 1010–1011/1025–1028, the timer path at 1075–1081, and the initial `none` transition at 1085–1092. Production call sites pass a movement object into `begin` (1113/1121); that makes `none` at 1067 appear unreachable after grant, while the native recognizer already supplies hold semantics. However tests deliberately call responder grant without movement, wait for the timer, and inspect this fallback. `timeline-resize-lifecycle.test.mjs:125–151` and `timeline-track-repair` exercise those shapes; `editor-logic.test.mjs:372,533` contains source assertions for the timer.

Classification: **NEEDS EVIDENCE**. Verify the exact React Native callback contract, accessibility/fallback routes, and device hold/pan arbitration first; then decide whether the tests preserve required behavior or an obsolete implementation. No proposed savings are counted. Do not conflate this larger state-machine change with the proven dead callback in C.

#### Small unconsumed fields: real but low priority

- `useTimelineVideoController`'s `_onError` parameter at line 53 is never called; the editor supplies `setError` at `editor.tsx:439`. Errors flow through `sourceFailure` / `failSource` at controller lines 265–272 and the editor's recovery UI. Removing the unused parameter requires preserving the following `surfacesAdmitted` argument position and updating `translation-preview-ownership.test.mjs:169`. This is optional contract cleanup, not a claim that error reporting can be removed.
- `SlotRuntime.prepareToken` at controller line 36 duplicates its base type's field at 31. Its actual runtime token is essential. Dropping only the duplicate type declaration is type hygiene, not a meaningful compression headline.
- The controller's returned singular `player` alias at 784 has no current production consumer; the plural players and active slot remain required. Prefer keeping this tiny exported contract until its test/consumer surface is explicitly tightened.
- `use-keyboard-viewport.ts` stores redundant `geometryKey` values in lifetime/reservation objects (13–14,26,65,89); readers use configuration identity instead. Removing those write-only duplicates is possible, but the original computed key at 7, configuration lifetime at 9, and stale-measurement protection are live. Do not remove these broader mechanisms for a few fields.
- `PreviewNotice` in `video-transition-overlay.tsx:410+` has an unused optional compact mode in current callers. Too small to justify prioritizing over its actual preview/error responsibilities.

#### KEEP: shared ownership and behavior that only looks redundant

- Native caption presentation is the bridge to the shared caption painter, not an alternative renderer to collapse into React text. Font preparation, stale-completion guards, editing/authored flags, and geometry serialization preserve parity. `requireNativeView('CaptionMedia')` is registered by `modules/caption-media/android/src/main/java/app/captionstudio/media/CaptionMediaModule.kt:54,71–77`, including destruction cleanup.
- `RefractBackground` is a live Android-native view with a platform fallback, not an unreferenced effect file. Its name matches `CaptionRefractModule.kt:8`; focus-driven activation limits idle work.
- Timeline native recognizers and JS fallback callbacks have distinct delivery and cancellation responsibilities. Epoch/touch-ID checks, axis intent, two-finger cancellation, resize invalidation, scroll locks, boundary feedback, and accessibility actions are not dispensable duplication.
- Primary and dual caption editors share the concept of drafts, but differ in mutation semantics, recovery, row subscriptions, save acceptance, and preview synchronization. The dual editor's mutable store with per-cue external subscriptions avoids re-rendering every cue on each keystroke. Do not merge both editors into a generic form or one large document state just to shorten code.
- `createCaptionJournalQueue` invalidates queued writes before journal cleanup. Save acceptance and recovery-cleanup completion are intentionally separate states. A generic Promise chain without that ownership is not equivalent.
- `useTimelineVideoController`'s two-player lifecycle, first-frame and decoded-time readiness, latest-target drain, source/clip reuse rules, preloading, gap clock, aborts, and source recovery are separate invariants. Repeated `useEventListener` calls cannot be replaced with a data-driven loop that changes Hook ordering.
- `VideoTransitionOverlay` uses additional view surfaces over the existing players, not an accidental second decoder controller. Transition compositing/cover frames, failed-frame keys, transforms, and standby mute behavior must retain timing and player ownership.
- `useVoiceoverRecorderState` observes a recorder owned by the editor. Recording can outlive the open panel, so `observed || state.isRecording` and the event/poll distinction are meaningful. Its threshold comment describes intended Expo 57.0.5 parity; that parity was not independently executed here.
- `useForegroundOperation` waits for native interruption handling before showing the resumed alert. `useProjectAudioWaveforms` keeps mounted/in-flight ownership; `useTimelineAudioController` delegates real per-clip playback and disposal. These are not passive wrappers that can all be dropped.
- `AdaptiveDialog`, `KeyboardViewport`, and focused-input reveal handle short-wide layouts, Android keyboard inset accounting, stale layout measurements, and accessibility. Similar modal styling does not establish equivalent back/keyboard/focus behavior.
- `OperationOverlay` intercepts BackHandler without a native modal. `MediaLoadingOverlay` composes it with `AdaptiveDialog`; `PlaybackLoadingOverlay` instead chooses an inline indicator after a frame has been presented and a native modal before that. Collapsing these to one generic modal would change lifecycle and presentation.
- Persisted horizontal scrolling restores per-project/tool offsets with a scheduled native scroll. Video angle scrubbing validates measurements against orientation/geometry epochs. Neither should be replaced with a simpler-looking control without interaction evidence.

### Complete reviewed-file inventory and responsibility map

All line counts below are the complete file lengths at the pinned revision. “E” means `src/app/editor.tsx`, “I” means `src/app/index.tsx`. A named inbound caller describes production reachability, not merely test usage. Candidate labels apply only to the narrow portions above; all other responsibilities are KEEP.

| Reviewed file | Lines | Production entry/caller | Meaningful responsibilities inspected; disposition |
|---|---:|---|---|
| `src/app/_layout.tsx` | 76 | Expo Router root convention | Bundled/imported font startup, safe-area/root shell, responsive headers, mount-time cache/diagnostic maintenance and stack routes; KEEP |
| `src/app/editor.tsx` | 2993 | Expo route, navigation from I | Project loading/recovery, session mutation and persistence, history, caption/translation jobs, export, video/audio/voiceover control, preview scene selection/gestures, timeline/tools, dialogs, draft coordination, back handling; A/E/G caller changes only |
| `src/app/index.tsx` | 307 | Expo index route | Project list refresh, import, thumbnails, open/recovery, delete and unreadable-project handling, navigation; KEEP |
| `src/app/notices.tsx` | 43 | Router stack and navigation | Selected legal notice's dynamic loader, async lifetime, tab selection, loading/error and selectable scroll content; KEEP |
| `src/app/privacy.tsx` | 197 | Router stack and navigation | Privacy explanation, local model/storage controls, diagnostic sharing and notices navigation; KEEP |
| `src/app/thank-you.tsx` | 37 | Router stack and navigation | Acknowledgment/support screen and return navigation; KEEP |
| `src/components/editor/adaptive-dialog.tsx` | 133 | E, loading overlays, ScopeSheet, VideoTools | Responsive modal surface, scrolling, keyboard viewport/input reveal, footer/back behavior; KEEP |
| `src/components/editor/animation-browser.tsx` | 150 | E | Preset filters, animation selection/scope, scroll restoration, text line-spacing interaction; D only |
| `src/components/editor/caption-generation-cancellation-ui.ts` | 32 | E | Await cancellation terminal state; distinguish idle, stop failure, completion and exceptions; KEEP |
| `src/components/editor/caption-overlay.tsx` | 36 | E | Caption content ordering, style/geometry fallback, native presentation delegation, editing/authored flags; A only, broader selection fallback NEEDS EVIDENCE |
| `src/components/editor/caption-presentation.tsx` | 60 | CaptionOverlay | Native caption serialization, font preparation/cache/retry and guarded async completion, native view props; KEEP |
| `src/components/editor/caption-save-recovery.ts` | 33 | ScriptEditor, DualCaptionEditor | Save cleanup status and epoch-owned journal write queue; KEEP |
| `src/components/editor/dual-caption-editor.tsx` | 794 | E | Per-cue external draft store, incoming-pair reconciliation, bilingual list/input sizing and navigation, recovery/save/cleanup/close ownership, dirty counts; E prop only |
| `src/components/editor/dual-language-choice-copy.ts` | 17 | DualLanguagePicker | Pure automatic-vs-manual second-language choice copy; KEEP |
| `src/components/editor/dual-language-picker.tsx` | 112 | E | Language choices, automatic/manual explanatory copy, pending/error/close guards, accessible compact modal and delegated selection action; KEEP |
| `src/components/editor/extract-audio-source-sheet.tsx` | 78 | E | Source selection, extraction choice/progress and dismissal; KEEP |
| `src/components/editor/font-browser.tsx` | 200 | E | Font availability/import/filter selection, nested color edit and back ownership, keyboard sizing and accessibility isolation; KEEP |
| `src/components/editor/font-color-picker.tsx` | 135 | FontBrowser | Hex editing, hue/brightness controls, touch coordinate handling, preview and accessibility; KEEP |
| `src/components/editor/image-layer-overlay.tsx` | 17 | E | Resolved image geometry, transform/opacity and content image; A props only |
| `src/components/editor/keyboard-viewport.tsx` | 33 | E, caption/editor dialogs, FontBrowser, WatermarkSheet | Measured frame attachment and bounded keyboard/safe-area reservation; KEEP |
| `src/components/editor/layer-timeline.tsx` | 1517 | E | Timeline virtualization/visible regions, lanes and overlap selection, ruler/playhead, clip/audio/caption/layer rows, waveform/thumbnail views, trims, gaps, reorder and staged feedback, native/fallback gesture integration, accessibility and scroll coordination; C only, timer NEEDS EVIDENCE |
| `src/components/editor/layer-transform-overlay.tsx` | 41 | E | Selected-object border and transform/delete affordances; KEEP, actual selection owner |
| `src/components/editor/persisted-horizontal-scroll.tsx` | 42 | E, AnimationBrowser, VideoTools | Project/tool-scoped offset persistence and scheduled restoration/cleanup; KEEP |
| `src/components/editor/playback-loading-overlay.tsx` | 34 | E | Existing-frame-aware preparation presentation and blocking dialog choice; KEEP |
| `src/components/editor/project-media-recovery-prompts.ts` | 20 | E, I | Native confirmations for re-linking compatible original video, including cancel/dismiss resolution; KEEP |
| `src/components/editor/scope-sheet.tsx` | 64 | E | Scoped edit action choice with current-caption availability through AdaptiveDialog; KEEP |
| `src/components/editor/script-editor.tsx` | 800 | E | Sorted content revision, recovery session, draft operations/split/join, save and cleanup states, list virtualization/measurement, scroll/seek ownership, selection/preview and keyboard behavior; E prop only |
| `src/components/editor/timeline-native-gesture.tsx` | 60 | LayerTimeline | Native detector vs fallback surface, latest callbacks and lifecycle/disposal bridge; KEEP |
| `src/components/editor/timeline-native-pan.ts` | 177 | TimelineNativeGestureView | Worklet pointer intent/hold ownership, JS delivery epochs and cancellation/release, native recognizer construction; KEEP |
| `src/components/editor/video-tools.tsx` | 260 | E | Rotation/scale/fit and related controls, interaction boundaries, angle scrubber coordinate measurement and stale-layout protection; KEEP |
| `src/components/editor/video-transition-overlay.tsx` | 429 | E | Preview and composite transition surfaces, readiness/fallback covers, active player clock, transition transforms/opacity, source framing and standby lifecycle; KEEP |
| `src/components/editor/watermark-sheet.tsx` | 73 | E | Watermark text entry/reveal, keyboard sizing, maximum-count and blank-text guards, add/select/remove/close actions; KEEP |
| `src/components/media-loading-overlay.tsx` | 26 | E, I | Composes operation overlay with adaptive dialog for import/loading progress, counts and back handling; KEEP |
| `src/components/operation-overlay.tsx` | 25 | E, MediaLoadingOverlay | Non-native-modal operation surface, BackHandler interception and cleanup; KEEP |
| `src/components/refract-background.tsx` | 15 | I | Platform-gated native shader background with fallback and activation; KEEP |
| `src/hooks/use-editor-runtime-policy.ts` | 18 | E | AppState subscription and memoized policy deriving admitted resources/behavior; KEEP |
| `src/hooks/use-focused-input-reveal.ts` | 28 | DualCaptionEditor, AdaptiveDialog, FontColorPicker, WatermarkSheet | Reveal-controller lifetime, viewport ref attachment and scroll callback updates; KEEP |
| `src/hooks/use-font-library.ts` | 28 | FontBrowser | Font controller subscription/open-close lifetime, guarded load ownership; KEEP |
| `src/hooks/use-foreground-operation.ts` | 60 | E | AppState interruption ownership, async interruption completion and resumed reporting; KEEP |
| `src/hooks/use-keyboard-viewport.ts` | 115 | KeyboardViewport | Keyboard metrics/events, frame measurements, epoch/configuration stale-callback rejection, overlap and inset accounting; KEEP apart from optional redundant stored fields |
| `src/hooks/use-preview-scene-gesture.ts` | 106 | E | Scene-controller callback/target refs, PanResponder delegation, gesture identity and teardown; KEEP |
| `src/hooks/use-project-audio-waveforms.ts` | 65 | E | Missing waveform generation, per-request in-flight tracking, callback refs/mount guards; KEEP |
| `src/hooks/use-project-caption-translation.ts` | 342 | E | Incremental accepted-batch translation, closed request/retry protocol, progress/error/warning, cancellation and foreground/suspension ownership, manual edits; B only |
| `src/hooks/use-script-editor-exit.ts` | 110 | E | Close and timeline reveal, keyboard dismissal, coalesced measured scroll positioning, pending-reveal and RAF cleanup; KEEP |
| `src/hooks/use-timeline-audio-controller.ts` | 55 | E | Timeline target mapping, clip playback parameters, controller updates and disposal; KEEP |
| `src/hooks/use-timeline-video-controller.ts` | 822 | E; VideoTransitionOverlay imports type | Two-player preparation/drain/readiness, clocks/gaps, preloading, pause/seek/project changes, failure/retry, runtime admission and translation release/restore; F only |
| `src/hooks/use-voiceover-recorder-state.ts` | 49 | E | Editor-owned recorder observation, active polling/idle event refresh, threshold updates and teardown; KEEP |

### Suggested implementation order

1. D/E/F, then A: isolated contract/dead-state deletion with local assertions updated to behavioral ownership.
2. B and C as separate changes with their cancellation/ownership test matrices.
3. G only if reducing duplicated history invariants is worth the test effort.
4. Leave the broader overlay fallback and timeline timer alone until evidence resolves their compatibility questions.

For every change, inspect the diff for accidental deletion of accessibility props, cancellation handlers, measured-layout guards, content order, journal revision checks, or native ownership. Run TypeScript and the relevant tests once dependencies are available, then perform focused Android gesture/keyboard/playback tests. Only a production bundle comparison and device/profile measurements could establish bundle or runtime savings.


## Caption Studio compression audit: libraries, services, types, shim and shared data

### Results first

At `3ae54ddb3cf3253037a1c53aaf86177d09c7770a`, five independently traceable removal groups contain **583 existing production-source lines / 21,530 UTF-8 bytes**. These are exact gross spans, not a patch or a claim of bundle savings. They comprise the unused proportional translation cutter, unused media classifier, obsolete translation-refresh workflow, unused JS caption-timing branch, and old script input/time-split APIs. Imports and affected test edits are excluded from that count. All proposed source removals are limited to current-repository production reachability; test-only code must be retired or moved deliberately, with live feature coverage preserved.

One bounded consolidation is supported: duplicate UTF-8 counting (one duplicate body is 15 lines / 444 bytes). Model-file identity/atomic marker writing is a conditional **NEEDS EVIDENCE** candidate (one copy is 26 lines / approximately 840 bytes), because failure ordering differs and verification policies must remain separate.

A worthwhile runtime-only improvement is replacing quadratic audio-source/video-clip membership scans in project decoding after duplicate IDs have already been rejected. No device timings, release bundle, APK, memory profile or startup measurements were obtained. Removing unimported modules may save **zero** shipped bytes. Type-only declarations normally have no runtime bytes. Do not equate deleted repository bytes with runtime or binary reduction.

**Coverage:** all 145 files were inventoried, reference-scanned and directly read in full, including the full-file responsibility supplements below. This is not a repository-wide “nothing else can be reduced” conclusion or exhaustive runtime proof. No repository files were edited and no installs or builds were performed. Runtime equivalence of the proposed changes has not been tested.

### Prioritized recommendations

#### R1 — SAFE REMOVE: retired proportional translation cutter

- **Location:** `src/lib/caption-translation-cut.ts:1–158`; `packCaptionDocuments:29–63`, `cutTranslatedDocument:65–91`, private proportional allocation helpers.
- **Responsibility/evidence:** packs whole scripts and apportions translated text back to cues. Repository-wide symbol/module searches find no production consumer. The only importing caller is `tests/caption-translation-cut.test.mjs:14`; `tests/caption-translation-contract.test.mjs:159–160` explicitly prohibits these symbols in the current workflow. The current hook translates cue-ID batches (`src/hooks/use-project-caption-translation.ts:44–115`, call at71).
- **Smallest reduction:** remove this module, its test import, and obsolete cutter-specific cases at `tests/caption-translation-cut.test.mjs:94–132`. **Keep lines16–92**, which test the live language catalog, untranslated-output detection, Chinese/English/Korean grouping and per-clip language selection. The mixed filename is not grounds to delete that test file.
- **Measured gross source:** 158 lines / 5,309 bytes; confidence high. Binary/runtime savings unmeasured, plausibly zero because it is not imported.
- **Cascade/checks:** rename the retained test file if useful; preserve multilingual grouping assertions. Re-run translation contract and grouping/language tests, and search imports after deletion. No change to native translation alignment.

#### R2 — SAFE REMOVE: unused generic media classifier

- **Location:** `src/lib/picked-media-kind.ts:1–40`, `classifyPickedMedia:30–40`.
- **Responsibility/evidence:** extension/MIME categorization for a generic picker. Only `tests/storage-boundaries.test.mjs:10,64–70` imports/calls it. Current `src/services/media-import.ts` uses media-specific pickers and probes/validates the selected media instead; app/native/config searches found no classifier dispatch.
- **Smallest reduction:** remove the module and its obsolete classifier test/import; keep all other storage-boundary tests and current MIME/probe rejection paths.
- **Measured gross source:** 40 lines / 864 bytes; high confidence. No claimed shipped-size change.
- **Checks/risks:** video/audio/image import, misleading extensions, invalid/missing tracks and permission recovery remain covered by the actual importer/native probes. Removing this helper does not authorize accepting unprobed files.

#### R3 — SAFE REMOVE: unused whole-refresh workflow and exclusive helpers

- **Location:** `src/services/project-caption-translation.ts`, `refreshProjectCaptionTranslation:76–120`, private `translateCaptionDocument:195–215`. Exclusive cascade: `src/lib/caption-translation-commit.ts`, `translatedSliceReviewFlags:32–42`; separately test-only `assertAutomaticTranslationWroteText:75–92`.
- **Evidence:** no production or test invocation of the refresh entry point; its private translator has only that caller. Current `useProjectCaptionTranslation` directly invokes `translateNaturalCaptionBatch` and performs incremental per-batch validation/commit. `translatedSliceReviewFlags` has no remaining production caller when this branch is removed. `assertAutomaticTranslationWroteText` already has only test callers.
- **Smallest reduction:** remove just those bodies and newly unused imports at workflow8–12,16–17,23–28, and the unused `CaptionBlock` type in29. Keep `prepareOptionalDualCaptionTrack:39–74`, `synchronizeProjectDualCaptionEdits:122–144`, changed-primary-ID detection146–151 and shared validation153–193. Keep **live** `automaticTranslationCueWrites`, `usableAutomaticTranslation`, `commitTranslationAttempt`, translation models/providers and language-policy code.
- **Measured gross source:** 95 lines / 4,082 bytes across the four spans, excluding import cleanup. High reachability confidence; production behavior-equivalence tests not run.
- **Tests/cascade:** `tests/caption-translation-contract.test.mjs:162–168` currently asserts source text in the obsolete workflow. Retarget those checks to the live hook and its batch commit behavior; do not retain an unreachable implementation just to satisfy regex tests. Preserve failure flags, cue IDs, provider attribution, partial-batch persistence, cancellation and manual-edit preservation tests. The separate unreachable fallback-commit branch in the hook is not included in this report’s totals; the accepted-batch commit path must remain.

#### R4 — SAFE REMOVE: production-unreachable JS playback-timing branch

- **Location:** `src/lib/caption-text-breaks.ts`: `TimedCaptionText:7–12`; `alignCaptionTimedWords:59–86`, `captionPlaybackTimedWords:88–96`, `spreadCaptionTokensAcrossRange:98–127`; private timing types/helpers222–280; independently test-only `compactCaptionToken:218–220`.
- **Evidence:** exhaustive identifier/module search finds only internal edges among these timing helpers and calls in `tests/caption-text-breaks.test.mjs`; no app, preview, export or native bridge calls them. `captionPlaybackTimedWords` is the unused branch’s root. `captionGraphemeSpans:282–304` and the general spoken-token/Unicode/layout helpers remain live.
- **Smallest reduction:** remove exactly those disjoint spans, leaving tokenization, grapheme-safe offsets, CJK counting and layout spacing intact.
- **Measured gross source:** 137 lines / 4,462 bytes. High reachability confidence. JS/native timing equivalence is not asserted, and native timing implementations are not removal targets.
- **Checks/risks:** preserve meaningful Unicode fixtures (emoji sequences, combining marks, apostrophes, CJK/Thai, punctuation) against the live preview/native pipeline. Retire only tests of the unused JS API, or explicitly move a needed oracle into test-only support. Do not remove the whole mixed tokenization test file.

#### R5 — SAFE REMOVE: old script-input and split-at-playhead APIs

- **Location:** `src/lib/caption-script.ts`: `updateCaptionScriptInput:103–144`, `splitCaptionScriptBlockAtTime:212–254`, exclusive private helpers `nearestWordBoundary:297–310`, `textCursorForWordBoundary:312–330`, `withCaptionBoundary:332–346`. Cascade `src/lib/caption-text-breaks.ts`: `captionTextOffsetForSpokenBoundary:188–192`, `captionTextNearestSpokenBoundary:194–206`.
- **Evidence:** time-split/input entry points have only tests as callers. Current `src/components/editor/script-editor.tsx:438` calls `updateCaptionScriptText`, and466 calls explicit cursor-based `splitCaptionScriptBlock`; line-break contract test223 expressly rejects the old input wrapper in the handler. The two spoken-boundary exports are used only by the removed private time-split helper.
- **Smallest reduction:** delete this closed branch and unused imports. Retain cursor split146–210, merge256–295, reconciliation, source-anchor transformations in those live operations, and Unicode-safe token/offset primitives.
- **Measured gross source:** 153 lines / 6,813 bytes, disjoint from R4. High reachability confidence.
- **Checks/risks:** update `caption-script-line-breaks`, `caption-emoji-timing`, `editor-logic` tests; keep coverage of explicit line breaks, cursor splitting, undo/reconciliation, emoji-safe positions and source/timeline ownership against current UI APIs. This is not a proposal to remove current editing behavior.

#### R6 — CONSOLIDATE: move old English/Chinese fixture construction out of runtime code

- **Location:** `src/lib/caption-tracks.ts`, `createEnglishChineseCaptionTrack:92–120`, `projectEnglishChineseCaptionLanguage:409–411`, private `englishChineseTarget:702–710`, `translationTargetStyle:712–720`.
- **Evidence:** fixture factory has many test callers (15 test files in the identifier scan), no app/service caller. Current production track preparation uses generic `createTranslationCaptionTrack`. Wrapper language function and two private helpers are exclusive to this old factory except direct tests.
- **Smallest reduction:** migrate fixtures to a test helper built on `createTranslationCaptionTrack`, then remove the obsolete source APIs. Measured body spans are **51 lines / 2,231 bytes**; this is a relocation/consolidation, not necessarily a net repository-line reduction.
- **Keep:** `normalizeEnglishChineseCaptionLanguage` in `caption-languages.ts` still serves real language resolution/untranslated detection; Chinese/English track-ID constants remain used by `translationTrackIdForLanguage`; default translation style and `stackedTranslationLayout` remain live. Do not remove those on zero-external-call counts alone.
- **Confidence/checks:** high caller evidence, medium migration confidence until fixture equivalence is checked. Preserve track IDs, explicit default-style object shape, automatic target-language selection, origin/provider metadata, timing, style inheritance and all existing bilingual assertions. The old wrapper ignores its stackGap option; a generic-factory substitution that starts honoring it changes fixtures. Avoid broad test fixture rewrites mixed with production logic changes.

#### R7 — CONSOLIDATE: identical UTF-8 byte-counting bodies

- **Location:** `src/services/editor-draft-journal.ts:39–53` and `src/services/timeline-transcription-cache.ts:15–29`, private `utf8Bytes`.
- **Evidence:** both 15-line / 444-byte bodies are identical, including four-byte surrogate-pair treatment and three-byte lone-surrogate handling. Both enforce serialized data byte limits without allocating encoded buffers.
- **Smallest reduction:** one pure helper with imports in both services. Gross duplicate body =15 lines /444 bytes; net savings are smaller after module/export/import overhead and have not been measured as a patch.
- **Do not merge the services:** draft journal unreadable/previous-file/quarantine behavior protects user edits; a transcription cache is disposable and recomputable. Their storage/error policies are different.
- **Confidence/tests:** high equivalence confidence for extraction. Update module-injection test harnesses for the new import. Test ASCII, CJK, surrogate pairs and lone surrogates, missing stat size, the 4 MiB boundary, and atomic/crash recovery. Keep the no-allocation implementation rather than blindly substituting Buffer/TextEncoder.

#### R8 — NEEDS EVIDENCE: potential shared atomic model marker mechanics only

- **Location:** `src/services/transcription.ts`, `writeModelVerificationMarker:327–344`, `modelFileIdentity:346–353`; `src/services/caption-translation.ts`, `modelFileIdentity:601–608`, `writeTranslationModelVerificationMarker:610–627`.
- **Evidence:** both capture filename/size/modified/created identity and atomically promote a `.sha256.download` marker to `.sha256`, cleaning staging on failed move. Each pair is26 lines (845 vs838 bytes). There is a constructor/evaluation-order difference: transcription encodes before constructing the marker; translation constructs the marker first. Successful behavior is duplicated, but filesystem getter/constructor failures could differ.
- **Smallest reduction:** share the pure identity accessor first, or extract a service-level marker helper only after testing failure ordering. Keep pure `lib/model-verification.ts` Expo-independent. Expected gross duplicate body ~26 lines; net source/bundle change unknown.
- **KEEP verification policies:** transcription305–324 hashes and checks file identity again after hashing; translation629–640 can accept a matching identity marker before hashing. Do not compress those into one policy or weaken SHA verification, cancellation, lease identity or corrupt-file cleanup.
- **Confidence/tests:** medium until injected filesystem tests cover invalid identity, stale staging, marker delete/write/move failures, mutated file identity, retries and interruption. Security/lifecycle boundary warrants separate small commit.

#### R9 — KEEP: standalone rethrow cleanup is too small to recommend

- **Location:** `src/services/font-storage.ts:116–117`, `src/services/project-media.ts:278–279`.
- `catch (error) { throw error; }` is redundant before the existing finally, but deleting four lines is cosmetic and does not reduce a meaningful responsibility. **Not recommended as a standalone change.** Keep staging cleanup, committed flags, exception propagation and all other catches that wrap, suppress or compensate failures. If either function is changed for a substantive reason, removing the redundant rethrow can be incidental cleanup after existing failure tests pass. No binary/runtime benefit is claimed.

#### R10 — RUNTIME REDUCTION / NEEDS EVIDENCE: index validated audio-source/video-clip IDs once

- **Location:** `src/lib/project-schema.ts`, `decodeVersionTwoProject:49+`; repeated `audioSources.find` at103 and `clips.some` at108; existing `clipIds` Set at126.
- **Evidence:** decoded video IDs are unique before mapping (`uniqueIds(decodedClips):61`); audio-source IDs are unique at96; audio-clip IDs are checked at100. IDs/objects are freshly decoded plain values. Therefore replacing first-match `find` with Map lookup does not change duplicate selection. Array bounds are5,000 audio sources,10,000 audio clips and5,000 video clips.
- **Smallest reduction:** create audioSourceById after uniqueness and reuse the Set already returned by uniqueIds(decodedClips) at61; mapped clips retain those IDs, so remove the later duplicate Set construction at126. Replace only the two lookups. Keep missing-source check102 first and all bounds/attachment/origin/recoverable validation in its original order104–117. Do not move validation or change error text. Existing clip Set continues to serve caption/layer references127–139.
- **Benefit:** worst-case membership work changes from O(audioClips × audioSources + attachedAudioClips × videoClips) to O(audioSources + videoClips + audioClips), trading an additional map allocation for fewer comparisons. The two scan terms can each reach50 million comparisons at schema maxima. This is an analytical bound, **not measured device time**, and may increase source bytes.
- **Confidence/tests:** conditional equivalence for the live persisted-JSON domain; runtime proof unrun. The exported decoder also accepts direct in-memory arrays, and decodeArray.map plus uniqueIds.forEach skip sparse holes. A new Map constructed from a sparse mapped array can change failure behavior. Characterize or preserve that exported-input contract before acceptance; do not silently add rejection as a compression fix. Add sparse/direct inputs, duplicate/missing IDs, first malformed reference ordering, invalid source bounds plus invalid anchor, empty lists, maximum-size JSON fixtures, and exact success snapshot/error equivalence.

#### R11 — RUNTIME REDUCTION: resolve geometry once per serialized value

- **Location:** `src/lib/export-render-plan.ts:198–200` (image layer) and302–304 (`serializeStyle`). Each invokes `resolveLayerGeometry` three times on the same input to obtain scale/scaleX/scaleY.
- **Smallest reduction:** compute a local geometry value once per image/style and use its fields. Avoid two redundant object calculations per invocation; may add a source line rather than remove one. No benchmark or binary saving.
- **Confidence/tests:** high for ordinary decoded immutable project data. Retain all constraints and verify serialized render-plan deep equality for uniform/nonuniform scales, invalid geometry and shared styles. Do not replace geometry validation with direct raw properties.

#### R12 — NEEDS EVIDENCE: avoid rebuilding the full export plan after font resolution

- **Location:** `src/services/project-export.ts:36,49–50`: build an unresolved plan, validate media and reserve storage, resolve fonts, then rebuild the complete plan when any font URI resolves.
- **Potential:** populate only resolved font URIs in the validated plan instead of rebuilding timeline, captions, words, layers, style maps and translations. Runtime allocation reduction possible; source/binary benefit unknown.
- **Why not a safe shortcut yet:** render-plan styles are cached/shared; blindly mutating one style can affect several consumers. Rebuild also repeats validation. A replacement must preserve imported/bundled/unresolved font semantics, error/cancellation ordering and all style overrides without re-reading mutable project data after awaits.
- **Checks required:** full plan deep equality and native payload parity for mixed fonts, word styles, visual layers, multiple translations, missing fonts and cancellation; first validate snapshot/immutability assumptions. Preserve source validation, storage checks, publication-success semantics and artifact protection. Low priority until profiled.

### Additional small, bounded source candidates

Each row was checked with repository-wide identifier references, including tests. “Test-only” does not mean its tests are worthless: migrate meaningful assertions to the live operation, or move fixture/oracle code to test support. These are optional cleanups after R1–R5. Savings list existing body spans only; imports, private cascades and test edits are not included. No runtime or binary savings have been measured for any row.

| Class | File and symbol / exact lines | Existing lines / bytes | Evidence, boundary and tests |
|---|---|---:|---|
| SAFE REMOVE | `src/lib/animation-timing.ts` `realWordAnimationProgress:45–60`, `isWordTimedAnimation:62–64`, `isActiveWordHighlightAnimation:66–68` | 22 /739 | Only animation-timing tests. Remove now-unused preset lookup import; retain live animation clocks/state and native parity fixture tests. Test preset metadata directly. |
| SAFE REMOVE | `src/lib/audio-timeline.ts` `constrainAudioClips:304–315` | 12 /530 | Only export-audio-boundary regression tests. Keep live clampAudioFades and current timeline splice/audio render behavior. |
| SAFE REMOVE | `src/lib/caption-languages.ts` `supportsAutomaticCaptionTranslation:91–93`, `automaticTranslationTargetTags:102–108` | 10 /579 | Only catalog/cutter/Urdu-removal tests. Test live choices/pair support instead; do not delete supported language catalog or normalization. |
| SAFE REMOVE | `src/lib/caption-tracks.ts` `updatePairedCaptionText:177–180` | 4 /269 | Only tests. Batch updater is live; retarget single-edit fixtures to it. |
| SAFE REMOVE | `src/lib/caption-tracks.ts` `stackedTranslationPosition:735–741` | 7 /224 | No callers, including tests. Keep `stackedTranslationLayout:743–761`, called internally by pair resolution. |
| SAFE REMOVE | `src/lib/dual-caption-drafts.ts` `adoptCommittedDualCaptionDrafts:48–63` | 16 /795 | Only dual-caption-translation tests. Keep current revision journal, merge and conflict behavior; verify actual editor caller flow. |
| SAFE REMOVE | `src/lib/keyboard-viewport.ts` `keyboardViewportCoversBottom:18–22` | 5 /324 | Only keyboard viewport tests. Bottom gap/overlap primitives remain live. |
| CONSOLIDATE | `src/lib/model-download-resume.ts` `encodeModelDownloadResume:61–71`, v1 stored type8–11 | 11 /403 for function | v1 writer is test-only: move fixtures, retain v1 decoder73–97 used by verified-model-download225–237 for recovery/migration. Current writer is v2 checkpoint. Never remove old-state reading just because writing stopped. |
| SAFE REMOVE | `src/lib/project-editor.ts` `setCaptionTexts:45–52`; exclusive module `src/lib/caption-text-edits.ts:1–18` | 8 /412 + whole18-line module | Test-only wrapper; applyCaptionTextChanges module has no other production caller. Tests in caption-emoji-timing, caption-tracks and editor-logic should target live script text edits. |
| SAFE REMOVE | `src/lib/project-editor.ts` `moveVisualLayer:317–330` | 14 /723 | Only timeline-track-repair tests. No production caller exists, but this helper changes compositing order, not timeline row order. Do not substitute track-order tests as semantic equivalents; preserve current compositing order and deliberately retain/retire the old test-only API assertions. |
| SAFE REMOVE | `src/lib/timeline-handle-layout.ts` `timelineHandleLayout:48–70` | 23 /641 | Only tests; current video handle layout calls marker/hit-layout primitives. Keep `timelineHandleMarkerLayout:72–77`, internally live. |
| SAFE REMOVE | `src/lib/video-source-recovery.ts` `canReuseVideoSource:25–31` | 7 /243 | Test-only predicate; live playable-source readiness/cancellation/release path remains. |
| SAFE REMOVE | `src/lib/video-timeline.ts` `videoTransitionOverlay:160–186` | 27 /1,114 | Only editor-logic/video-transition tests. Current preview compositor uses video-transition-preview. Retarget semantics to live preview. |
| SAFE REMOVE, conditional test migration | `src/lib/video-timeline.ts` `rippleDelete:366–375`, `rippleTimedContent:377–420`, private `rippleRange:460–480` | 75 /3,385 gross body spans | Full dependency boundary is closed in the timeline supplement. Only three test files call the legacy family; current UI uses project-editor.deleteVideoClip. Preserve/review the legacy 50 ms primary-caption assertion versus current 80 ms generic splice floor before test migration. No API equivalence or packaged saving claimed. |
| SAFE REMOVE | `src/lib/video-transition-preview.ts` `videoTransitionPreloadWindow:173–184` | 12 /342 | Only preview tests; remove exclusive preload-lead constant only after import cleanup. Retain live preload scheduler/window logic. |
| SAFE REMOVE | `src/lib/video-transition-preview.ts` `transitionPreviewKind:246–248` | 3 /112 | No callers; drop exclusive imported lookup name if no remaining use. Keep live transition metadata and old persisted-ID handling. |
| SAFE REMOVE | `src/services/database.ts` `listProjectsStrict:202–204`; `src/lib/persistence-boundaries.ts` `decodeEveryPersistedRow:16–21` | 3 /151 plus6-line helper | Wrapper has only source-regex tests; helper only wrapper + tests. Keep `readProjectRows:216–221` and `inspectProjectPermissionReferences:206–208`, with fail-closed URI protection for unreadable rows. Retarget storage-boundary tests to that actual flow. |
| SAFE REMOVE | `src/services/project-persistence.ts` `publishProjectAfterDurableSave:31–41`; `src/lib/persistence-boundaries.ts` `publishAfterDurableWrite:45–53` | 11 /338 plus9-line helper | Outer no production callers; inner only outer + tests. Current editor-session owns durable write/publish/revision ordering. Preserve live checkpoint/error API and test write-before-publish on actual session. |

**KEEP / not recommended standalone:** tiny unreferenced exports `src/lib/font-catalog.ts:173` (`BUNDLED_FONT_COUNT`) and `src/lib/timeline-gesture.ts:5–6` (`TIMELINE_GRIP_WIDTH`, `TIMELINE_CONTROL_HEIGHT`). These are cosmetic opportunities rather than meaningful compression findings. They are not a reason to delete font assets or consolidate differing handle dimensions.

### KEEP: responsibilities that must survive compression

1. **Persistence, recovery and permission ownership:** `project-schema.ts:42–47` JSON round-trip validation is the durable snapshot boundary, not redundant type checking. `project-codec.ts` hydrates/migrates older saved data. `project-file-uri-boundary.ts` handles nested encoded traversal and owned roots/content URIs. Database queue/deletion, journal crash recovery, media lifecycle, pending release ledger and `inspectProjectRowsForMediaPermissionRelease` deliberately retain permissions when unreadable persisted rows cannot be safely inspected. Do not replace all with permissive parsing or drop backward readers. Similar queue code in database cannot simply become `keyed-operation-queue`: deletion currently observes/waits for the stored queue tail.
2. **Durable-before-publish and cleanup after ownership changes:** `project-workflows.ts`, `project-media.ts`, `media-permissions.ts`, `editor-session.ts` distinguish committed files from staging and defer destructive release until persisted references are inspected. Similar try/finally blocks are not automatically redundant. Cache eviction policy differs from draft/user media recovery.
3. **Different lifecycle state machines:** caption-generation-session waits for registered stop operations/failures; video-export-session handles publication succeeding despite late cancellation; editor-session owns generation/revision and durable-write ordering. Merging these merely to reduce code would erase meaningful behavior. TimelineAudioPlaybackController serializes seeks, retains latest desired state and suppresses play after disposal; a shorter direct-play loop is not equivalent.
4. **Model integrity/download lifecycle:** verified-model-download validates size/SHA, range/206 responses, durable checkpoints and cancellation. Legacy resume decoding is live even if the encoder is test-only. Translation and transcription verification currently differ; retain leases, file identity, corrupt-file cleanup and shutdown synchronization. Model descriptors do not themselves imply bundled model weights; no APK reduction claim follows from deleting catalog text.
5. **Platform contracts and special consumers:** `src/shims/safe-buffer.ts` is resolved by `metro.config.js:7–15`, so ordinary import counts miss it. `shared/emoji-reactions.json` feeds `src/lib/emoji-reactions.ts` and Android asset configuration (`modules/caption-media/android/build.gradle:21–23`), with native catalog lookup; this is already shared ownership. Type declarations, `*.txt` module typing and legal notices connect to Metro/native assets. Keep license text and asset registration even if only indirect references exist.
6. **Export and media safety:** preserve source availability probing, native validation, font/style serialization, half-open timeline timing, conservative subtitle quantization/clamping, subtitle escaping, exact output artifact ownership and published-media success semantics. `subtitle-export.ts` intentionally distinguishes millisecond SRT and centisecond ASS output and handles independent translated cue timing. Do not compress to one rounding rule. `export-storage-policy.ts` differs from project-recovery-policy in patterns, legacy ownership and active artifact protection.
7. **Bounded runtime structures:** `timeline-layout.ts` uses indexed range queries/max-end data plus visible-item limits; replacing it with compact per-frame filtering can increase work. `audio-waveform.ts` caps retained/rendered peaks. `preview-scene-controller.ts` handles ownership/version/cancel transitions. Preserve caps and invalidation rules.
8. **Persisted IDs, compatibility and Unicode:** legacy transition mappings in `video-transitions.ts:101–114` are consumed by hydration and cannot be pruned based on current UI options. Project default shapes contain runtime constants, not just erased types. `translation-preservation.ts` tables/normalization protect raw literal inventories, Unicode emoji sequences and line topology; no compression proof justifies substituting a shorter approximate regex or differently versioned platform Unicode properties.
9. **False positives from external-reference counting:** internal-only exports/helpers such as `bucketWaveformPeaks`, `groupWordsIntoCaptions`, `DEFAULT_GROUPING_OPTIONS`, `constrainLayerGeometry`, `stackedTranslationLayout`, `removeResumableModelDownloadArtifacts`, `readLocalProcessExits`, `exportCacheDirectoryUri`, `saveImportedFont` and `validateProjectSource` have live local/indirect callers. No file was labeled removable solely because it has no direct app import.

### Method and validation boundaries

- Verified checkout HEAD and root AGENTS.md. The Expo documentation prerequisite applies before writing code; no source code was written.
- Inventoried every file in audited directories (145 files;18,794 lines;799,262 bytes). Counts are physical source lines and raw UTF-8 bytes, including comments/whitespace, not minified output.
- Automated export/identifier reverse reference scan covered application, services, tests, modules/native and scripts/config text. Candidate-specific whole-repository `rg` searches verified definitions, internal edges, test-only callers and explicit source-regex tests. Dynamic imports/require/config entry paths and Metro special resolution were inspected. The publicly hosted repository’s `package.json` has `private: true`: it is an application package rather than a published library with declared external package consumers. Future/out-of-repository users cannot be ruled out; review exports again before applying.
- Identifier scan is conservative but not a TypeScript compiler call graph: matching words may be type references, comments, tests or unrelated names. Zero counts were never sufficient alone. Indirect module/assets/state persisted on disk were treated separately.
- Direct source inspection is recorded per file below. All source files were directly read in full; larger-file responsibilities and compatibility qualifications are expanded in the supplements below. Tests were read and traced where relevant; runtime equivalence, native devices, release bundling and changed tests were not executed for these proposals. Baseline test results are recorded in the overall audit and do not establish equivalence of unapplied changes.
- Suggested application order: R1/R2 isolated removals and mixed-test preservation; R3 current workflow/hook test retargeting; R4/R5 UI/native coverage preservation; small helpers/fixture migration; UTF-8 extraction; runtime schema indexing with differential tests. Model-marker extraction and export-plan reuse need their own evidence and should not ride along as incidental cleanup.

### Complete file coverage

Depth codes:
- **D**: file directly read in full, responsibility and relevant dependencies considered; not a proof of every runtime branch or all platform implementations.

Every row also received the automated reference scan. “Lexical refs” gives distinct outside-module non-test files / test files matching exported identifiers; these are diagnostic counts, not import/call counts. Zero/absence does not establish deadness. D describes review depth, not severity. KEEP means no further reduction justified by this review; it is not an exhaustive no-op guarantee. Finding IDs override that broad disposition for the specifically named spans.

| File | Lines / bytes | Depth | Responsibility / disposition | Lexical refs non-test / tests |
|---|---:|:---:|---|---:|
| `shared/emoji-reactions.json` | 45 / 11,268 | D | KEEP: JS and Android shared emoji catalog/asset | 0 / 0 |
| `src/lib/adaptive-workspace.ts` | 30 / 1,098 | D | KEEP: editor viewport/workspace layout | 1 / 2 |
| `src/lib/animation-presets.ts` | 111 / 7,400 | D | KEEP: live animation metadata catalog | 4 / 4 |
| `src/lib/animation-timing.ts` | 272 / 9,228 | D | Small removals table; KEEP live animation clocks/state | 3 / 2 |
| `src/lib/audio-timeline.ts` | 336 / 14,668 | D | Small removal; KEEP audio trim/splice/fades | 10 / 5 |
| `src/lib/audio-waveform.ts` | 84 / 3,492 | D | KEEP: waveform bucketing and bounded display | 4 / 4 |
| `src/lib/caption-audio-route.ts` | 9 / 354 | D | KEEP: audible timeline/source transcription routing | 1 / 3 |
| `src/lib/caption-emoji-animation.ts` | 22 / 1,034 | D | KEEP: emoji reaction animation policy | 3 / 1 |
| `src/lib/caption-grouping.ts` | 145 / 5,714 | D | KEEP: per-language/per-clip word grouping | 1 / 8 |
| `src/lib/caption-languages.ts` | 202 / 11,873 | D | Small removals; KEEP catalog, canonicalization and language policy | 12 / 13 |
| `src/lib/caption-line-spacing.ts` | 6 / 239 | D | KEEP: preview/export line-spacing conversion | 2 / 1 |
| `src/lib/caption-preview.ts` | 17 / 840 | D | KEEP: active caption preview selection | 1 / 5 |
| `src/lib/caption-script.ts` | 362 / 15,970 | D | R5; KEEP current cursor editing/merge/reconciliation | 3 / 9 |
| `src/lib/caption-style.ts` | 107 / 3,979 | D | KEEP: editor style definitions and presets | 3 / 3 |
| `src/lib/caption-text-breaks.ts` | 311 / 10,999 | D | R4/R5; KEEP Unicode tokenization, spacing and safe offsets | 10 / 4 |
| `src/lib/caption-text-edits.ts` | 18 / 637 | D | Small removal cascade from test-only setCaptionTexts | 1 / 1 |
| `src/lib/caption-tracks.ts` | 798 / 32,411 | D | R6/small removals; KEEP generic translation tracks/pair timing | 17 / 29 |
| `src/lib/caption-transform.ts` | 19 / 860 | D | KEEP: caption screen-coordinate conversion | 3 / 2 |
| `src/lib/caption-translation-commit.ts` | 92 / 3,257 | D | R3; KEEP live translation acceptance/write selection | 3 / 10 |
| `src/lib/caption-translation-cut.ts` | 158 / 5,309 | D | R1: production-unreachable proportional cutter | 0 / 2 |
| `src/lib/contextual-translation-batching.ts` | 32 / 1,052 | D | KEEP: bounded translation context windows | 1 / 3 |
| `src/lib/diagnostic-redaction.ts` | 69 / 2,312 | D | KEEP: private-data removal from diagnostics | 1 / 2 |
| `src/lib/dual-caption-drafts.ts` | 113 / 4,756 | D | Small removal; KEEP draft fingerprints/reconciliation | 1 / 5 |
| `src/lib/dual-caption-save-merge.ts` | 30 / 1,691 | D | KEEP: stale-source-aware dual-language merge | 1 / 2 |
| `src/lib/editor-back-navigation.ts` | 54 / 1,899 | D | KEEP: back priority and pending-change handling | 1 / 1 |
| `src/lib/editor-runtime-policy.ts` | 18 / 556 | D | KEEP: active-operation/player gating | 1 / 2 |
| `src/lib/editor-selection.ts` | 49 / 1,849 | D | KEEP: selection normalization/context | 2 / 2 |
| `src/lib/emoji-reactions.ts` | 211 / 7,331 | D | KEEP: shared catalog lookup/validation | 2 / 3 |
| `src/lib/export-caption-pairs.ts` | 37 / 2,042 | D | KEEP: translation completeness/export visibility | 4 / 8 |
| `src/lib/export-progress-presentation.ts` | 18 / 813 | D | KEEP: export progress display | 1 / 2 |
| `src/lib/export-render-plan.ts` | 357 / 13,595 | D | R11/R12; KEEP native payload/style/timing contract | 8 / 24 |
| `src/lib/export-source-availability.ts` | 69 / 3,336 | D | KEEP: required media/image probing | 2 / 2 |
| `src/lib/font-catalog.ts` | 174 / 11,998 | D | KEEP: bundled font metadata/assets; tiny constant not recommended | 3 / 3 |
| `src/lib/font-library-controller.ts` | 144 / 5,710 | D | KEEP: font catalog load/import lifecycle | 1 / 1 |
| `src/lib/font-style-choice.ts` | 23 / 761 | D | KEEP: font choice style application | 6 / 3 |
| `src/lib/input-viewport.ts` | 83 / 3,245 | D | KEEP: input visibility/keyboard inset geometry | 1 / 5 |
| `src/lib/keyboard-viewport.ts` | 32 / 2,119 | D | Small removal; KEEP keyboard overlap/gap calculations | 1 / 3 |
| `src/lib/keyed-operation-queue.ts` | 10 / 473 | D | KEEP: per-key serialized async operations | 1 / 3 |
| `src/lib/layer-geometry.ts` | 191 / 9,746 | D | KEEP: constrained layer extents/transform math | 17 / 4 |
| `src/lib/media-lifecycle.ts` | 103 / 3,434 | D | KEEP: ownership/reference-aware cleanup | 3 / 4 |
| `src/lib/media-permission-release-ledger.ts` | 72 / 2,142 | D | KEEP: durable permission release intent validation | 1 / 1 |
| `src/lib/media-validation.ts` | 35 / 1,290 | D | KEEP: native probe validation before import/transcription | 5 / 5 |
| `src/lib/model-artifact-lifecycle.ts` | 38 / 966 | D | KEEP: model artifact names/ownership cleanup | 3 / 1 |
| `src/lib/model-download-resume.ts` | 125 / 4,517 | D | Small encoder relocation; KEEP v1 decoder/v2 checkpoint | 1 / 5 |
| `src/lib/model-verification-lease.ts` | 11 / 542 | D | KEEP: verified file-identity lease comparison | 1 / 1 |
| `src/lib/model-verification.ts` | 72 / 2,177 | D | KEEP: marker encoding/strict integrity identity checks | 3 / 5 |
| `src/lib/persistence-boundaries.ts` | 91 / 2,685 | D | Small dead wrapper cascades; KEEP retry/fail-closed inspection | 2 / 4 |
| `src/lib/picked-media-kind.ts` | 40 / 864 | D | R2: production-unreachable MIME/extension classifier | 0 / 1 |
| `src/lib/preview-object-hit-test.ts` | 120 / 5,701 | D | KEEP: transformed preview selection/hit geometry | 3 / 5 |
| `src/lib/preview-scene-controller.ts` | 228 / 10,725 | D | KEEP: preview scene ownership/async synchronization | 3 / 3 |
| `src/lib/preview-scene-project.ts` | 42 / 2,834 | D | KEEP: preview projection/selection integration | 1 / 3 |
| `src/lib/primary-caption-timing.ts` | 138 / 6,604 | D | KEEP: source timing canonicalization/half-open visibility | 5 / 4 |
| `src/lib/project-codec.ts` | 274 / 11,784 | D | KEEP: saved-project migration/hydration/backward compatibility | 1 / 6 |
| `src/lib/project-editor.ts` | 859 / 38,230 | D | Small removals; KEEP remaining mutation and ownership surface | 4 / 25 |
| `src/lib/project-factory.ts` | 95 / 2,739 | D | KEEP: v2 default project/video clip construction | 1 / 42 |
| `src/lib/project-file-uri-boundary.ts` | 63 / 2,490 | D | KEEP: owned file roots/encoded traversal guards | 4 / 1 |
| `src/lib/project-identifiers.ts` | 21 / 932 | D | KEEP: identifiers and filesystem-safe segments | 4 / 1 |
| `src/lib/project-library.ts` | 36 / 1,292 | D | KEEP: saved/draft library summaries | 1 / 2 |
| `src/lib/project-media-relink.ts` | 46 / 2,302 | D | KEEP: original-source relink verification | 1 / 1 |
| `src/lib/project-presentation.ts` | 33 / 1,586 | D | KEEP: duration/date/project display formatting | 1 / 3 |
| `src/lib/project-schema.ts` | 1,113 / 61,469 | D | R10; KEEP persisted validation; complete decoder responsibility review | 3 / 29 |
| `src/lib/project-source-frame.ts` | 34 / 1,775 | D | KEEP: rotated source dimensions/canvas aspect | 5 / 0 |
| `src/lib/project-timeline.ts` | 81 / 4,125 | D | KEEP: render duration/content end computation | 9 / 9 |
| `src/lib/source-transcription-fingerprint.ts` | 34 / 1,458 | D | KEEP: cache reuse identity/model binding | 2 / 5 |
| `src/lib/speech-alignment.ts` | 50 / 1,886 | D | KEEP: speech segment/word alignment | 1 / 3 |
| `src/lib/style-resolver.ts` | 99 / 3,566 | D | KEEP: project/caption/word style precedence | 7 / 9 |
| `src/lib/subtitle-export.ts` | 321 / 13,162 | D | KEEP: SRT/ASS escaping, timing quantization, independent cues | 1 / 14 |
| `src/lib/timeline-audio-render-plan.ts` | 70 / 2,539 | D | KEEP: audible render inputs and silence accounting | 1 / 4 |
| `src/lib/timeline-boundary-feedback.ts` | 65 / 2,294 | D | KEEP: bounded trim/move feedback and snapping | 1 / 4 |
| `src/lib/timeline-edit-bounds.ts` | 26 / 1,182 | D | KEEP: editing range constraints | 3 / 0 |
| `src/lib/timeline-gesture.ts` | 173 / 7,242 | D | KEEP: gesture interaction state/thresholds; tiny constants not recommended | 1 / 5 |
| `src/lib/timeline-handle-layout.ts` | 115 / 4,192 | D | Small removal; KEEP current hit/marker/video handles | 1 / 5 |
| `src/lib/timeline-item-editor.ts` | 43 / 1,475 | D | KEEP: timeline item edit dispatch | 2 / 1 |
| `src/lib/timeline-item-timing.ts` | 87 / 3,648 | D | KEEP: visual/audio/caption timing projection | 7 / 1 |
| `src/lib/timeline-layout.ts` | 132 / 6,057 | D | KEEP: bounded indexed visible-item queries | 2 / 6 |
| `src/lib/timeline-scale.ts` | 91 / 3,330 | D | KEEP: zoom/ruler/pixel-to-time conversion | 1 / 2 |
| `src/lib/timeline-touch-intent.ts` | 24 / 1,360 | D | KEEP: tap/drag intent thresholds | 3 / 4 |
| `src/lib/timeline-tracks.ts` | 57 / 2,543 | D | KEEP: stable track order/identifiers | 3 / 2 |
| `src/lib/timeline-transcription.ts` | 34 / 1,410 | D | KEEP: audible composition transcription projection | 1 / 2 |
| `src/lib/transcription-hydration.ts` | 46 / 1,865 | D | KEEP: persisted transcription timing repair | 1 / 1 |
| `src/lib/transcription-language.ts` | 12 / 573 | D | KEEP: supported speech language conversion | 1 / 1 |
| `src/lib/transcription-progress.ts` | 4 / 220 | D | KEEP: progress constants/presentation | 1 / 2 |
| `src/lib/transcription-recovery.ts` | 58 / 1,942 | D | KEEP: transcription recovery identity/history handling | 1 / 1 |
| `src/lib/transition-presets.ts` | 4 / 96 | D | KEEP: compatibility re-export of active presets | 0 / 0 |
| `src/lib/translation-attempt.ts` | 60 / 3,660 | D | KEEP: accepted/failed translation commit semantics | 2 / 7 |
| `src/lib/translation-batching.ts` | 60 / 2,168 | D | KEEP: bounded batch sizing | 1 / 5 |
| `src/lib/translation-device-capability.ts` | 3 / 110 | D | KEEP: native translation capability conversion | 1 / 2 |
| `src/lib/translation-input.ts` | 22 / 1,127 | D | KEEP: translation input canonicalization/limits | 1 / 4 |
| `src/lib/translation-invariants.ts` | 103 / 4,515 | D | KEEP: translation output integrity/invariant gates | 8 / 9 |
| `src/lib/translation-model-availability.ts` | 5 / 186 | D | KEEP: model readiness policy | 1 / 1 |
| `src/lib/translation-model-consent.ts` | 6 / 644 | D | KEEP: explicit download consent decisions | 1 / 3 |
| `src/lib/translation-preservation.ts` | 280 / 21,047 | D | KEEP: Unicode17/literal/topology invariants | 6 / 4 |
| `src/lib/translation-preview-timeline.ts` | 62 / 3,020 | D | KEEP: translated cue timing projection | 1 / 1 |
| `src/lib/ui-theme.ts` | 29 / 603 | D | KEEP: shared editor theme tokens | 27 / 18 |
| `src/lib/video-playback-policy.ts` | 74 / 2,307 | D | KEEP: video readiness/seek policy | 1 / 1 |
| `src/lib/video-playback-source.ts` | 5 / 195 | D | KEEP: stable playback source shape | 2 / 0 |
| `src/lib/video-source-metadata.ts` | 27 / 1,112 | D | KEEP: frame-rate normalization/validation | 5 / 1 |
| `src/lib/video-source-recovery.ts` | 79 / 3,424 | D | Small removal; KEEP live source replacement/release lifecycle | 1 / 2 |
| `src/lib/video-timeline.ts` | 508 / 22,125 | D | Small removals/needs evidence; complete timing/splice review | 25 / 18 |
| `src/lib/video-transform.ts` | 85 / 3,274 | D | KEEP: transform cloning/defaults/interpolation | 5 / 0 |
| `src/lib/video-transition-preview.ts` | 285 / 11,451 | D | Small removals; KEEP live preview/preload composition | 2 / 1 |
| `src/lib/video-transitions.ts` | 193 / 8,061 | D | KEEP: transition catalog/current and retired-ID hydration | 9 / 2 |
| `src/lib/visual-layer-visibility.ts` | 17 / 340 | D | KEEP: half-open visible-layer timing | 1 / 1 |
| `src/lib/wav-chunking.ts` | 107 / 4,089 | D | KEEP: bounded PCM/WAV parsing/chunking | 1 / 3 |
| `src/lib/whisper-words.ts` | 75 / 2,741 | D | KEEP: Whisper word/timestamp normalization | 1 / 3 |
| `src/services/caption-generation-session.ts` | 128 / 4,587 | D | KEEP: cancellable generation/registered-stop ownership | 6 / 10 |
| `src/services/caption-translation.ts` | 937 / 39,062 | D | R8; complete model/download/batch lifecycle review | 8 / 11 |
| `src/services/database.ts` | 371 / 13,664 | D | Small wrapper removal; KEEP durable queue/decode/media boundaries | 7 / 13 |
| `src/services/editor-draft-journal.ts` | 243 / 12,272 | D | R7; KEEP atomic journal/recovery/quarantine | 3 / 8 |
| `src/services/editor-session.ts` | 113 / 4,125 | D | KEEP: durable writes/revisions/session generations | 1 / 8 |
| `src/services/export-font-assets.ts` | 19 / 809 | D | KEEP: bundled font asset URI resolution | 2 / 1 |
| `src/services/export-storage-policy.ts` | 150 / 5,824 | D | KEEP: owned artifact patterns/budgets/expiry | 2 / 3 |
| `src/services/export-storage.ts` | 131 / 4,683 | D | KEEP: protected active artifacts/publication validation | 1 / 2 |
| `src/services/font-storage.ts` | 141 / 5,215 | D | R9 KEEP: staged font validation/import/favorites | 3 / 4 |
| `src/services/legal-notices.ts` | 108 / 6,193 | D | KEEP: shipped license/model/native notices | 1 / 0 |
| `src/services/local-diagnostics.ts` | 84 / 3,486 | D | KEEP: bounded local redacted diagnostic/process-exit data | 2 / 2 |
| `src/services/media-import.ts` | 257 / 9,051 | D | KEEP: typed pickers/probe/permission transaction | 4 / 3 |
| `src/services/media-permissions.ts` | 104 / 3,947 | D | KEEP: persisted content grants and deferred release ledger | 3 / 6 |
| `src/services/preferences.ts` | 30 / 849 | D | KEEP: typed persisted preference access | 2 / 0 |
| `src/services/project-caption-translation.ts` | 215 / 8,992 | D | R3; KEEP manual edits/generic track setup | 3 / 4 |
| `src/services/project-export.ts` | 127 / 6,453 | D | R12; KEEP validation/storage/publication/cancellation | 1 / 4 |
| `src/services/project-media-access.ts` | 27 / 1,343 | D | KEEP: access status/source validation bridge | 2 / 4 |
| `src/services/project-media-recovery.ts` | 58 / 2,965 | D | KEEP: original-media consent/relink workflow | 1 / 2 |
| `src/services/project-media.ts` | 383 / 17,610 | D | R9 KEEP: owned media/staging/thumbnail lifecycle | 5 / 9 |
| `src/services/project-persistence.ts` | 41 / 1,269 | D | Small wrapper removal; KEEP checkpoint/error API | 2 / 6 |
| `src/services/project-recovery-policy.ts` | 47 / 1,975 | D | KEEP: owned recovery artifacts/expiry policy | 1 / 1 |
| `src/services/project-recovery.ts` | 81 / 3,214 | D | KEEP: startup reconciliation/protected artifact cleanup | 2 / 1 |
| `src/services/project-transcription.ts` | 181 / 7,145 | D | KEEP: source fingerprint caching/audible timeline restoration | 1 / 2 |
| `src/services/project-workflows.ts` | 398 / 15,961 | D | KEEP: project create/save/discard/import transaction orchestration | 2 / 13 |
| `src/services/storage-policy.ts` | 15 / 753 | D | KEEP: storage reservations/free-space errors | 7 / 7 |
| `src/services/timeline-audio-playback.ts` | 275 / 9,315 | D | KEEP: serialized player seeks/latest target/disposal | 2 / 2 |
| `src/services/timeline-audio-render.ts` | 101 / 3,995 | D | KEEP: native audio-render temporary session/restoration | 1 / 4 |
| `src/services/timeline-audio-runtime.ts` | 23 / 671 | D | KEEP: Expo audio session ownership/setup | 1 / 0 |
| `src/services/timeline-haptics.ts` | 21 / 857 | D | KEEP: bounded platform haptic feedback | 1 / 4 |
| `src/services/timeline-transcription-cache.ts` | 92 / 3,697 | D | R7; KEEP optional bounded transcription cache | 2 / 5 |
| `src/services/transcription.ts` | 572 / 21,612 | D | R8; complete verified-model/download/transcription lifecycle review | 4 / 11 |
| `src/services/verified-model-download.ts` | 362 / 12,207 | D | KEEP: ranged resumable download integrity/cancellation | 2 / 5 |
| `src/services/video-export-session.ts` | 113 / 3,891 | D | KEEP: native export publication/cancel state machine | 2 / 4 |
| `src/services/video-player-runtime.ts` | 13 / 429 | D | KEEP: platform player pause/remove wrapper | 1 / 5 |
| `src/shims/safe-buffer.ts` | 47 / 1,788 | D | KEEP: Metro-resolved Buffer compatibility shim | 13 / 8 |
| `src/types/globals.d.ts` | 1 / 41 | D | KEEP: global ambient typing | 0 / 0 |
| `src/types/project-library.ts` | 17 / 467 | D | KEEP: lightweight library/unreadable record unions | 4 / 0 |
| `src/types/project-media-recovery.ts` | 14 / 500 | D | KEEP: original-document access/confirmation contracts | 5 / 0 |
| `src/types/project.ts` | 492 / 10,907 | D | KEEP: persisted/native-facing model plus runtime defaults; complete review | 86 / 12 |
| `src/types/text-assets.d.ts` | 4 / 80 | D | KEEP: Metro text asset numeric module typing | 0 / 0 |

Depth totals: **145 D**. No inventory-only or selected-section-only source rows remain. The artifact is a review report, not an implementation plan approved for edits.


## Caption logic: complete direct semantic coverage addendum

### Result

At checkout `3ae54ddb3cf3253037a1c53aaf86177d09c7770a`, all seven audited files were directly read **in full**: **2,321 physical lines / 104,523 UTF-8 bytes**. Each major responsibility and its local helpers was considered, and removal candidates were rechecked against whole-repository identifier references and relevant live callers/tests.

R4, R5, R6 and the existing small audio/language/track removal candidates remain supported by current-repository production reachability. R6 needs explicit fixture-shape cautions below. No additional substantive source-removal group was established. One bounded runtime-allocation candidate is identified separately; it does not add to source-deletion totals. `primaryCaptionSurvives` is a conditional cascade of the separate ripple review, not an independently justified deletion.

No repository source was edited. No dependencies were installed and no tests or builds were run. The checkout was clean when checked. Full direct review is not execution-based equivalence proof, an external-consumer guarantee, or proof that no further reduction exists.

### Full-file coverage evidence

#### `src/lib/audio-timeline.ts` — 336 lines / 14,668 bytes — D

- **1–36:** type/import boundary, editing minimum, playback-rate-aware duration/end, non-mutating audible projection, muted/trim-hidden/zero-volume exclusion, finite/positive export intervals, clipping in source-time units, fade-volume envelope. KEEP: export projection is intentionally different from editing constraints.
- **38–104:** source insertion, valid video-audio attachment/owner lookup, edit extent, source offset/rate, minimum insertion duration, persisted requested-source anchors, gain/mute/fade updates and timestamp publication. KEEP these checks and ownership metadata.
- **106–221:** movement, owner-range detach, trim/source availability, finite requested bounds, playback-rate conversion, fade clamp, split-ID collision checks, split fade resets, deletion and detached duplication. These have live editor/timeline-item-editor callers; no further removal is justified.
- **223–289:** timeline splice of unattached clips, video-edit remapping, source requests retained while trim-hidden, owner disappearance/detach, source-window intersection, attached split and collision-resistant right-side IDs. KEEP: requested bounds, visible bounds and timeline position are distinct state, not duplicate fields.
- **291–336:** detach helpers; test-only `constrainAudioClips`; shared fade clamp; video-vs-audio edit extent; timestamp update and clamp. Only 304–315 remains the existing removal candidate. The other helpers have live local callers.
- **Caller/test evidence:** `src/app/editor.tsx:63`; `src/lib/timeline-item-editor.ts:1`; `src/lib/project-editor.ts:7`; `src/lib/video-timeline.ts:2`; `src/lib/export-render-plan.ts:2`; `src/lib/timeline-audio-render-plan.ts:2`. Whole-repository `constrainAudioClips` references are its definition plus `tests/export-audio-boundary-regression.test.mjs:4,64`.
- **Equivalence gate for existing removal:** retain the test's meaningful *positive audible tail below editing minimum* case using live `audibleAudioClipsWithin`/render-plan construction. Do not substitute the dead helper's behavior for the live projection: the latter additionally filters muted/hidden/zero-volume clips and clips negative starts.

#### `src/lib/caption-languages.ts` — 202 lines / 11,873 bytes — D

- **1–59:** preservation/invariant imports; language/tag/grouping types; 19-entry ordered language catalog and map. KEEP catalog order, display names, family/grouping distinctions and automatic eligibility metadata.
- **61–119:** family/label/grouping resolution, canonicalization and unknown/empty behavior; eligibility and target-choice APIs. Existing test-only candidates are exactly `supportsAutomaticCaptionTranslation:91–93` and `automaticTranslationTargetTags:102–108`; live `canAutomaticallyTranslatePair:95–100` and `dualCaptionLanguageChoices:110–119` remain.
- **121–146:** normalized lookup, regional/family fallback, English/Chinese script and Cantonese aliases. KEEP: `normalizeEnglishChineseCaptionLanguage` is used both by general resolution and untranslated-output policy, independently of R6's legacy factory.
- **148–194:** traditional/simplified marker inventories, punctuation/case echo key, literal/invariant preservation gates, identical-text rejection, long-source acknowledgement rejection, target-script checks, English/Han exclusion and unknown-target fallback. KEEP: sequence/order and script distinctions encode acceptance policy; do not replace with one broad equality/regex check or prune language data based on UI references.
- **195–202:** fallback grouping for uncatalogued language families including Lao/Khmer/Myanmar and Persian/Urdu/Pashto. This supports formatting beyond automatic-translation eligibility; ineligibility is not grounds to remove grouping fallbacks.
- **Caller/test evidence:** language picker imports live choices; translation hook/services use pair eligibility, family and resolution; grouping uses grouping profile; translation commit uses untranslated detection. Candidate calls are only in `tests/caption-translation-cut.test.mjs:6,25–27` and `tests/urdu-removal.test.mjs:5,11,20,28–29,40`.
- **Equivalence gate:** migrate catalog exclusion, same-family exclusion, unknown-source eligibility and alias assertions to live APIs. Do not delete multilingual contract coverage with the obsolete cutter file.

#### `src/lib/caption-script.ts` — 362 lines / 15,970 bytes — D

- **1–31:** imported Unicode primitives and persisted decoder; draft array bound, duplicate-ID guard, decoder failure-to-null boundary. KEEP: recovery deliberately accepts persisted zero-length/temporarily empty cues; editing validation is separate.
- **33–86:** structural equality ignores undefined object properties, normalizes visibility/empty appearance and optionally excludes appearance; draft identity; versioned two-accumulator content fingerprint; current/legacy geometry-aware draft reconciliation. KEEP: JSON stringify equality or a timestamp would not preserve these semantics.
- **88–144:** script mutation types, current text-only update, and obsolete newline-splitting input wrapper. R5 removal at103–144 confirmed.
- **146–210:** live cursor split: finite/collision checks, nearest safe Unicode offset, horizontal-whitespace-only trimming, positive text/160ms minimum, token-based timing hints with proportional fallback, 80ms child minimum, partitioned word IDs and source-anchor conversion. KEEP all of this; manual text edits need not align to spoken token boundaries.
- **212–254:** unused split-at-time adapter; R5 removal confirmed.
- **256–295:** chronological previous/next merge, same-owner source-anchor union or timeline fallback, layout-aware text joining then whitespace normalization, ID/appearance ownership and explicit visible state. KEEP; it is not equivalent to the generated-cue merger in primary timing.
- **297–346:** exclusive time-split helpers; R5 removal cascade confirmed. **348–362:** live word-partition proportional fallback, merge text normalization and clamp remain.
- **Caller/test evidence:** `src/components/editor/script-editor.tsx:432–478` directly confirms text update at438, merge at444/451 and cursor split at466. Whole-repository obsolete-root references are only their definitions and tests. `tests/caption-script-line-breaks.test.mjs:223` rejects the old input wrapper in the current handler.
- **Equivalence gate:** retire obsolete wrapper/time-split assertions while preserving current newline-as-content, explicit split/merge, recovery revision, geometry reconciliation, emoji-safe offsets and source ownership tests. Keep `captionSpokenTokenSpans`, `captionTextPrefixLength` and `safeCaptionTextOffset` imports: all still serve live cursor splitting.

#### `src/lib/caption-text-breaks.ts` — 311 lines / 10,999 bytes — D

- **1–57:** token/span types, Unicode and punctuation patterns, raw UTF-16 offsets versus NFC-normalized token API, spoken punctuation attachment. KEEP: these APIs intentionally return different representations.
- **59–127:** standalone timed-word alignment, packed-word expansion and fallback spreading branch. R4 production-unreachable branch confirmed, along with its timed type at7–12.
- **129–186:** script-aware spacing/layout, NFC grapheme length, head/tail preserving original text, safe text offsets and cursor-between-spoken-tokens hint. All remain needed by grouping, script editing, subtitle output or translation services.
- **188–206:** spoken-boundary offset/nearest-boundary exports have only the R5 private adapter as their non-test caller; removal remains conditional on R5, not R4.
- **208–220:** live CJK count/containment versus test-only compact-token predicate; only218–220 is the existing independent R4 cleanup.
- **222–280:** private timing types/key/units/expanded-word weighting used exclusively by the removed R4 branch. KEEP nothing here solely as a runtime test oracle; move a needed oracle into test support deliberately.
- **282–311:** live combining-mark/variation-selector/skin-tone/ZWJ-aware spans and first/last code-point layout helpers. KEEP this existing behavior. A different segmentation implementation would need a separate contract comparison; this review does not claim it is a complete Unicode grapheme algorithm.
- **Caller/test evidence:** whole-repository timing-symbol search finds no live application/service/native-bridge call. `tests/caption-text-breaks.test.mjs` mixes live Unicode tests with timing-oracle tests. The shared timing fixture is independently consumed by `modules/caption-media/android/src/test/java/app/captionstudio/media/TimelineTextPainterAnimationTest.kt:58`.
- **Equivalence gate:** preserve that shared native fixture and native timing coverage. Remove only the JS timing tests/oracle being deliberately retired; retain live layout/offset/CJK/emoji assertions. No JS/native timing equivalence claim follows from removal.

#### `src/lib/caption-tracks.ts` — 798 lines / 32,411 bytes — D

- **1–90:** style/geometry/ID/language dependencies, stable track IDs, translation defaults and gap limits, pair provenance/options/update contracts, empty collection. KEEP defaults/constants used by live generic construction/resolution.
- **92–175:** old bilingual fixture factory versus generic factory's identity/language/name/duplicate/source-cue/provider checks, layout anchor, default provenance, gap and cue creation. R6 remains test-fixture migration; generic factory is live at `src/services/project-caption-translation.ts:56–65`.
- **177–254:** obsolete single-edit wrapper; live batch updater validates IDs, pair-key uniqueness, primary-update conflicts and text bounds; synchronizes source changes; writes accepted translations/snapshots/status; clears failure. JSON tuple key at250–254 protects colons in IDs. KEEP batch algorithm/key rather than concatenating identifiers.
- **256–384:** track/cue style editing with geometry normalization and track transform routing, matching-override removal, independent cue range editing, skip validation, visibility validation and provider/source-language provenance mutation. KEEP distinct errors, empty-operation behavior and timestamps. Invariant inherited-font resolution within the track-style cue loop has the optional runtime candidate below.
- **387–463:** primary-language resolution uses timeline transcription or complete per-source results, rejects incomplete/mixed source families; legacy bilingual wrapper; tolerant display resolution; export compatibility validation; post-transcription reset/synchronization; stable generic track IDs/display names. KEEP fail-closed feature/export decisions separate from tolerant label resolution.
- **465–528:** pairs combine source/track/cue styles, optionally stack geometry, preserve independent timing, derive skip/visibility and failed-source display fallback/provenance; explicit legacy-transform migration and deterministic reference selection. KEEP: display fallback never becomes persisted translation text; read-only pair resolution never performs migration.
- **530–594:** synchronization preserves failed states/snapshots and user cue timing, handles source edits/language staleness; operation-specific timing remap validates inputs/results and clips with visibility propagation. KEEP these independent responsibilities.
- **596–700:** removal; synchronized current-track lookup; update/error wrapper; timestamp wrapper; identifier-safe cue creation; pending/stale/reviewed/failed transition rules; bounded failure reason/text/ID/language validation. Helpers have live local or external consumers.
- **702–720:** exclusive R6 target/default-style fixture helpers. **722–798:** live gap setter, unused position wrapper735–741, live layout743–761, clamps/name/own-property translation-value validators, language family wrapper, provider provenance checks. Only the already-listed position wrapper is independently removable.
- **Caller/test evidence:** whole-repository searches confirm no production call for the old factory, bilingual wrapper or single-update wrapper; no call at all for `stackedTranslationPosition`. `resolveCaptionPairs:477` calls `stackedTranslationLayout`, so it is not dead. Batch updates remain live in `src/services/project-caption-translation.ts:143` and `src/lib/translation-attempt.ts:24`.

#### `src/lib/font-catalog.ts` — 174 lines / 11,998 bytes — D

- **1–7:** FontChoice typing/re-export and Metro numeric asset type. **8–77:** every bundled family-to-static-require mapping directly read. **79–94:** existing constructor already factors common built-in choice shape. **96–171:** every choice's ID/family/name/mood/treatment/color data directly read; system font remains a distinct unbundled choice. **173–174:** bundled count versus live two-color count.
- KEEP catalog/asset linkage: `src/app/_layout.tsx:19` passes `FONT_ASSETS` to `useFonts`; `src/services/export-font-assets.ts:8–16` validates family membership and obtains local export URI; font browser consumes choices and two-color count. Static require paths are Metro asset registration, not dead strings or automatically safe candidates for dynamic path construction.
- Existing disposition confirmed: `BUNDLED_FONT_COUNT:173` has no caller, but this one-line cleanup is too small to recommend independently. `TWO_COLOR_FONT_COUNT:174` is live at `src/components/editor/font-browser.tsx:71,97`. Removing available fonts would change the user-visible feature/catalog and saved-family/export behavior; no asset deletion is justified here.

#### `src/lib/primary-caption-timing.ts` — 138 lines / 6,604 bytes — D

- **1–29:** source-duration/word-quality/ID validation and acoustic end truncation at next onset/duration. KEEP; this canonicalizer intentionally repairs overlap but does not apply minimum visual timing.
- **31–42:** canonical-source predicate used by source-cache eligibility and project generation. It requires already non-overlapping intervals and returns false rather than repairing/throwing; do not collapse it into the canonicalizer.
- **44–67:** projected-word start sequencing, sentence-end 80ms versus ordinary 1ms separation for colliding onsets, owning clip/end constraints and finite-positive validation. KEEP distinct projection policy.
- **69–117:** generated-cue range/budget/overlap checks followed by short-cue next-first/previous-second merging or bounded before/after visual padding. KEEP iteration restart behavior and clip speech-window bounds.
- **119–127:** generated adjacent merger retains left metadata and raw word IDs while joining with layout spacing; it differs materially from manual script merge.
- **129–138:** explicit-hidden/positive-interval visibility and positive-interval survival. `primaryCaptionVisible` remains live in video timeline projection/remapping at311,357. `primaryCaptionSurvives:136–138` has just one non-test call, `video-timeline.ts:387`, inside `rippleTimedContent`; it is a **conditional cascade** if the separate ripple removal is established. It is not independently a new meaningful candidate.
- **Caller evidence:** canonicalize at `src/services/project-transcription.ts:86`; predicate at `src/lib/project-editor.ts:692` and `src/lib/source-transcription-fingerprint.ts:33`; projected-word normalization and sequencing at `src/lib/caption-grouping.ts:119,59`.

### Amendments to existing findings

1. **R4/R5 confirmed.** Keep their branches disjoint, preserve native timing fixture/tests and all current cursor/editing primitives. Type-only removals do not themselves reduce runtime bytes.
2. **R6 confirmed as fixture relocation, not a drop-in generic-factory substitution.** The old factory selects a target automatically, normalizes English/Chinese aliases, emits old family-specific errors, chooses stable IDs/names, and writes an explicit merged/cloned default `styleOverride` at116/712–720. Generic creation can preserve effective appearance without preserving that persisted fixture shape, so compare both serialized and resolved fixtures. Old `options.stackGap` is accepted by its type but not forwarded at108–119; silently forwarding it in a replacement changes fixture semantics. Preserve existing fixture behavior or make a deliberate, separately reviewed test update. Keep production default translation style, language normalization and track IDs.
3. **Single-update wrapper migration caveat.** `updatePairedCaptionText:177–180` returns the original project immediately when both text fields are absent; generic batch processing validates identities first and may synchronize even a no-text entry. Existing tests should move their actual text edits to the batch API; a mechanical rewrite of arbitrary no-op wrapper calls is not equivalent.
4. **Audio candidate confirmed.** Transfer the sub-editing-minimum audible tail regression to the live export projection. Do not let removal erase an export-boundary requirement.
5. **Primary timing KEEP requires one qualification.** `primaryCaptionSurvives` is attached to the separately investigated legacy ripple branch. Other primary timing responsibilities remain live and justified.

### Optional new bounded runtime candidate: resolve inherited translation font once per track update

- **Location:** `src/lib/caption-tracks.ts:268–275`, specifically the two nested `mergeStyle` calls at274 inside `track.cues.map`.
- **Evidence:** every cue receives the same inherited font resolved from the same `project.projectStyle`, `DEFAULT_TRANSLATION_TRACK_STYLE` and pre-patch `track.styleOverride`. `mergeStyle` (`src/lib/caption-style.ts:3–20`) copies style/font/nested values; `removePatchedKeys:22–48` reads the inherited font and does not mutate it. The action is live from `src/app/editor.tsx:977,1010,1030,1328` and cue-transform editing at `caption-tracks.ts:289`.
- **Smallest possible change:** resolve that **pre-patch** inherited font once within the chosen track callback and reuse it for its cue override cleanup. Preserve zero-cue behavior by avoiding eager resolution when no cue will be processed, if exact evaluation behavior is required. Do not use the newly patched font: cleanup detects identity replacement relative to previous inherited font.
- **Analytical benefit:** for C cues, reduce up to `2C` mergeStyle invocations to two (the second can already be an early return when no track override exists), reducing repeated nested-object/font allocations. Complexity of the cue update remains O(C). It may increase source lines; source, bundle and device-time savings are unmeasured.
- **Confidence/gates:** high for immutable decoded/plain project records, not a tested patch. Deep-compare outputs for no cues, missing cue overrides, nested/partial font patches, imported-font URI/PostScript identity, project/track font differences, geometry normalization, multiple tracks and unchanged timestamp semantics. Preserve current evaluation/error ordering where relevant. Existing `tests/caption-track-transform.test.mjs:134+` and `tests/caption-tracks.test.mjs:72+` cover related font/default-style boundaries and should be extended/differentially checked. Treat as lower priority than established dead-branch removal until profiling warrants it.


## Full-file coverage addendum: project editing, schema and types

### Result

At checkout `3ae54ddb3cf3253037a1c53aaf86177d09c7770a`, all **2,464 lines** of the three audited files were directly read in full, including imports, every declaration and helper, defaults, validation and return paths. This establishes full direct source coverage; it is not a proof of all runtime behavior or a claim that every possible reduction was exhausted.

The existing small removal candidates in `project-editor.ts` remain supported. R10 remains a useful runtime candidate for persisted JSON, but is **NEEDS EVIDENCE for unrestricted exported/non-JSON inputs**, with the implementation/contract qualifications below. No additional substantive removal or consolidation is recommended from this pass. The rest of the three files should remain as reviewed, especially persistence validation, ownership/remapping semantics and runtime defaults.

Review was read-only for the repository. No installs, builds, tests or source edits were performed. This addendum is written outside the repository; no runtime or bundle savings were measured.

### Complete direct coverage and responsibilities

#### `src/lib/project-editor.ts` — 859 lines / 38,230 bytes — D

- **1–88:** dependency boundary, old batch caption-text wrapper, current text/style/image geometry and video-transform mutations; identity-preserving video transform no-op.
- **90–211:** caption timing constraints, neighboring-cue overlap protection, source/timeline ownership conversion, decoded/reconciled script replacement, grandfathered legacy short timings, hidden-cue identity preservation and semantic no-op history/I/O guard.
- **213–315:** non-caption timing edits, image patches, initial text/image ranges, watermark restrictions and insertion/compositing order.
- **317–408:** old visual-order wrapper, delete/duplicate/split layer behavior, caption deletion, clip volume/fades and transition validity/minimum-duration rules.
- **411–533:** preview/reorder and moved caption timing, translation reorder mapping, video deletion ripple/canvas extent, split source anchors, attached audio and independent transform clones.
- **535–648:** trim/handle recovery, per-edge and combined leading gaps, preview/commit separation, splice construction, finite/no-op guards and resulting seek targets.
- **650–762:** canvas presets, update timestamps and conditional caption-track synchronization, canonical source-word versus timeline-word rebuild, translation/audio splice policy, and timed-range removal/insertion clipping.
- **764–859:** sticky canvas ownership, complete interval coverage before source anchoring, split anchors, surviving-owner remap, hidden layer tombstones and visibility restoration.

Relevant references checked: all production imports of this module in `src/app/editor.tsx:93–116`, `src/components/editor/layer-timeline.tsx:12`, `src/lib/timeline-item-editor.ts:3` and `src/lib/preview-scene-project.ts:3`; current script text mutation at `src/components/editor/script-editor.tsx:432–440` and commit at `src/app/editor.tsx:1063`; current row ordering in `src/lib/timeline-tracks.ts:21–57`. Timeline range helpers and source-timing/ownership references were read where needed.

**Disposition:** keep the live mutation surface. Similar-looking caption, visual-layer, translation and audio edits carry distinct ownership, synchronization, identity and ripple policies. A generic “mutate all timed objects” wrapper is not justified. The repeated initial text/image range calculation at **243–250 / 294–301** is only a modest local extraction opportunity; a separate change is not recommended without a broader maintenance reason. Watermark lifetime at **273–284** is deliberately different and must not be folded into it.

#### `src/lib/project-schema.ts` — 1,113 lines / 61,469 bytes — D

- **1–167:** snapshot-before-write validation, schema version, source/clip ID/reference validation, recoverable clip handles, legacy transform/transition hydration, audio cross-reference/bounds ordering, captions/layers/tracks, source canvas and final project assembly.
- **169–300:** video source/clip metadata, local URI/storage-mode constraints, audio source/waveform format/version and audio clip ownership/recoverable fields.
- **302–399:** timeline/per-source transcription, null-prototype result dictionary, duplicate word IDs, SHA-256 fingerprint syntax, caption defaults and source anchors.
- **401–551:** translation collection/relationship/language/provider provenance, status/text/review consistency, failure metadata, independent/legacy cue timing, duplicate cue/source-link/language validation and final synchronization.
- **553–633:** captions-layer restoration/reserved identity, text/image layer geometry/timing, watermark metadata and source anchors.
- **635–818:** full style defaults versus sparse style patches, nested font and imported URI policy, legacy font source normalization, stroke/shadow/background/animation validation and clone semantics.
- **819–920:** source-oriented canvas, video transform defaults and independent scale fields, inert legacy background metadata with retained source, export settings and lifecycle.
- **922–1113:** full/patch point and box decoding, nested style cloning, uniqueness, bounded arrays/strings, identifiers, local media/path checks, finite numeric/enumerated/color/date primitives and optional-value semantics.

Production whole-project decoder callers are `project-schema.ts:45` (JSON-parsed save snapshot) and `project-codec.ts:27,30` (JSON-parsed saved/migrated data). `decodeCaption` is also independently live through caption draft decoding. Supporting boundary tests were inspected, including `audit-core-repairs.test.mjs:29–59`, `storage-boundaries.test.mjs:85–125`, and the background-retirement contract.

**Disposition:** R10 only; retain remaining validation. Full style decoders and patch decoders are not interchangeable: defaults/cloning versus omitted fields, fallback font behavior, normalization and diagnostic order differ. Snapshot serialization intentionally returns the original serialized snapshot after validating a parsed copy (**42–46**); replacing it with serialization of normalized decoded data would alter persistence semantics.

#### `src/types/project.ts` — 492 lines / 10,907 bytes — D

- **1–80:** type-only imports/re-exports, identifier/animation/text treatment/font types and geometry alias.
- **82–168:** full style and nested sparse patches, timed words/captions and source/timeline ownership.
- **170–263:** translation status/cues/provenance/layout, collection, captions/text/image layers and anchors.
- **265–341:** video source metadata, full versus patch transforms, recoverable clip range/transition fields, and legacy background/person transform types.
- **343–428:** audio source/waveform and attached/timeline audio fields, source transcription identity, full persisted project with optional legacy modes and export/canvas state.
- **430–492:** live runtime video and caption defaults, including nested mutable objects, independent scales, font/style values and animation parameters.

**Disposition:** keep. Type declarations normally contribute no runtime bytes; the two default objects are real runtime exports used by factory, schema and editor/style flows. Removing or collapsing optional persisted fields would be a contract change. `NormalizedTransform` already aliases `LayerGeometryInput`; duplicate explicit geometry members are type-level tidiness, not a substantive runtime reduction.

### Existing findings: confirmed and amended

#### Small removal: `setCaptionTexts` and exclusive helper module

Confirmed `project-editor.ts:45–52` and `src/lib/caption-text-edits.ts:1–18` have no production callers outside their closed pair. Whole-repository identifier/module searches find only `tests/caption-emoji-timing.test.mjs:9,61`, `tests/caption-tracks.test.mjs:26,510`, and direct helper tests at `tests/editor-logic.test.mjs:14,1013–1021`.

Preserve meaningful assertions by targeting the live script-update/commit path: manual text mode, translation stale synchronization, original timed-word/emoji semantics, text trimming/empty handling where actually required, and semantic no-op behavior. The APIs do not need to remain shipped merely to serve those tests. Existing gross body counts remain **8 lines / 412 bytes** plus the **18-line / 637-byte** helper module, excluding imports/test edits.

#### Small removal: `moveVisualLayer`

Confirmed `project-editor.ts:317–330` has only `tests/timeline-track-repair.test.mjs:9,270` as importing/calling references. Existing gross body count **14 lines / 723 bytes** remains supported.

**Clarification:** remove it because no current product path calls it. Do not describe `moveTimelineTrack` as a behaviorally equivalent replacement: `moveVisualLayer` changes `project.layers` compositing order, whereas timeline row ordering changes `timelineTrackOrder`. The deliberate separation is tested at `timeline-track-repair.test.mjs:255–265`; the obsolete hidden-neighbor test is **267–273**. Retain the live row-order/compositing-separation coverage rather than rewriting that old test to falsely assert equivalence.

#### R10: schema membership indexing — persisted JSON supported; broader equivalence NEEDS EVIDENCE

Confirmed for the persisted JSON path. Audio-source IDs are unique before lookup (**96**), audio clip IDs are checked before reference validation (**100**), and mapped video clips preserve the unique decoded clip IDs (**61,63–80**). For validated string IDs, Map lookup selects the same source as `find`; Set membership has the same outcome as `some`.

A tighter implementation boundary than the original report:

1. Capture the Set already returned by `uniqueIds(decodedClips, 'project video clips')` at **61** as `clipIds`, then reuse it at **108,131,138**, removing the later redundant construction at **126**. This retains duplicate rejection in its exact current position rather than replacing it with silent Set deduplication.
2. Build `audioSourceById` after the existing audio-source and audio-clip uniqueness checks (e.g. immediately after **100**), then replace only the source scan at **103**. Keep `audioSourceIds.has` and its existing missing-source error at **102**.
3. Keep the body and ordering of **104–117** unchanged: source bounds, video owner reference, extracted-audio origin, then recoverable source bounds. Keep source-array/clip-array decoding and duplicate checks in their current order. Do not merge loops or defer duplicate rejection.

The reported analytical worst case remains valid: each of the two scan terms can reach 50 million comparisons at the declared limits. Expected indexed membership work becomes linear in audio sources + video clips + audio clips. There is an extra source Map and a longer-lived clip Set, with no measured device-time, memory or bundle result. This is runtime work reduction, not necessarily source reduction.

**Scope qualification:** the exported decoder also accepts direct in-memory objects. `decodeArray` uses `.map` (**980–987**) and `uniqueIds` uses `.forEach` (**967–974**), which do not themselves reject sparse arrays. An eager `new Map(audioSources.map(...))` can throw on holes even when the current loop would never inspect the hole (for example, zero audio clips). Thus “exact equivalence for all arbitrary JavaScript inputs” is too broad. The production JSON decode/save paths avoid sparse arrays, but a future patch should either explicitly preserve the direct-call behavior or state/test the bounded JSON-data contract; it should not silently harden the decoder as incidental optimization. No sparse-array experiment was run in this read-only pass.

Required equivalence gates remain successful decoded snapshots and exact first error/message for duplicate sources/clips, unknown audio source, unknown video owner, invalid audio bounds + owner simultaneously, origin mismatch, recoverable bounds, empty lists, maxima and direct-input edge cases. Existing baseline tests do not establish equivalence of an unapplied patch.

### Protected compatibility boundary

`project-schema.ts:852–899` and `project.ts:312–341,422` retain inert background metadata. The decoder forcibly disables processing and empties keyframes, but still validates and retains a source URI/storage mode. `src/lib/media-lifecycle.ts:12–35` uses that source for linked permission and owned-file accounting; `src/lib/project-codec.ts:94–101` likewise retains the source. `tests/retired-background-processing.test.mjs:34–40` explicitly protects this behavior. Do not treat retired background rendering as authority to remove the metadata/cleanup path.

### Coverage accounting

All three source files were fully read. This supplement adds no independent source-removal totals.


## Full direct review completion: timeline and local model services

Reviewed checkout: `3ae54ddb3cf3253037a1c53aaf86177d09c7770a` in `Hatsunama/Caption-Studio`.

### Results

All four audited files were directly read in full, including every function and major lifecycle responsibility: **2,302 lines**. This establishes full direct semantic review coverage, not exhaustive runtime proof. No repository edits, installs, tests, builds, benchmarks, or network research were performed. This report alone was written outside the checkout.

- Confirm the existing dead video overlay, unused preload helper/constant, and unused preview-kind wrapper findings.
- Complete the legacy ripple branch's dependency boundary: **75 lines / 3,385 bytes** across three bodies. It is production-unreachable in this checkout. Test migration still requires care because the old branch and current edit path are not semantically interchangeable.
- Retain R8 as a bounded, conditional extraction, with a narrower order-preserving design and additional failure-path qualifications below. Do not merge verification policies.
- One additional conditional runtime candidate is justified: compute total clip duration without allocating a complete entry array. It is an allocation reduction, not a demonstrated speed or source-size saving.
- No other substantive removal or service consolidation is justified by this full-file pass. In particular, retain translation's accepted-batch/terminal-result validation and transcription's stop-observation/cleanup structure.

### Coverage evidence by file

#### `src/lib/video-timeline.ts` — 508 lines, D

Read lines 1–508. Responsibilities assessed:

- Imports, minimum duration, splice mapping types and boundary behavior (1–43): keep the explicit operation/duration mapping, insertion-left-edge rule, and fully removed translation-range visibility.
- Timeline representation/construction and dominant-owner/reorder mapping (45–106): preserve gap extents, stable maximum-overlap tie handling, primary-owner preference, missing-owner behavior and lost-clip error.
- Entry/segment lookup, total/rate-adjusted duration, source/timeline clocks and audio fade volume (108–158): keep half-open intervals, special final endpoint behavior, gap representation and rate/volume clamps. Additional allocation candidate below.
- Legacy transition overlay (160–186): confirmed test-only; actual compositor uses `video-transition-preview`.
- Source-word projection and reversible recovery (188–251): preserve clip-prefixed IDs, clipping/rate conversion, fail-closed gap/cross-clip recovery, collision detection, re-projection equality and valid unique IDs. These are not redundant checks: different repeated-source/fragment cases trigger them.
- Caption anchoring and source remapping (253–364): retain explicit timeline/manual modes, existing anchors, legacy word IDs, collision-safe derived caption IDs, automatic/manual text decisions, hidden/trimmed source ranges and restoration visibility.
- Legacy ripple family (366–420, 460–480): complete branch and reference review, detailed below.
- Playback-rate edit (422–458): live UI use at `src/app/editor.tsx:1492`; preserve relative/absolute timing, translation mapping and audio attachment remap.
- Numeric, layout-text and derived-ID helpers (482–508): live dependencies; no independent reduction proposed.

Relevant production paths inspected: `src/lib/project-editor.ts:467–480,677–761`, `src/app/editor.tsx:1492,1518`; all module import/reference matches were searched across the repository. Current project editing, transcription restoration, preview, translation tracks and export remain consumers of the live timeline functions.

#### `src/lib/video-transition-preview.ts` — 285 lines, D

Read lines 1–285. Responsibilities assessed:

- Preview contracts and constants (1–37).
- Window construction (39–151): transition normalization, integer/odd duration splitting, source availability, selected ranges versus optional handles, source playback rates/transforms, per-window unavailable diagnostics and overlapping-window invalidation. Keep all of these; replacing them with the old cover overlay would lose media/clock validation.
- Active frame/interpolated source times (153–171), dead preload lookup (173–184), dual-slot playback targets/muting (186–208), synchronized composite clock inversion (210–228), readiness/failed-key classification (230–244), dead kind wrapper (246–248).
- Source lookup, integer/source duration, bounded source rate and interpolation helpers (250–285).

Confirmed live consumers: `src/components/editor/video-transition-overlay.tsx:42–57,138`; `src/hooks/use-timeline-video-controller.ts:55,660,695`. The real preload scheduler is `use-timeline-video-controller.ts:450–480`, with generation/slot/ownership checks, readiness checks and delayed scheduling. It does not use the old 1,250 ms helper or constant.

#### `src/services/caption-translation.ts` — 937 lines, D

Read lines 1–937. Responsibilities assessed:

- Pinned release contract, explicit benchmark opt-in, public types/errors/state/resource lease ownership (1–149).
- Supported language normalization, stored-model readiness/accounting/removal and single-operation facade (151–210).
- Session preparation (212–289): capacity contract, operation IDs, language normalization, validated caption/context input, generated opaque keys, original-ID restoration maps, context-aware batching and session limits.
- Batch and session lifecycle (290–505): request correlation, sequential/idempotent accepted-batch commits, validation/review/failure projection, save rejection, recovery read after native failure, cancellation/error precedence, aggregate result metadata/count checks, fallback accepted-batch delivery, partial-save error reporting, listener shutdown, draining pending work, restoration and active-run ownership. Keep these responsibilities; superficially duplicate result processing protects different externally delivered boundaries.
- Cancellation (507–528): pause and native cancel are both attempted; failed stops are observed and retained. Do not simplify to fail-fast `Promise.all` or discard detached rejection observation.
- Shared-download ownership, reservation, progress, paused/integrity/transfer errors and marker persistence (530–641), including R8 distinctions below.
- Native capacity validation, bounded context slicing, per-cue output acceptance/untranslated detection (643–715).
- Native invocation, resume/refresh and benchmark policy, required metadata, sanitized benchmark metrics (717–802): keep opt-in-only benchmarking and whitelisted numeric/enumerated logging. Do not spread native objects into logs.
- Single integrity recovery without automatic replacement, progress poll ownership/rate limiting, stage/progress conversion, path/cancellation helpers and download display (804–937). Keep the model-preservation and explicit replacement-required behavior.

No additional dead production branch established. Repeated native metadata checks at 387–395 and 747–754 are not recommended as a standalone removal: they sit on different lifecycle sides of asynchronous accepted-batch handling; removing one needs ordering and mutation assumptions that this review did not establish.

#### `src/services/transcription.ts` — 572 lines, D

Read lines 1–572. Responsibilities assessed:

- Pinned Whisper/VAD descriptors, progress/result contracts and active-user/download state (1–102).
- Retryable obsolete-model pruning, current/VAD readiness, disk accounting and in-use removal guard (104–161).
- Prior-download termination before a session-owned writer, verified-identity lease reuse, independent model/VAD reservation/progress/error handling (163–301).
- Always-hash verification, post-hash identity check, atomic marker mechanics and pre-extraction replacement reservation (303–370).
- Media/audio validation, WAV space budget/extraction, model acquisition, bounded VAD context lifecycle, native Whisper startup and options (372–450).
- Native promise observation before stopper registration, registration-failure stop-and-drain path, aggregate errors, cancellation, word coalescing/speech alignment/detected-language validation and release/cleanup ownership (452–518).
- Cooperative overlapping PCM chunks, exact read length, per-chunk WAV cleanup, cancellation boundaries, progress, speech-window union and handle close (520–572).

The download routines share mechanisms but deliberately differ in ownership, progress and error policy; the existing shared `verified-model-download` already holds the transport mechanism. A larger configuration-driven consolidation is not recommended without concrete net simplification. Keep repeated cancellation checks at asynchronous/resource boundaries and observe native work before releasing its resources.

### Confirmations and amendments

#### Video helpers: confirmed bounded removals

- `video-timeline.ts:160–186`, `videoTransitionOverlay`: **27 lines / 1,114 bytes**. External calls are only in `tests/editor-logic.test.mjs` and `tests/video-transitions.test.mjs`. Its `effectiveVideoTransition` import at line 5 becomes unused. Preserve transition catalog/persisted-ID coverage and move applicable active-window assertions to the live preview APIs rather than deleting mixed test files.
- `video-transition-preview.ts:173–184`, `videoTransitionPreloadWindow`: **12 lines / 342 bytes**. Remove its exclusive exported constant at line 37 (**1 line / 49 bytes**) after test import cleanup. Only `tests/video-transition-preview.test.mjs:227–229` calls it. Keep the live controller scheduler identified above.
- `video-transition-preview.ts:246–248`, `transitionPreviewKind`: **3 lines / 112 bytes**. No callers. Remove only its exclusive imported `videoTransitionPreviewKind` name; the other transition imports remain live. Keep the catalog's own implementation for its other consumers.

These figures are existing body spans, not net patch, bundle or runtime savings.

#### Legacy ripple: dependency gap closed; do not claim replacement equivalence

Exact closed family:

| Span | Existing lines | UTF-8 bytes |
|---|---:|---:|
| `video-timeline.ts:366–375` `rippleDelete` | 10 | 468 |
| `video-timeline.ts:377–420` `rippleTimedContent` | 44 | 2,097 |
| `video-timeline.ts:460–480` private `rippleRange` | 21 | 820 |
| Total | **75** | **3,385** |

Whole-repository search found the wrapper only in `tests/project-timeline-duration.test.mjs:73`; the inner function has the wrapper plus `tests/primary-caption-timing.test.mjs:220` and `tests/translation-operation-remap.test.mjs:124`. `rippleRange` is private and called only by that inner function. Exclusive import names in this module are `VisualLayer`, `applyTimelineSpliceToAudioClips`, `synchronizeCaptionTracks`, and `primaryCaptionSurvives`. Their defining modules/functions remain live elsewhere and must not be deleted.

Current UI deletion is `src/app/editor.tsx:1518` → `project-editor.deleteVideoClip:467–480` → `rebuildAfterLayoutEdit:677–720`. It handles clip gaps, canonical source words, anchored/timeline captions, visual ownership, translation mapping, audio and canvas update. Production code does not call either legacy entry point.

Removal of this isolated family is supported by high-confidence current-repository production reachability. It is reasonable to classify it as a conditional test-migration removal, not an implementation merge or proof that the old and new mutation APIs are equivalent.

Important gate: `primary-caption-timing.test.mjs:216–225` preserves a positive 50 ms primary fragment because legacy `rippleRange` receives `primaryCaptionSurvives`. Current generic `project-editor.spliceTimedRange:761` uses an 80 ms floor, and anchored captions follow another remapping path. The old fixture cannot simply call the current editor API and be assumed to preserve its assertion. Decide whether that assertion is a current product contract and exercise it through the real edit path before retiring it. Likewise preserve direct translation-range remap metadata and audio/source-range assertions using live APIs; existing live deletion tests in `translation-operation-remap.test.mjs:103–119` and `project-timeline-duration.test.mjs:23–63` provide useful starting points. No native behavior or parity claim is made for the legacy implementation.

#### R8: confirm caveat, narrow extraction, keep policies separate

Identity projections are textually identical at `transcription.ts:346–353` and `caption-translation.ts:601–608` (**8 lines / 202 bytes** per copy). Calling them “pure” needs qualification: object construction is simple, but `File` properties may be native getters. An extraction should preserve getter order and call location rather than cache identity across an await.

Writer pairs remain **26 lines**, **845 versus 838 bytes**, exactly as previously reported. Their prelude order genuinely differs:

- Transcription `327–329`: read identity/encode, then construct marker.
- Translation `610–612`: construct marker, then read identity/encode.

A shared all-in-one writer would choose an order and could change the first thrown failure. The difference does not prohibit every extraction: retain the two small service preludes in their existing order, and share only the subsequent marker/staging mechanics (`transcription.ts:330–344`, `caption-translation.ts:613–627`) with the precomputed marker and contents. That would target one duplicated **15-line** tail, not promise deletion of an entire 26-line pair. Account for helper/wrapper/import overhead before calling it a net reduction; do not add flags or a generalized filesystem framework merely to save these lines.

Additional equivalence gates:

- Missing/invalid modification time must still remove the existing marker and return, without opportunistically changing other artifacts.
- Stale staging deletion and `staging.write` occur **before** the `try/finally`; current cleanup covers move failure, not every write failure. Expanding cleanup to include writes is a separate behavioral change.
- Preserve overwrite behavior and propagation/precedence when marker deletion, staging deletion/write, move, existence access or final cleanup throws. Test constructor/getter failures as well as rejected moves and interruption.
- Preserve async return/error boundaries and service test harness imports; do not move identity acquisition across hashing or other awaits.
- `transcription.ts:303–324` always hashes and rechecks identity after hashing, with cancellation checks. `caption-translation.ts:629–640` may accept a matching marker before hashing; its native-integrity recovery at 824–849 invalidates the marker, rechecks once and preserves the downloaded model. These policies must remain separate.

The existing `translation-integrity-errors.test.mjs:25–63` tests verifier behavior while stubbing the marker writer. It does not supply evidence that a newly extracted real atomic writer preserves failure ordering. Keep R8 conditional until dedicated filesystem-injection tests establish that evidence.

### Additional conditional runtime candidate

#### Avoid full timeline allocation for duration-only callers

`video-timeline.ts:133–135` calls `buildClipTimeline(clips).at(-1)` solely to obtain the final cursor. `buildClipTimeline:57–68` allocates an array and one entry object per clip. Duration-only calls appear in project/schema-adjacent timeline logic, audio operations, subtitles and translation remapping; none needs those temporary entry records.

A duration-only accumulator can perform the same three ordered additions per clip: valid leading gap, `clipTimelineDuration`, valid trailing gap. It avoids O(number of clips) temporary entries while retaining O(number of clips) arithmetic. This is potentially useful with the schema's large clip arrays; it is **not a benchmarked latency gain or a source-line reduction**. The pure construction routine is tiny, so prioritize only if allocation/profile evidence or a broader timing cleanup supports it.

Equivalence gates: preserve left-to-right floating-point addition order (do not regroup into per-clip sums), fractional rates, finite/nonfinite normalization, leading/trailing gaps, empty arrays and final endpoint behavior. Establish dense, ordinary decoded clip arrays as the supported input domain: sparse arrays or getters/proxies can make generic JavaScript rewrites observably different. Differential duration/render-plan fixtures and a representative allocation profile are appropriate before adoption. The full timeline builder remains necessary for entry/clock/owner consumers.

### Limits

Reference evidence is repository-wide textual search plus direct caller inspection, not a compiler-produced call graph or proof about out-of-repository consumers. All four files received full direct semantic review. Gross source-byte figures do not imply shipped-byte savings. Suggested edits remain unapplied and equivalence tests remain unrun.


## Native modules and bridge compression audit

Repository: Hatsunama/Caption-Studio, main commit `3ae54ddb3cf3253037a1c53aaf86177d09c7770a`.
Read-only static audit. Repository files were not edited; no install, app launch, test run, compilation, native packaging, or generated-source regeneration was performed. `git status --short` was empty when checked. AGENTS.md was read: it requests exact Expo 57 documentation before writing code; no code was written.

### Result

Keep all four native modules and all four direct production Maven dependencies. There are small, well-evidenced source reductions, not evidence for a native-stack rewrite. The smallest media/refract removal batch deletes 3,035 UTF-8 source bytes across 52 physical lines in six source files, before optional blank-line cleanup. Its dominant reduction is unreachable retired transition rendering. This is measured source span size, not a measured patch, DEX/APK/AAB saving, startup improvement, or runtime-memory saving. Existing release configuration enables R8 and resource shrinking (`scripts/configure-android-release.js:79–80`), so many dead declarations may already be absent from release binaries.

Across `modules/`: 144 files, 903,743 bytes. Of these, 444,781 bytes are production `.kt`/`.java`/`.ts` source, 447,789 bytes are test/resource/runner files, and 11,173 bytes are configuration/licenses. Per module: diagnostics 9 files / 5,023 bytes; media 61 / 355,564; refract 8 / 15,878; translation 66 / 527,278. File sizes are filesystem UTF-8 bytes at the audited commit, not compressed/package sizes. Translation findings and its complete 66-file inventory appear in the appendix below.

### Smallest media/refract changes, in priority order

Paths below are relative to the repository. `M` means `modules/caption-media/android/src/main/java/app/captionstudio/media/`; `R` means `modules/caption-refract/android/src/main/java/app/captionstudio/refract/`.

| ID | Classification | Exact evidence and smallest change | Measured removable source | Risk and required proof |
|---|---|---|---:|---|
| N1 | SAFE REMOVE | `M/TimelineVideoExporter.kt:778–790`: remove `wipe-*` and `slide-*` branches in `TimelineBitmapOverlay.drawCompositeTransition`. Remove the then-unused RectF import at 14, `clipRect` parameter at 850, and conditional clip at 861. Registry `TimelineTransitionSpec.kt:7–30` excludes all eight types; `getBitmap` invokes strict `renderingPath` at 670 before dispatch; `drawCompositeTransition` again requires `compositeTypes` at 748. No supported input can reach those branches. | 1,340 bytes / 16 lines | Keep the strict rejection and all 14 registered composite transitions. `TimelineTransitionSpecTest.kt:35–45` explicitly rejects `wipe-left` and `slide-left`; expand rejection table to all eight retired names and run transition overlay/geometry/timeline tests. Existing invalid serialized projects must still fail identically. Do not delete slide animations from caption text: those are a different, live feature. |
| N2 | SAFE REMOVE | `M/CaptionMediaModule.kt:1179–1181`: three unreferenced person-preview constants; 1216: unreferenced private `PreviewMatte`; 9–12,24,29: unused Canvas/Color/Matrix/Paint/ExifInterface/Permissions imports. Repository-wide symbol search found constants and PreviewMatte only at declarations. `tests/retired-background-processing.test.mjs:7–32` establishes the old person/background path is retired. | 480 bytes / 10 lines | Preserve legacy metadata cleanup elsewhere. ExifInterface itself remains live in BitmapOrientation and export image loading, so removing its import does not justify removing the dependency. Compile module and run retired-background processing test. |
| N3 | SAFE REMOVE | `M/BitmapOrientation.kt:21–27,53–55`: two uncalled `orientBitmap` convenience overloads and uncalled integer `orientBitmapAndRecycle` overload. Only production use is `TimelineVideoExporter.kt:906`, calling the orientation-valued recycling overload at 45–51, which reaches the three-argument private functions. No test calls the removable overloads. | 532 bytes / 10 lines | Keep `fromExif`, horizontal flip, normalized rotation, recycle-on-failure and identity handling at 57–65. Add/retain all EXIF orientations and same-bitmap/new-bitmap/error ownership checks; export image orientation smoke test. |
| N4 | SAFE REMOVE | `M/CaptionMediaModule.kt:830–832,904–906`: remove local `outputTrack`, `muxerStarted`, `firstPresentationUs` declarations and mirror assignments in `transcodeAudioTrackToAac`. They are written but never read by that method. The live authoritative fields are `AacEncodeDrainState` at 1207–1213 and `drainAacEncoder` at 986–1034. | 292 bytes / 6 lines | Do not remove `lastPresentationUs` maximum accumulation (907), `encodedSamples` validation (911), EOS tracking, muxer-state fields, or remux fallback. Compile; verify AAC fallback import, non-AAC input, empty/corrupt audio, EOS, cancellation, and cleanup. |
| N5 | SAFE REMOVE | `M/TimelineTextPainter.kt:579–583`: uncalled private `transformText`. Current renderer transforms runs with `Locale.ROOT` in `TextPresentation.kt:65–70`. Do not remove similarly named JS subtitle-export function, which is independently live. | 169 bytes / 5 lines | Run text render/preview parity and case-conversion fixtures, including locale-sensitive inputs. This is deletion of an unused helper, not a rewrite of actual text transformation. |
| N6 | SAFE REMOVE | `M/AudioWaveformPeaks.kt:7,15–17`: unused `DEFAULT_PEAK_COUNT` and `sampleAmplitude`; production `AudioWaveformDecoder.generate` clamps the requested count at 35 and reads amplitudes using its wider-format implementation at 146–158. | 179 bytes / 4 lines | Keep clamp limits and timestamp accumulator. No change to normalization, sample encodings, timestamps, or JS count validation at `src/services/project-media.ts:128–143`. |
| N7 | SAFE REMOVE | `R/RefractBackgroundView.kt:111`: uncalled `isAnimating()` getter; no JS bridge exposes it, no source/test references it. | 43 bytes / 1 line | Keep actual animating state, visibility, attach/detach callbacks, and Choreographer lifecycle. Verify focus/background/foreground/resize behavior. |
| N8 | KEEP / not recommended as a separate cosmetic change | Unused imports: `M/TimelineVideoExporter.kt:63` (`sin`), `M/TimelineTextPainter.kt:9` (`Uri`), `M/AudioWaveformDecoder.kt:9` (`Uri`). | 69 bytes / 3 lines | Compile/import validation. No dependency can be removed on this evidence alone. |

The 3,035-byte total counts N1–N7 without overlapping spans; N8 is excluded as standalone cosmetic cleanup. It does not include translation or any conditional candidate below. No production file can be removed wholesale from these three modules on established evidence.

### Additional narrow simplification/consolidation opportunities

1. SIMPLIFY: `TimelineBitmapOverlay.decodeWidth/decodeHeight/decodeSize`, `M/TimelineVideoExporter.kt:945–953`, are nine lines / 209 bytes of lazy wrappers around immutable `plan.width`/`plan.height`. Replace the sole use at 857 with those fields; no second cache needed. The new call spelling is two bytes shorter, giving a 211-byte net source reduction if those lines alone are removed. This also removes a lazily allocated Pair/delegate, but no runtime memory or timing saving was measured. Validate rectangular/rotated transition decode-size behavior.
2. KEEP / not recommended as a separate parameter-only cleanup: `drawTransitionSnapshot`'s `timelineTimeMs` parameter at `TimelineVideoExporter.kt:848` is unused; the parameter in `drawMaskedTransitionSnapshot` at 832 only forwards it at 838. Remove the pair and corresponding actual arguments together. Do not remove similarly named `timelineTimeMs` in `TimelineClipGainProvider:1068–1082`, which drives live gain timing. Exact net bytes depend on call-site formatting and were not claimed.
3. KEEP / not recommended as a separate compression change: identical `mediaFormatInt` bodies in `M/CaptionMediaModule.kt:475–477` (144 bytes) and `M/TimelineExportDelivery.kt:222–224` (138 bytes) can share a small internal helper. Preserve existing `containsKey`/getInteger behavior and the separate optional-integer helper. A new helper name/file and imports may consume much of the source saving. No runtime gain established.
4. KEEP / not recommended as a separate cosmetic change: `extractAudioTrack` explicitly catches/rethrows `Error` at `CaptionMediaModule.kt:663–664,672–673`. Those catch clauses add no change relative to falling through because the remaining general handler catches `Exception`, not `Throwable`. Removing the two 47-byte spans is semantically narrow, but keep the `CancellationException` bypass of fallback and error wrapping. Source tests may recognize textual patterns; run them and use behavioral tests instead of preserving dead syntax.
5. NEEDS EVIDENCE before removal: `persistReadPermission` has no production JS caller in the repository. Native registration/helper are `CaptionMediaModule.kt:80–82,227–232` (356 bytes), and TS declaration `modules/caption-media/src/CaptionMediaModule.ts:11` is 61 bytes. Current acquisition is `LinkedVideoDocuments.kt:53–59` → `DocumentReadAccess.retainResult:22–28`, and recovery deliberately repicks via `src/services/project-media-access.ts:13–23`. Because this is a named bridge API, confirm it is not an external/native compatibility surface and no release/update path calls it before removing the 417-byte surface. Retain grant machinery. `DocumentReadAccessTest.kt:49` mentions the name only in a comment.
6. NEEDS EVIDENCE / test migration: `AudioWaveformPeaks.bucketPeaks` at 19–31 (538 bytes) is called only by `AudioWaveformPeaksTest.kt:18,26`, while production uses `accumulateTimeBucket`. Retire or move the old dense-array helper only with equivalent tests on production timestamp bucketing, including silent/empty input and loudest-per-bucket cases. Likewise `CaptionTextBreaks.compactPattern` at 5 plus `usesCompactSpacing` at 63 (201 bytes) is referenced only by `CaptionTextBreaksTest.kt:17–22`; current StaticLayout shaping/spacing must be characterized before discarding the legacy predicate/test. Do not count tests as APK savings.
7. KEEP / separate type-accuracy issue, not a compression recommendation: `modules/caption-media/src/CaptionMedia.types.ts:96` declares required `peakCount` (21 bytes), but native `AudioWaveformDecoder.kt:98–101` returns only durationMs and peaks, and no JS caller reads peakCount. Remove the inaccurate field or make it optional as a separate bridge type correction; behavior and serialization stay unchanged. No runtime-size benefit.
8. CONSOLIDATE only if net simpler: repetitive source opening in CaptionMediaModule, VideoPreviewPreparer, AudioWaveformDecoder, TimelineAudioRenderer, ManagedRetriever and exporter. Share a very small `MediaInputPolicy`-guarded source-opening primitive only where contracts truly agree. Waveform's content path explicitly uses a descriptor (`AudioWaveformDecoder.kt:177–187`), while others use Context/Uri; output inspection intentionally accepts published MediaStore URIs (`TimelineExportDelivery.kt:206–219`). Do not erase these differences or add app-input ownership checks to published outputs.
9. KEEP / NEEDS MEASUREMENT: refract `doFrame` calls `invalidate()` and `postInvalidateOnAnimation()` at 187–188. They look redundant, but removing one is frame scheduling behavior, not proven static equivalence. Keep without frame-cadence/power/background measurement. Do not change deterministic seed/PRNG consumption, draw order, ray sampling, or node count for size.
10. KEEP / NEEDS MEASUREMENT: text animation functions have many similar branches; creating a generic data-driven animation interpreter may change float operation order, shaping envelopes, supported defaults and preview/export parity. Retain existing functions unless frame-image and numerical-contract tests prove equality across timing/intensity extremes. Hoisting regexes or caching English inflections in EmojiReactionCatalog could help allocation cost, but would be runtime work, not measured source compression, and requires catalog-equivalence tests.

### Protected invariants: do not compress these away

- `MediaInputPolicy.kt:9–57`: canonical owned file roots, scheme/authority/query/fragment checks, stricter output root rules, and app-owned-file-before-font-validation. These are native boundaries even though JS also validates. `SfntFontValidator.kt:8–45` validates header, ranges, duplicates, alignment and required tables before Android Typeface loads. Media/font/image limits, hash verification and cancellation are security/liveness checks, not redundant boilerplate.
- `DocumentReadAccess.kt:15–28` acquires lasting permissions and verifies them; `check` remains read-only. `LinkedVideoDocuments.kt:86–109` releases only newly acquired grants in reverse order on partial selection failure, retaining original failure and suppressed cleanup failures. `releasePersistedReadPermission:65–77` checks actual retained state even after a SecurityException. Do not collapse check/acquire/release.
- `CaptionMediaModule.kt:112–125,210–215,566–569`: atomic audio epochs and cancellation are shared across extraction, timeline preparation and module destruction. Resource cleanup at 648–653 and 933–941 is deliberate. The three duplicated audio loops serve different semantics: WAV extraction with gap/overlap handling, lossless remux, and AAC transcode fallback; replacing them with one generalized loop is not a safe size win.
- `TimelineAudioRenderer.kt:147–376`: single bounded worker, preflight drain boundary, active task identity, cancellation acknowledgements, main-thread Transformer ownership and genuine-failure preservation. `TimelineAudioRendererTest` directly covers blocked native probes, cancel races, queued retries and stop failure. Removing state or early-resolving cancellation can delete still-written media or admit overlapping work.
- `TimelineAudioLanePlanner.kt:25–105`: microsecond arithmetic, half-open intervals, maximum-overlap lane packing, explicit reserved ends and silent gaps. This is already shared by caption audio and video export. Revert to one lane per clip or merge audio plans indiscriminately and 1,000-cut memory/time behavior changes.
- `TimelineVideoExporter.kt:119–173,425–475,488–570`: render → verify → publish → verify → commit sequence; cancellation/publication share state lock; publishedVerified blocks deleting a successfully committed output. Keep both local and published-copy verification. Do not merge callback ownership states, replace the publishing executor with fire-and-forget, or delete output before writers stop.
- `TimelineExportDelivery.kt:43–179`: exact byte count even for unknown descriptor lengths, video-track duration separate from container/audio duration, dimensions/crop/rotation and audio intent. Nonempty file + successful encoder callback is not equivalent delivery validation.
- `TimelineVideoExporter.kt:605–612,616–645`: duplicate-looking base sequences are intentional: hidden timestamp clock, footage, visible background. `TimelineVideoCompositorSettingsTest` verifies this layout and gaps/tails. Do not remove the third sequence as redundant.
- `TimelineTransitionTimeline.kt:65–175,196–220`: real recoverable source handles, advancing frame interpolation, full-source fallback, contiguous audio, equal-power gains and unsupported-rate rejection. Treat transition source bounds and audio separately from visual branch compression.
- `TimelineBitmapOverlay.release:925–942`, reusable bitmap 1120–1142, retriever cache 966–985, bitmap cache 987–1013: cache ownership, repeated close, released-state checks, bounded working sets. Cache sharing across preview/export could create recycling/race faults.
- `CaptionPresentationView` and `TimelineTextPainter` are intentionally shared by native live preview and export. Entry point is `src/components/editor/caption-presentation.tsx:10–12,50–59`; module owns view destroy at `CaptionMediaModule.kt:71–77`. Preserve editing-preview visibility and geometry-independent fitting (`TimelineTextPainter.kt:294–366`), Unicode/grapheme/punctuation mapping, case transform locale, authored newlines, bidi markers, fallback font metrics, fitting envelopes, and bitmap equality. JS approximations are not a substitute.
- `EmojiReactionCatalog.kt:13–52` and shared catalog are runtime-validated input and meaning. Native build exposes `shared` as assets (`caption-media/android/build.gradle:21–24`), already avoiding an extra native JSON copy. Retain catalog rows, required families and all shared contract fixtures. Its `fallback` field is validation-only in this renderer, but removing the contract changes validation failure behavior and may affect other consumers.
- Diagnostics is a live product feature: `_layout.tsx:11,26` captures exits and `privacy.tsx:16,83` shares sanitized records via `src/services/local-diagnostics.ts`. `CaptionDiagnosticsModule.kt:18–33,38–52` restricts record count and substitutes safe enumerated descriptions; do not expose OS raw descriptions or drop it as debugging-only.
- Refract is live: `src/components/refract-background.tsx:6–14` requires native view by module name; `src/app/index.tsx:125` uses it. The missing standalone npm package.json is not evidence the local Expo module is unused. Its attach/visibility/background lifecycle (`RefractBackgroundView.kt:98–190,342–356`) stops callbacks, and `RefractSeed.kt:14–40` preserves stable per-install/device appearance. Removing it changes visible behavior.

### Native dependency decisions

All explicit `dependencies` entries in every `modules/*/android/build.gradle` are accounted for here; this is distinct from a release dependency graph or APK inspection.

| Declaration | Decision | Evidence and limits |
|---|---|---|
| `androidx.exifinterface:exifinterface:1.4.2` | KEEP | media build.gradle:29; BitmapOrientation.fromExif 14–17, exporter decodeImage 893–906. Exif orientation/flips are needed. Replacing with homegrown EXIF parsing would broaden complexity/security risk. |
| `androidx.media3:media3-transformer:1.10.1` | KEEP | media build.gradle:30; video/audio export and preview transformation. Actual Composition, Transformer, EditedMediaItem/Sequence, Effects and progress/lifecycle integration throughout three renderers. No functionally equivalent removal demonstrated. |
| `androidx.media3:media3-effect:1.10.1` | KEEP | media build.gradle:31; BitmapOverlay, OverlayEffect, Presentation, StaticOverlaySettings, FrameDropEffect. It may also arrive transitively; deleting its direct declaration does not remove a duplicated runtime artifact. Preserve explicit direct use unless resolved graph demonstrates a legitimate consolidation. |
| `com.google.ai.edge.litertlm:litertlm-android:0.16.1` | KEEP; shrink footprint NEEDS MEASUREMENT | translation build.gradle:23; typed runtime use and real offline translation path. No safe replacement established. Consumer rules/ABI/assets must be assessed on built release output; see translation appendix. |
| `junit:junit:4.13.2` in media and translation | DEVONLY / KEEP | media build.gradle:32, translation:24. Native JUnit tests use it extensively. Repetition across modules is dependency configuration, not multiple shipped copies. |
| `org.robolectric:robolectric:4.16.1` | DEVONLY / KEEP | media build.gradle:33. Tests exercise Android raster, URI, Media3 and lifecycle semantics. Do not delete for package-size savings because testImplementation is not a production runtime dependency. |
| `org.mockito:mockito-core:5.14.2` | DEVONLY / KEEP | translation build.gradle:51; SDK typed-status regression/mocking. |
| `net.bytebuddy:byte-buddy-agent:1.15.4` through translationMockitoAgent | DEVONLY / KEEP | translation build.gradle:43–60; Java 21 test instrumentation, non-transitive configuration, test JVM -javaagent. Not an APK asset. |
| `com.android.library` and `expo-module-gradle-plugin` in all four modules | DEVONLY build infrastructure / KEEP | Every module build.gradle:1–4; modules compile/link through Expo. Their presence is not removable runtime code. |
| Java/JVM toolchains and Kotlin compiler integration | DEVONLY / KEEP | translation build.gradle:10–13,28–41,55–84 keeps JDK21 compilation with JVM17 output and test validation. No consolidation should silently lower toolchain compatibility. |
| Android framework graphics/media/storage APIs, org.json, androidx.core/common/annotation used transitively | KEEP (framework/transitive) | Source imports represent actual APIs; they are not separate direct declarations to delete. Need resolved dependency graph and release analyzer before reporting binary ownership or duplicate classes. |
| `caption-media`, `caption-translation`, `caption-diagnostics` file dependencies and local `caption-refract` | KEEP | Live JS calls and native views established above and in translation appendix. Expo peer dependency bridges used by all four. |
| MediaPipe/person-segmentation dependency | REMOVE already accomplished; do not re-add | No declaration exists; retired-background test asserts absence of mediapipe/face-detection. This is current-state evidence, not a new saving to claim. |

No direct production native dependency has evidence supporting REMOVE or REPLACE. CONSOLIDATE applies only to build-version declaration hygiene if wanted, not runtime artifact removal. Root Expo/RN/whisper app-package dependencies belong to the repository-wide dependency review; nothing in this module audit establishes one removable. Focused `tests/native-text/build.gradle` separately declares Kotlin JVM plugin, Android SDK jar, JUnit, Robolectric, androidx.test monitor and espresso idling-resource AARs; all are DEVONLY, used for standalone verification, not production package savings.

### Verification required before any implementation

1. Read-only audit provides no passing build/test claim. Run the existing logic tests, release module tests and product-contract check in an authorized build workspace. Gate source removals on native Kotlin/Java compile plus bridge TS checking. Keep generated contract generation source and output in sync; do not hand-minify generated contract files.
2. Native test suite is substantial but not device encoder proof. Required representative device tests: content/file imports, revoked or missing grants, partial document selection rollback, non-AAC audio fallback, waveform PCM formats, WAV gap/overlap/cancel, foreground/background/reset behavior, imported and built-in fonts, image EXIF, every supported transition, long cut lists, independent scale axes, empty/gapped timelines and audio tails, export cancellation during each phase, published file share/readback.
3. Text/render changes need both numeric shared fixtures and raster comparison: all animations, differing intensity/timing, emoji timing, mixed CJK/Latin/RTL/astral/combining content, every bundled font, authored line breaks and preview/export parity. Shape tests alone do not cover pixel equivalence.
4. Binary savings need same-toolchain release before/after AAB/APK, resolved Maven graph, R8 mapping/seeds/usage and per-ABI native-library/asset accounting. Runtime savings need same-device/profile long export, peaks/import, memory and frame cadence. Repository bytes and test deletion are not package-size evidence.
5. Unverified verification blocker: standalone `tests/native-text/build.gradle:21–23` includes TimelineTextPainter but not MediaInputPolicy, now called by painter at 443. Source inspection suggests this focused runner may fail compilation. This was not executed and is not included as an authorized fix or proved runtime defect. Translation runner issues are documented in its appendix. Verify/correct harness coverage before relying on it for compression acceptance.

### Coverage detail

Media, diagnostics and refract: full text reviewed for all 78 files, including all 26 media native tests, four media contract resources, module configs/manifests/package metadata/licenses and every Kotlin/TS production source. Translation: all 66 files received static source or test-contract/resource review, with review depth recorded in the appendix. Targeted cross-boundary references/readback additionally included package.json, app.json, source/services and components named above, `tests/retired-background-processing.test.mjs`, focused native-text Gradle files, and `shared/emoji-reactions.json` (11,268 bytes). These external references are supporting scope, not a claim to full review of all src/tests files.

Classification inventory below is per file. KEEP on test/resources means preserve behavior coverage, not claim every helper is irreducible. Individual optional reductions above remain explicitly scoped.

| File | Bytes | Review result |
|---|---:|---|
| `modules/caption-diagnostics/LICENSE` | 1,106 | KEEP: license notice obligation; not dead runtime code |
| `modules/caption-diagnostics/android/build.gradle` | 254 | KEEP: module/package/Gradle/manifest contract inspected |
| `modules/caption-diagnostics/android/src/main/AndroidManifest.xml` | 23 | KEEP: module/package/Gradle/manifest contract inspected |
| `modules/caption-diagnostics/android/src/main/java/app/captionstudio/diagnostics/CaptionDiagnosticsModule.kt` | 2,557 | KEEP: live bounded sanitized diagnostics |
| `modules/caption-diagnostics/expo-module.config.json` | 125 | KEEP: module/package/Gradle/manifest contract inspected |
| `modules/caption-diagnostics/index.ts` | 106 | KEEP: exported package entry point |
| `modules/caption-diagnostics/package.json` | 263 | KEEP: module/package/Gradle/manifest contract inspected |
| `modules/caption-diagnostics/src/CaptionDiagnostics.types.ts` | 204 | KEEP: diagnostic bridge schema |
| `modules/caption-diagnostics/src/CaptionDiagnosticsModule.ts` | 385 | KEEP: live required module binding |
| `modules/caption-media/LICENSE` | 1,106 | KEEP: license notice obligation; not dead runtime code |
| `modules/caption-media/android/build.gradle` | 799 | KEEP: module/package/Gradle/manifest contract inspected |
| `modules/caption-media/android/src/main/AndroidManifest.xml` | 82 | KEEP: module/package/Gradle/manifest contract inspected |
| `modules/caption-media/android/src/main/java/app/captionstudio/media/AudioTrackExtraction.kt` | 1,017 | KEEP: lossless MIME/sample filtering and duration fallback |
| `modules/caption-media/android/src/main/java/app/captionstudio/media/AudioWaveformDecoder.kt` | 8,520 | KEEP core; KEEP; unused Uri import is cosmetic only |
| `modules/caption-media/android/src/main/java/app/captionstudio/media/AudioWaveformPeaks.kt` | 1,410 | SAFE REMOVE unused constant/amplitude; NEEDS EVIDENCE test-only dense helper; KEEP timestamp peaks |
| `modules/caption-media/android/src/main/java/app/captionstudio/media/BitmapOrientation.kt` | 2,299 | SAFE REMOVE uncalled overloads; KEEP EXIF/recycling path |
| `modules/caption-media/android/src/main/java/app/captionstudio/media/CaptionEmojiAnimation.kt` | 760 | KEEP: live cue progress and sparse semantic reactions |
| `modules/caption-media/android/src/main/java/app/captionstudio/media/CaptionMediaModule.kt` | 51,943 | SAFE REMOVE remnants/mirrors/imports; KEEP live bridge/media boundaries |
| `modules/caption-media/android/src/main/java/app/captionstudio/media/CaptionPresentationView.kt` | 1,685 | KEEP: shared native preview/view lifecycle |
| `modules/caption-media/android/src/main/java/app/captionstudio/media/CaptionTextBreaks.kt` | 3,935 | KEEP text/timing; NEEDS EVIDENCE test-only compact-spacing predicate |
| `modules/caption-media/android/src/main/java/app/captionstudio/media/DocumentReadAccess.kt` | 2,563 | KEEP: read/grant/rollback and release semantics |
| `modules/caption-media/android/src/main/java/app/captionstudio/media/EmojiReactionCatalog.kt` | 7,998 | KEEP: validated shared runtime catalog and semantic matching |
| `modules/caption-media/android/src/main/java/app/captionstudio/media/LinkedVideoDocuments.kt` | 4,063 | KEEP: picker promise/grant acquisition/rollback |
| `modules/caption-media/android/src/main/java/app/captionstudio/media/MediaInputPolicy.kt` | 2,323 | KEEP: canonical URI/file security boundaries |
| `modules/caption-media/android/src/main/java/app/captionstudio/media/RenderTransforms.kt` | 839 | KEEP: content matrix preview/export geometry |
| `modules/caption-media/android/src/main/java/app/captionstudio/media/SfntFontValidator.kt` | 3,228 | KEEP: untrusted-font format safety |
| `modules/caption-media/android/src/main/java/app/captionstudio/media/TextPresentation.kt` | 8,533 | KEEP: authored text, bidi shaping, fitting and ink bounds |
| `modules/caption-media/android/src/main/java/app/captionstudio/media/TimelineAudioLanePlanner.kt` | 4,572 | KEEP: shared minimum-lane planner and microsecond gaps |
| `modules/caption-media/android/src/main/java/app/captionstudio/media/TimelineAudioRenderer.kt` | 15,566 | KEEP: audible mix, bounded preflight, cancellation drain |
| `modules/caption-media/android/src/main/java/app/captionstudio/media/TimelineExportDelivery.kt` | 9,056 | KEEP validation and integer helper; no standalone cosmetic extraction |
| `modules/caption-media/android/src/main/java/app/captionstudio/media/TimelineRenderPlan.kt` | 18,286 | KEEP: native schema validation and defaults |
| `modules/caption-media/android/src/main/java/app/captionstudio/media/TimelineTextPainter.kt` | 25,542 | SAFE REMOVE dead helper/import; KEEP live preview/export painter |
| `modules/caption-media/android/src/main/java/app/captionstudio/media/TimelineTransitionSpec.kt` | 1,658 | KEEP: exact fail-closed renderer registry |
| `modules/caption-media/android/src/main/java/app/captionstudio/media/TimelineTransitionTimeline.kt` | 9,230 | KEEP: source recovery and equal-power contiguous audio |
| `modules/caption-media/android/src/main/java/app/captionstudio/media/TimelineVideoExporter.kt` | 48,666 | SAFE REMOVE retired branches/import; SIMPLIFY redundant dimension wrapper; KEEP export lifecycle |
| `modules/caption-media/android/src/main/java/app/captionstudio/media/VideoPreviewPreparer.kt` | 6,935 | KEEP: decoder support/proxy preparation and ownership |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/AudioTrackExtractionTest.kt` | 1,733 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/AudioWaveformPeaksTest.kt` | 1,343 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/CaptionEmojiAnimationTest.kt` | 1,707 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/CaptionTextBreaksTest.kt` | 842 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/DocumentReadAccessTest.kt` | 1,939 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/EmojiReactionCatalogTest.kt` | 4,357 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/LinkedVideoDocumentsGrantTest.kt` | 1,284 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/MediaInputPolicyTest.kt` | 2,574 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/PersistedReadPermissionReleaseTest.kt` | 1,418 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/PublishedVideoSizeTest.kt` | 1,037 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/RenderTransformsTest.kt` | 2,048 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/SfntFontValidatorTest.kt` | 2,191 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/TextPresentationTest.kt` | 7,904 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/TimelineAudioLanePlannerTest.kt` | 5,741 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/TimelineAudioLanesTest.kt` | 7,540 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/TimelineAudioRendererTest.kt` | 12,405 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/TimelineExportDeliveryTest.kt` | 6,080 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/TimelineNativeResourceTest.kt` | 2,991 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/TimelineRenderPlanTest.kt` | 14,105 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/TimelineTextPainterAnimationTest.kt` | 4,979 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/TimelineTransitionGeometryTest.kt` | 644 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/TimelineTransitionOverlayTest.kt` | 3,753 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/TimelineTransitionSpecTest.kt` | 2,492 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/TimelineTransitionTimelineTest.kt` | 8,873 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/TimelineVideoCompositorSettingsTest.kt` | 2,918 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/java/app/captionstudio/media/VideoTransformParityTest.kt` | 2,042 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/resources/caption-animation-contract.csv` | 1,361 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/resources/caption-emoji-timing-contract.csv` | 298 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/resources/caption-word-timing-contract.tsv` | 583 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/android/src/test/resources/emoji-reaction-context-contract.tsv` | 1,169 | KEEP / DEVONLY: complete test or shared-contract resource inspected |
| `modules/caption-media/expo-module.config.json` | 113 | KEEP: module/package/Gradle/manifest contract inspected |
| `modules/caption-media/package.json` | 283 | KEEP: module/package/Gradle/manifest contract inspected |
| `modules/caption-media/src/CaptionMedia.types.ts` | 1,897 | KEEP: bridge schema; peakCount mismatch is a separate type-accuracy issue |
| `modules/caption-media/src/CaptionMediaModule.ts` | 2,306 | KEEP: live bridge declarations; NEEDS EVIDENCE unused named permission API |
| `modules/caption-refract/LICENSE` | 1,106 | KEEP: license notice obligation; not dead runtime code |
| `modules/caption-refract/android/build.gradle` | 246 | KEEP: module/package/Gradle/manifest contract inspected |
| `modules/caption-refract/android/src/main/AndroidManifest.xml` | 23 | KEEP: module/package/Gradle/manifest contract inspected |
| `modules/caption-refract/android/src/main/java/app/captionstudio/refract/CaptionRefractModule.kt` | 404 | KEEP: live Expo native-view registration |
| `modules/caption-refract/android/src/main/java/app/captionstudio/refract/CaptionRefractView.kt` | 587 | KEEP: active visibility bridge |
| `modules/caption-refract/android/src/main/java/app/captionstudio/refract/RefractBackgroundView.kt` | 12,151 | SAFE REMOVE uncalled getter; KEEP deterministic render/lifecycle |
| `modules/caption-refract/android/src/main/java/app/captionstudio/refract/RefractSeed.kt` | 1,244 | KEEP: persisted deterministic appearance seed |
| `modules/caption-refract/expo-module.config.json` | 117 | KEEP: module/package/Gradle/manifest contract inspected |


---

## Appendix: Translation module

### Caption Translation: behavior-preserving compression audit

Repository: `Hatsunama/Caption-Studio`, commit `3ae54ddb3cf3253037a1c53aaf86177d09c7770a` (HEAD verified). Scope: every file under `modules/caption-translation`, with targeted caller, generator, parity, and test-runner tracing outside that module. Date: 2026-10-17 UTC.

### Result

The safest production cleanup is very small: remove one unreferenced private exception factory (217 source bytes), and remove one unreferenced private fallback helper (272 source bytes) while correcting a stale source-name test. The two complete method ranges total **489 source bytes / 11 lines**, excluding surrounding blank lines. There is no established whole production file or runtime dependency that can be removed while preserving behavior.

Worthwhile follow-on consolidations are the two caption-map serializers, one duplicated Unicode-whitespace predicate, and the divergent developer test runners. The large translator class is an orchestration/state machine with real strict-output, partial-success, checkpoint, native-ownership, and retry requirements. Treating those requirements as removable boilerplate would be unsafe.

No repository files were changed. No application, build, installation, test suite, model inference, or dependency download was run. `AGENTS.md` was read; its versioned Expo documentation requirement applies before writing code, and no code change was made here.

### Evidence limits and measured footprint

Read-only evidence consisted of line-numbered source/config inspection, whole-module file enumeration and byte counts, symbol/caller searches, test-contract/helper inspection, parsing all three JSON fixture files, and mechanical comparisons of cross-language Unicode tables and Chinese-script patterns. The complete inventory below distinguishes source review from test/fixture contract review. This is a static audit, not a claim that the 202 discovered JUnit test methods passed.

Measured on-disk, UTF-8/source file bytes (not APK/AAB bytes):

- Entire module: **66 files, 527,278 bytes, 12,681 newline-delimited lines**.
- Android main sources plus manifest: **22 files, 175,411 bytes, 4,030 lines**. Main Java/Kotlin alone: 175,388 bytes.
- Android test sources/resources/runner: **33 files, 339,438 bytes, 8,291 lines**. These are development inputs, not production APK payload under the normal Android source-set layout.
- Four `src/*.ts` files: **6,728 bytes, 210 lines**; `index.ts` adds 197 bytes.
- `NaturalCaptionTranslator.java`: 91,717 bytes / 2,169 lines. It is the largest implementation, but line count does not prove dispensable behavior.
- `TranslationPreservation.java`: 24,691 bytes; its four Unicode-table declarations occupy 9,025 source bytes.
- The pinned model size is **1,597,931,520 bytes**, recorded in generated contracts and notices. That is a user-downloaded model, not a bundled asset found in this module. Changing quantization/model/prompt identity is not behavior-preserving compression.

**Unmeasured:** release APK/AAB/installed size, DEX count, shrinker output, AAR/JNI ABI payloads, runtime heap, model mmap residency, inference latency, startup time, and power use. No numerical savings in those categories are asserted. R8 may already eliminate unreferenced private methods, making the 489-byte source cleanup yield zero binary change.

### Smallest defensible changes, ordered

All line references in this section are relative to `modules/caption-translation/android/src/main/java/app/captionstudio/translation/`, unless a full repository path is given.

#### T1. SAFE REMOVE: unreferenced `invalidOutput()` factory

- Evidence: `NaturalCaptionTranslator.java:1763–1768` declares the private `invalidOutput()` method. Exact-symbol searches in `modules`, `src`, `tests`, `scripts`, and `.github` found no call or reflection reference.
- Smallest change: delete this method only. It constructs a `TranslationFailure(INVALID_OUTPUT, ...)` but is not on the current strict-parser path; that path returns rejected per-cue `Caption` objects through `diagnosticFallback` at 1652–1658.
- Measured removable method range: **217 bytes, 6 lines**. Do not count removal of `INVALID_OUTPUT` error-code vocabulary in this patch; public/type contracts are a separate concern.
- Risk: low. Verify compile and current response-contract tests. Do not replace the active parser fallback with exception throwing.

#### T2. SAFE REMOVE with test repair: unreferenced `emptyFallback()`

- Evidence: `NaturalCaptionTranslator.java:1677–1681` declares a private helper with no invocation. It returns empty invalid captions. The current equivalent failure path is `diagnosticFallback` at 1652–1658, which additionally preserves the bounded failure reason.
- Important test dependency: `tests/caption-translation-contract.test.mjs:277–296`, especially line 285, asserts that the text `emptyFallback` exists. This is a source-name assertion, not proof of a runtime call.
- Smallest change: delete the unused method and replace that one stale assertion with a check of the active boundary behavior (prefer executable malformed/duplicate/reordered-ID output tests). Preserve empty invalid text, original IDs/order, and the failure reason. Do not simply delete the safety assertion without replacement.
- Measured removable method range: **272 bytes, 5 lines**; net repository reduction depends on the replacement test.
- Tests: `NaturalCaptionTranslatorTest` methods at 145–234; `TranslationResponseContractTest:34–135`; response-failure diagnostics and JS source-fallback/partial-success tests.

#### T3. CONSOLIDATE: caption-to-transport-map serialization

- Evidence: `NaturalCaptionTranslator.java:477–485` and `1688–1696` independently produce the same ordered fields: `id`, `text`, `valid`, and `failureReason` only for invalid captions. The two ranges are **476 and 404 source bytes**, respectively; they are not both removable.
- Smallest change: one local `captionMap(Caption)` helper, called by both loops. A list helper is also possible but would be a larger initial change. Preserve separate list/map instances, `LinkedHashMap` field ordering, omission of `failureReason` on valid output, empty invalid text, and event/result caption order.
- Caller evidence: `src/services/caption-translation.ts:304–335` consumes accepted-event captions and failure reasons; 368–383 recovers native accepted batches on failure; 409–429 reconciles final results. Event and final serialization are two delivery routes, not redundant delivery mechanisms to remove.
- Tests: `TranslationCheckpointResumeTest` lost-event replay/terminal-error cases, `TranslationPreservationAcceptanceTest` accepted batches, JS `translation-partial-success.test.mjs`, `translation-single-session.test.mjs`, and cancellation-failure tests.
- Savings: positive maintenance consolidation likely; **net source/binary savings not measured** because no candidate implementation was produced.

#### T4. CONSOLIDATE: exact Unicode-whitespace predicate

- Evidence: `TranslationPromptData.java:34–38` (`whitespace`) and `TranslationPreservation.java:38–42` (`white`) have the same explicit code-point predicate, including U+0085, NBSP, Unicode spaces, and BOM. Their method ranges are **286 and 281 bytes**.
- Smallest change: a package-private common predicate in `TranslationText`, then call it from both consumers. Avoid introducing a new dependency or a static initialization cycle between PromptData and Preservation.
- Do not substitute `Character.isWhitespace`, `String.trim`, or a short regex: their character sets differ. The predicate participates in literal-marker scanning, URL/operator boundaries, and line-sensitive trimming.
- Tests: all prompt-marker, literal-boundary, preservation/counts/composition fixtures, especially BOM, Unicode whitespace, line edges, and standalone operators. Add explicit equality over the current predicate's edge code points if extracting it.
- Savings: about one predicate body before call-site/helper overhead; only the existing duplicated-byte ranges are measured.

#### T5. CONSOLIDATE / NEEDS EVIDENCE: legacy test-only splitter

- Evidence: `TranslationText.java:33–78` contains two `split` overloads and `safeBoundary` (**1,826 bytes, 46 lines**). All discovered calls are tests: `TranslationRuntimeReliabilityTest:66,79` and `TranslationLiteralBoundaryTest:77`. Production fragmentation calls `TranslationPreservation.split` from `NaturalCaptionTranslator.java:938`; the protected splitter is at `TranslationPreservation.java:302–342`.
- This is a genuinely unused production entry path, but the two algorithms are **not interchangeable**. The protected version uses pinned Unicode-17 extension tables and protected-span boundaries; the old version uses the runtime's `Character` categories and a skin-tone range.
- Smallest safe path: first migrate/add the three assertions against the real production splitter, demonstrate equivalent outcomes for their actual fixtures plus malformed Unicode/over-budget combining sequences, then delete the legacy overloads/private boundary helper. If the old algorithm is intentionally retained as a reference oracle, move it to test support rather than ship it in main sources.
- Do not delete the entire `TranslationText.java`: `wellFormed`, `bytes`, `escapedBytes`, and `FRAGMENT_BYTES` are active production dependencies.
- Savings: candidate 1,826 source bytes plus imports only after evidence; do not add it to the unconditional 489-byte total or assume R8 savings.

#### T6. KEEP / NOT RECOMMENDED: unused checkpoint batch-position parameter

- Evidence: `NaturalCaptionTranslator.java:972–990`, `checkpointBatchKey(ValidatedRequest request, int batchIndex)`, never reads `batchIndex`. The one production call is at 965. Tests at `TranslationCheckpointResumeTest:184–209` intentionally assert batch-position independence, and `TranslationPromptSerializationTest:141` uses the signature.
- Do not prioritize a signature-only change for compression. If separately changed, remove only the unused parameter and adjust package-private callers; keep an end-to-end moved-batch/context identity test rather than erasing that regression case.
- Preserve the exact serialized identity and resulting digest. Do not add batch index, transport ID, or backend to the checkpoint key while simplifying. The identity's stable CPU-labelled profile is explicitly intentional at lines 60–62.
- Very small source/API simplification; no demonstrated runtime or package reduction.

#### T7. KEEP / NOT RECOMMENDED: duplicate-detection maps used only as sets

- Evidence: `NaturalCaptionTranslator.java:1338–1339,1351,1388,1430,1441`. `operationIds`, `sessionIds`, and `ids` map strings to `Boolean.TRUE`; no values/order are consumed.
- No standalone compression change recommended. A separate readability refactor could replace only these local maps with sets and `!add`, while retaining all map-based output ordering elsewhere. This is readability/type-intent cleanup, not an established source-size win after adding imports. Preserve duplicate rejection order and exact error messages.
- Tests: batch/session duplicate IDs, operation IDs, invalid requests, and exact ordered output tests. Low priority compared with T1–T4.

#### T8. CONSOLIDATE (DEVONLY): divergent native test runners

- Evidence: module `android/src/test/run-focused.ps1:7–45` repeats cached dependency resolution, AAR extraction, Kotlin/Java compilation, and JUnit dispatch in `tests/translation-native.ps1:11–50`.
- Both enumerate **all** `*.java` test files and run every corresponding class (module lines 39–43; root lines 45–49). That includes `SerializationTestReceipt.java`, a CLI helper with no `@Test` methods.
- Both classpaths omit the test resources folder and Mockito/ByteBuddy runtime dependencies. Current `TranslationSdkTypedStatusRegressionTest.java:4–5,13–33` imports/uses Mockito; prompt/preservation suites load JSON via `getResourceAsStream`. These are concrete static incompatibilities, not an observed execution failure from this audit.
- `tests/translation-preservation-cloud.py:32–35,55–67` already includes Mockito/ByteBuddy, resource classpath, `*Test.java` selection, and explicit Java agent. It also does broad installation/download/build work and writes repository outputs, so it is **not** a drop-in read-only runner or a script to invoke casually.
- Smallest change: establish one canonical native-test invocation and make the other entry points thin wrappers, retaining supported platforms, memory constraints, JDK21/Java17, resource paths, pinned SDK, and safe scratch cleanup. The module wrapper is **3,891 bytes** today; do not claim all are removable before designing the wrapper.
- No APK/runtime savings. This is the strongest developer-maintenance consolidation candidate, and should be validated before relying on either PowerShell script for future change verification.

#### T9. KEEP / NOT RECOMMENDED: two Gradle dependency blocks

- Evidence: `android/build.gradle:22–25` and `50–53` both declare dependencies.
- They can be merged without changing configurations/versions. Keep the `translationMockitoAgent` configuration (`43–48`) and Java-agent setup (`55–62`), plus the JDK/output verification task (`64–84`). The size win is just wrapper syntax/blank lines; not worth an independent refactor.

### KEEP: behavior and security boundaries that resemble duplication

1. **Native ownership and terminal delivery.** `CaptionTranslationModule.kt:40–69,72–94` locks translator creation/release, exposes accepted-batch replay, and closes on destruction. `NaturalCaptionTranslator.java:140–291,518–546,1197–1320` preserves BUSY ownership, cleanup poisoning, cancellation/failure precedence, exactly-once callbacks, and retained accepted batches. Keep these distinct states and locks. Do not replace cancellation with an early promise resolution or indiscriminate future cancellation.
2. **SDK asynchronous callback bridge.** `LiteRtLmTranslationRuntime.kt:93–205,207–251` plus `TranslationMessageBridge.java:14–98` wait for actual terminal callback and in-flight stop-signal completion before cleanup. `awaitTerminal`'s 25ms wait is a lock-contention retry interval, not a generation timeout. Replacing this with synchronous SDK `sendMessage`, a timeout, or merely polling a cancel flag can lose typed SDK cancellation and release native resources too early. The 17 adapter tests and Mockito regression are purposeful coverage, not surplus scaffolding.
3. **SDK gateway and compatibility overloads.** `TranslationSdkGateway.java`, `TranslationRuntime.java:7–41`, `TranslationRuntimeFactory.java`, and backend wrapper forwarding at `TranslationBackendSelection.java:63–81` support testing the production adapter, schemas, token caps, diagnostics and cleanup. Existing tests explicitly require default-overload behavior. Removing overloads just because the main orchestrator uses the longest signature changes the tested contract.
4. **Backend selection.** `TranslationBackendSelection.java:20–42,44–87` defaults to CPU, supports auto/GPU initialization fallback, never switches backend during generation, and aborts fallback on cleanup/cancellation/interruption. CPU/GPU preferences are exposed to JS benchmark callers (`src/services/caption-translation.ts:728–745`). GPU and AUTO currently share much of the initialization path; their externally supplied identifiers still have contract meaning.
5. **Strict parser is not redundant with response schema.** `TranslationResponseSchema.java:16–48` constrains generation; `NaturalCaptionTranslator.java:1545–1664` independently rejects invalid schema, duplicate/missing/unknown/reordered IDs, non-string/extra fields, trailing JSON, control characters, malformed Unicode, and excessive output. The generated schema does not alone enforce exact ID order/uniqueness or source correspondence. Keep post-generation validation, including restored checkpoints and retries.
6. **Prompt data is untrusted data.** Keep `TranslationPromptData.escape:9–13`, chat-marker inventory/scanning at 22–54, and `NaturalCaptionTranslator.escapePrompt:1142–1146`, prompt composition at 1013–1078 and 1526–1542. Serialization then selective escaping prevents marker injection while preserving literal user `\\u` strings and ordinary comparison/HTML text. Do not shorten by concatenating JSON or using blanket angle-bracket replacement; that also changes byte budgets/checkpoint identity.
7. **Preservation and quality are different checks.** `TranslationPreservation.java:203–269` checks source-directed exact literals, line topology, integers and invariant composition; `TranslationOutputQuality.java:32–69` checks correspondence, source echo and target script in prose. Parser checks, per-fragment acceptance and final joined-cue checks (`NaturalCaptionTranslator.java:1955–1959`) guard different transformations. JS checks protect persistence/commit after crossing the native boundary. Removing one layer needs specific equivalence proof.
8. **Pinned Unicode/script policy.** The four Java tables at `TranslationPreservation.java:15–18` exactly match their TS counterparts at `src/lib/translation-preservation.ts:9–12`: 312 PICTOGRAPHIC, 162 PRESENTATION, 668 EXTENSIONS, and 77 DIGIT_ZEROES integers. All arrays were mechanically compared and sorted. Java Chinese-script patterns at `TranslationOutputQuality.java:20–21` exactly match `src/lib/caption-languages.ts:149–150` (352 traditional-only and 350 simplified-only characters). Replacing with platform Unicode APIs changes behavior across Android/runtime versions. A shared generator could consolidate maintenance, not remove both shipped representations.
9. **Model verification and device capacity.** Keep `OfficialQwenModelVerifier.java:20–79` size/SHA256/cancellation/progress and cached verification identity; `AndroidTranslationEnvironment.java:35–65,75–94` stable 64-bit/4GiB/low-RAM checks and bounded inference threads. `resolveModelFile` (`NaturalCaptionTranslator.java:1474–1524`) rejects ambiguous/nonlocal/unreadable model paths. Avoid replacing with permissive URI access or trusting filename alone.
10. **Private durable checkpoint policy.** `AndroidTranslationEnvironment.java:68–72` uses no-backup storage; `TranslationCheckpointStore.java:38–44,57–74,77–159` provides canonical owned paths, key validation even when reads are disabled, size/entry/retention bounds, content digest, sync/staging/atomic replacement, and restricted pruning. The Android-pre-O atomic rename compatibility branch at 102–129 is NEEDS EVIDENCE before removal; this audit did not establish release minimum API/runtime reachability. Keep refresh-write/resume-read distinction and benchmark's complete bypass (`NaturalCaptionTranslator.java:1161–1189`).
11. **Generated release identity.** Keep `GeneratedProductContract.java`, `TranslationReleaseContract.generated.ts`, and their exact data. `scripts/generate-product-contract.mjs:6–22` generates both from `config/product-contract.json` and can check exact content. Deduplicating generated outputs by hand breaks the generator/check contract; changes belong in the source contract/generator.
12. **Content-free diagnostics and metrics.** `TranslationBatchMetrics.java:28–74`, diagnostics at `NaturalCaptionTranslator.java:763–879`, and runtime snapshot at `LiteRtLmTranslationRuntime.kt:300–345` intentionally retain counters/allowlisted bounded numeric data rather than prompts/paths/errors. Metrics also supply bounded evidence for truncation recovery (`NaturalCaptionTranslator.java:696–715`). They cannot all be removed as logging without altering retry behavior and benchmark contracts.
13. **Web/module boundary.** Keep `expo-module.config.json`, `index.ts`, the TS declarations and web module registration; platform unsupported behavior is deliberate. One observed contract mismatch deserves separate functional follow-up: the native declaration exposes `isLocalTranslationSupported`, service line 141 calls it, but the web implementation lacks that method. Fixing it would be a behavior change, not a compression item; do not claim the web stub can be removed because translation is Android-only.
14. **Licenses and test fixtures.** Keep the MIT notice, third-party model/SDK notices, all fixture provenance, and focused regressions. Test-only data contributes no normal release-runtime savings. Several tiny files isolate past contract failures (counts, Urdu removal, typed status); merging files just to reduce file count does not reduce the required assertions.

### Native dependency disposition

Categories below are dependency decisions; they are distinct from source-edit classifications above.

| Dependency / surface | Disposition | Evidence and requirements |
| --- | --- | --- |
| `com.google.ai.edge.litertlm:litertlm-android:0.16.1` | **KEEP; NEEDS MEASUREMENT** for packaged size | Only runtime implementation; `android/build.gradle:23`; engine/config/conversation/response/benchmark APIs in `LiteRtLmTranslationRuntime.kt`. Replacing with another SDK/model is not behavior preserving. Measure release AAR/JNI/ABI contribution before proposing payload changes. |
| Gson 2.13.2, recorded SDK transitive runtime dependency | **KEEP** | Direct use in main source (`NaturalCaptionTranslator`, `TranslationResponseSchema`) includes `Strictness.STRICT`, streaming duplicate-field handling, and JSON serialization. Removing/excluding because it is transitive breaks code. A JSON-library replacement needs exact malformed-output/serialization parity and has no demonstrated savings. |
| Kotlin standard library / reflection runtime from toolchain/SDK | **KEEP; NEEDS MEASUREMENT** before exclusions | Kotlin runtime and Expo/SDK types are active. Reflection 2.2.21 is recorded in `THIRD_PARTY_NOTICES.md:9–13`; this audit did not resolve the release graph or inspect an AAR, so direct-vs-transitive presence and shrinkability must be verified. Do not infer unused reflection from absence of app reflection calls. |
| Kotlin coroutines Android runtime (notice records 1.9.0) | **KEEP; NEEDS MEASUREMENT** | SDK async API implementation may depend on it. Notice is evidence of declared upstream dependency, not the resolved application version. No proof that exclusion preserves dispatch/cancellation. |
| `junit:junit:4.13.2` | **DEVONLY; KEEP** | `testImplementation`, build line 24, 202 test methods. Do not delete tests for APK savings. |
| `org.mockito:mockito-core:5.14.2` | **DEVONLY; KEEP** | `testImplementation`, build line 51; production-adapter typed-cancellation regression mocks actual SDK Engine/Conversation. Replacing with gateway-only doubles would weaken that regression. |
| `net.bytebuddy:byte-buddy-agent:1.15.4` custom configuration | **DEVONLY; KEEP** | Build lines 43–60 explicitly attach agent for test execution under JDK21. ByteBuddy/Objenesis used by test mocking are not established production dependencies. |
| JDK21 compiler/test launcher with Java/Kotlin17 output | **KEEP** | Build lines 28–40,55–84 documents pinned SDK Java21 classes while preserving module target17. This is a compatibility requirement, not accidental duplicate toolchains. |
| Expo native-module Gradle plugin / Expo peer dependency | **KEEP** | Expo `ModuleDefinition`, NativeModule registration, autolinking and public methods depend on them. Wildcard peer declaration is module integration metadata, not proof of multiple Expo installs. |
| `consumer-rules.pro`: `-keep class com.google.ai.edge.litertlm.** { *; }` | **NEEDS MEASUREMENT**, potential future narrowing | Entire file (50 bytes). Broad keep may inhibit shrinking Java SDK code, but JNI/reflection/schema/benchmark paths must be audited in the exact pinned AAR and minified release tested on device. No rule can safely be deleted from current source-only evidence. Narrowing rules does not imply native `.so` removal. |
| Qwen2.5 1.5B Q8 model | **KEEP** | Downloaded release contract, exact size/hash/revision. Model substitution/quantization changes quality, tokenization, verifier/checkpoint identity and memory behavior. No bundled-model removal opportunity found. |
| Standalone PowerShell native-test dependency loaders | **CONSOLIDATE; DEVONLY** | T8. Unify classpath/version/resource/agent/test-selection behavior first; do not choose a known-incomplete runner as the canonical one. |
| New dependency to replace local hashing/Unicode/schema helpers | **Do not REPLACE on present evidence** | Small utilities are active; a new library could increase bundle size and change Android or Unicode compatibility. No dependency is confidently classified REMOVE. |

### Verification required before accepting any implementation

1. Re-run product-contract exact-generation check and keep JS/native output limits/language enumeration in parity. No generated artifact editing by hand.
2. Compile actual module against pinned LiteRT-LM 0.16.1 with JDK21/compiler and Java/Kotlin17 output. Fix/unify runner wiring before treating a missing-dependency failure as an implementation failure.
3. Run all 202 discovered JUnit methods via `*Test.java` class selection with JSON resources and Mockito agent; do not run the `SerializationTestReceipt` CLI helper as a JUnit test class. Keep its explicit receipt invocation if the historical red/green workflow remains supported.
4. Run JS translation contract/parity/limits/prompt/preservation/cancellation/partial-success/single-session/refresh tests. If deleting `emptyFallback`, replace its source-name assertion while preserving executable empty-reject coverage.
5. For serializer changes, compare accepted-event, replay and final maps byte-for-byte in field presence/order and caption order, including invalid failure reasons and valid absent failureReason; cover lost event followed by recovery and cancellation after accepted batches.
6. For whitespace or splitter changes, cover all 115 preservation rows, 104 protected-composition rows, 22 known tokenizer markers, 5 unknown prefixes and 12 ordinary literals, malformed UTF-16, supplementary characters, combining/ZWJ/flags/keycaps, CRLF and explicit line topology, over-budget opaque literals and prompt-byte budget.
7. For lifecycle/shrinker/SDK dependency changes, add minified **release** device checks: initialization failure GPU→CPU, cancellation before/during dispatch/generation/cleanup, late callbacks, stop failure, response overflow, cleanup poisoning, terminal exactly once, process death/checkpoint resume, and successful post-cancel reuse. JVM fake tests alone do not establish JNI shrinker safety.
8. Only then measure identical-configuration baseline/candidate APK/AAB and split sizes, DEX/JNI contributions, installed bytes, cold/warm timings and memory. Report source-size reductions separately; never aggregate developer test/fixture deletions into release savings.

### Full inventory and review coverage

The following covers all 66 files found under the module. `KEEP` is the default unless an explicit T-item above applies. Main source files were reviewed for production call paths and contract/lifecycle requirements. Tests were reviewed for declared contract coverage, dependencies, fixtures, helper patterns and relevant assertions; no execution is claimed. Resource data was fully parsed, schemas and scenario inventory checked, and cross-language table equality was mechanically verified.

#### `LICENSE`

- Size: 1,094 bytes; 21 lines.
- Review: KEEP: MIT notice.

#### `THIRD_PARTY_NOTICES.md`

- Size: 1,309 bytes; 23 lines.
- Review: KEEP: SDK/model provenance and licenses; not a resolved dependency graph.

#### `android/build.gradle`

- Size: 2,660 bytes; 84 lines.
- Review: KEEP: pinned SDK/toolchains/test setup; T9 block merge is not recommended.

#### `android/consumer-rules.pro`

- Size: 50 bytes; 1 lines.
- Review: NEEDS MEASUREMENT: broad SDK keep rule, no safe removal proved.

#### `android/src/main/AndroidManifest.xml`

- Size: 23 bytes; 2 lines.
- Review: KEEP: empty library manifest; no permission/component to prune.

#### `android/src/main/java/app/captionstudio/translation/AndroidTranslationEnvironment.java`

- Size: 3,836 bytes; 103 lines.
- Review: KEEP: Android capability/thread policy, private cache and no-backup checkpoint directory.

#### `android/src/main/java/app/captionstudio/translation/CaptionTranslationModule.kt`

- Size: 3,371 bytes; 96 lines.
- Review: KEEP: Expo bridge, events, limits, module lifecycle and accepted-batch recovery.

#### `android/src/main/java/app/captionstudio/translation/GeneratedProductContract.java`

- Size: 393 bytes; 10 lines.
- Review: KEEP: generated model size/hash/id/prompt contract; generator-owned.

#### `android/src/main/java/app/captionstudio/translation/LiteRtLmTranslationRuntime.kt`

- Size: 12,926 bytes; 352 lines.
- Review: KEEP: actual SDK adapter, initialization, generation locks, cancellation, cleanup, diagnostics.

#### `android/src/main/java/app/captionstudio/translation/NaturalCaptionTranslator.java`

- Size: 91,717 bytes; 2,169 lines.
- Review: KEEP orchestration/security; T1–T3 are scoped reductions; T6–T7 are not recommended cosmetic changes.

#### `android/src/main/java/app/captionstudio/translation/OfficialQwenModelVerifier.java`

- Size: 3,910 bytes; 113 lines.
- Review: KEEP: exact model integrity, readable file, cancellation and verification cache.

#### `android/src/main/java/app/captionstudio/translation/TranslationBackendSelection.java`

- Size: 3,916 bytes; 91 lines.
- Review: KEEP: strict backend preferences, cleanup-before-fallback, wrapper forwarding.

#### `android/src/main/java/app/captionstudio/translation/TranslationBatchMetrics.java`

- Size: 3,096 bytes; 81 lines.
- Review: KEEP: content-free counters, schema/token forwarding, failures and timings.

#### `android/src/main/java/app/captionstudio/translation/TranslationCheckpointStore.java`

- Size: 6,367 bytes; 169 lines.
- Review: KEEP: bounded private durable checksum-validated storage and atomic replacement.

#### `android/src/main/java/app/captionstudio/translation/TranslationEnvironment.java`

- Size: 450 bytes; 17 lines.
- Review: KEEP: environment seam with explicit checkpoint/thread defaults.

#### `android/src/main/java/app/captionstudio/translation/TranslationMessageBridge.java`

- Size: 3,432 bytes; 99 lines.
- Review: KEEP: bounded chunk collection, terminal ownership, typed failure precedence.

#### `android/src/main/java/app/captionstudio/translation/TranslationModelVerifier.java`

- Size: 332 bytes; 13 lines.
- Review: KEEP: verification seam enabling isolation and cancellation/progress callbacks.

#### `android/src/main/java/app/captionstudio/translation/TranslationOutputQuality.java`

- Size: 7,182 bytes; 93 lines.
- Review: KEEP: target script, source echo, correspondence and protected composition.

#### `android/src/main/java/app/captionstudio/translation/TranslationPreservation.java`

- Size: 24,691 bytes; 344 lines.
- Review: KEEP: Unicode/preservation/split policy; T4 shares only identical whitespace predicate.

#### `android/src/main/java/app/captionstudio/translation/TranslationPromptData.java`

- Size: 1,843 bytes; 55 lines.
- Review: KEEP: marker escaping/inventory; T4 shares only identical whitespace predicate.

#### `android/src/main/java/app/captionstudio/translation/TranslationResponseSchema.java`

- Size: 1,906 bytes; 52 lines.
- Review: KEEP: validated ID enum/count and strict object field generation schema.

#### `android/src/main/java/app/captionstudio/translation/TranslationRuntime.java`

- Size: 1,575 bytes; 42 lines.
- Review: KEEP: runtime interface/default overload compatibility.

#### `android/src/main/java/app/captionstudio/translation/TranslationRuntimeCleanupException.java`

- Size: 264 bytes; 9 lines.
- Review: KEEP: cleanup failure identity changes runtime reuse/fallback behavior.

#### `android/src/main/java/app/captionstudio/translation/TranslationRuntimeFactory.java`

- Size: 593 bytes; 20 lines.
- Review: KEEP: injectable factory with backend/cancellation compatibility.

#### `android/src/main/java/app/captionstudio/translation/TranslationSdkGateway.java`

- Size: 711 bytes; 21 lines.
- Review: KEEP: SDK engine/session seam used by real production adapter and lifecycle tests.

#### `android/src/main/java/app/captionstudio/translation/TranslationText.java`

- Size: 2,877 bytes; 79 lines.
- Review: KEEP active utilities; T5 legacy split entry paths need test migration evidence.

#### `android/src/test/java/app/captionstudio/translation/AndroidTranslationEnvironmentTest.java`

- Size: 1,722 bytes; 35 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 3. Contract inventory:
  - Line 12: `admitsCapableHardwareRegardlessOfTransientAvailableMemory`
  - Line 18: `rejectsOnlyPermanentHardwareConstraints`
  - Line 26: `selectsInferenceThreadsFromStableDeviceCapacity`

#### `android/src/test/java/app/captionstudio/translation/NaturalCaptionTranslatorTest.java`

- Size: 28,615 bytes; 715 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 19. Contract inventory:
  - Line 32: `validatesEnglishToSimplifiedChineseBatch`
  - Line 43: `validatesTraditionalChineseToEnglishBatch`
  - Line 52: `acceptsMultilingualDirectionsAndRejectsInvalidRequests`
  - Line 75: `rejectsOversizedCaptionAndContextInput`
  - Line 108: `countsUnicodeCodePointsInsteadOfUtf16Units`
  - Line 129: `promptTreatsCaptionTextAsEscapedJsonData`
  - Line 144: `acceptsOnlyExactOrderedIdTextOutput`
  - Line 160: `incompleteOrDuplicateRepliesRejectTheEntireBatchWithoutSourceFallback`
  - Line 184: `multiCueBleedIsRejectedPerCueWithoutPersistingSourceText`
  - Line 201: `singleCaptionRetryAcceptsOnlyExactIdJson`
  - Line 235: `individualRepairRequiresTheOnlyRequestedCueId`
  - Line 281: `acceptsReadableAbsolutePathAndFileUriOnly`
  - Line 307: `cancellationAndCleanupNeverOverlapNativeLifecycle`
  - Line 329: `busyRequestFailsWithoutDisturbingActiveTranslation`
  - Line 355: `mixedDirectionOperationsShareOneEngineSession`
  - Line 395: `closingQueuedRunSettlesPromiseExactlyOnce`
  - Line 425: `cleanupFailurePoisonsRuntimeAndBlocksReuse`
  - Line 455: `officialVerifierRejectsWrongModelIdentityBeforeInference`
  - Line 469: `loadingModelOnlyReportsUnsupportedForLinkageFailures`

#### `android/src/test/java/app/captionstudio/translation/OfficialQwenModelVerifierTest.java`

- Size: 779 bytes; 20 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 1. Contract inventory:
  - Line 10: `unreadableExpectedSizeModelIsNotClassifiedAsInvalidTranslationRequest`

#### `android/src/test/java/app/captionstudio/translation/SerializationTestReceipt.java`

- Size: 1,633 bytes; 31 lines.
- Review: DEVONLY/KEEP: explicit serialization red/green CLI receipt helper; not a JUnit test class.

#### `android/src/test/java/app/captionstudio/translation/TranslationBackendDiagnosticsForwardingTest.java`

- Size: 3,275 bytes; 67 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 1. Contract inventory:
  - Line 9: `everyBackendWrapperForwardsCurrentDiagnosticsIncludingFailedGeneration`

#### `android/src/test/java/app/captionstudio/translation/TranslationBackendSelectionTest.java`

- Size: 7,524 bytes; 158 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 10. Contract inventory:
  - Line 37: `preferenceIsStrictAndDefaultsToCpu`
  - Line 49: `cpuOverrideNeverCreatesGpu`
  - Line 62: `autoAndGpuReportGpuAndNeverRetryGenerationOnCpu`
  - Line 75: `gpuInitializationCleansUpBeforeCpuFallback`
  - Line 91: `cleanupFailureBlocksFallbackAndSanitizesNativeDetails`
  - Line 105: `cancellationInterruptionAndFatalMemoryFailureNeverFallback`
  - Line 118: `cancellationAfterInitializationClosesWithoutFallback`
  - Line 130: `cancelledBeforeOpenAllocatesNothing`
  - Line 135: `bothInitializationFailuresAreClosedAndTerminal`
  - Line 146: `cancellationDuringFailedInitializationPreventsCpuAllocation`

#### `android/src/test/java/app/captionstudio/translation/TranslationBatchMetricsTest.java`

- Size: 17,590 bytes; 339 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 12. Contract inventory:
  - Line 29: `metricsContainOnlyApprovedCountersAndSafeEnums`
  - Line 50: `failedAndCancelledGenerationRemainObservableWithoutExceptionText`
  - Line 63: `actualBackendAndMetricsReachResultWithoutChangingCaptionContract`
  - Line 85: `identityReportsNoBackendOrGeneration`
  - Line 98: `nativeRequestPassesCpuOverrideAndRejectsInvalidPreference`
  - Line 119: `rejectedOutputRepairIsCountedWithoutAlteringAcceptedText`
  - Line 136: `rejectedStructuredCueUsesConstrainedRepair`
  - Line 160: `groupedGenerationUsesStructuredOutputWithoutFifteenSingletonRepairs`
  - Line 205: `generationFailureClosesRuntimeAndNeverReopens`
  - Line 220: `benchmarkBypassesCpuCheckpointsWithoutOverwritingNormalResume`
  - Line 257: `benchmarkNeverPreparesCheckpointStorageAndRejectsNonBooleanFlag`
  - Line 273: `initializationFallbackReportsCpuInBothResultAndBatchMetrics`

#### `android/src/test/java/app/captionstudio/translation/TranslationCancellationFailureTest.java`

- Size: 14,305 bytes; 332 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 13. Contract inventory:
  - Line 20: `successfulNativeReturnAfterCancelIsCancelledAndRetryWorks`
  - Line 32: `actualCancellationExceptionRemainsCancelled`
  - Line 36: `actualInterruptedExceptionRemainsCancelled`
  - Line 40: `inferenceFailureWinsConcurrentCancel`
  - Line 44: `storageFailureWinsConcurrentCancel`
  - Line 58: `loadingFailureWinsConcurrentCancelAndOwnerStaysBusy`
  - Line 71: `outOfMemoryWinsConcurrentCancel`
  - Line 75: `linkageFailureWinsConcurrentCancel`
  - Line 79: `genuineFailureWinsThreadInterruptWithoutCancelRequest`
  - Line 89: `cancellationDuringCleanupCannotReplaceAlreadyCaughtFailure`
  - Line 105: `stopSignalFailureWinsCancellationAndIsDeliveredOnceAfterExit`
  - Line 125: `cleanupFailureWinsInferenceAndCancelPoisonsReuse`
  - Line 130: `cleanupFailureWinsActualCancellationAndPoisonsReuse`

#### `android/src/test/java/app/captionstudio/translation/TranslationCheckpointPolicyTest.java`

- Size: 2,392 bytes; 55 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 4. Contract inventory:
  - Line 24: `refreshDoesNotReadOldTextButDurablyReplacesIt`
  - Line 36: `refreshFailureKeepsPreviouslyAcceptedCheckpoint`
  - Line 46: `disabledReadsDoNotWeakenPrivatePathValidation`
  - Line 52: `unavailableTelemetryDoesNotReduceEstablishedRetryAllowance`

#### `android/src/test/java/app/captionstudio/translation/TranslationCheckpointResumeTest.java`

- Size: 12,367 bytes; 253 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 5. Contract inventory:
  - Line 25: `cancelledSessionResumesAfterWorkerRecreationWithoutRegeneratingCompletedBatch`
  - Line 73: `nextBatchProceedsWithoutAcknowledgementAndCancellationKeepsCheckpoint`
  - Line 114: `lostBatchEventAndSameRequestReplayFinishWithoutAcknowledgement`
  - Line 137: `terminalErrorRetainsEarlierAcceptedBatch`
  - Line 184: `checkpointIdentityIncludesBoundedContextOrderedNeighborsWithoutBatchPosition`

#### `android/src/test/java/app/captionstudio/translation/TranslationCheckpointStoreTest.java`

- Size: 2,456 bytes; 52 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 3. Contract inventory:
  - Line 16: `completeCheckpointSurvivesNewInstanceAndRejectsCorruption`
  - Line 30: `incompleteWritesDoNotReplaceLastCompleteCheckpoint`
  - Line 41: `pruningIsBoundedAndNeverTouchesUnownedFiles`

#### `android/src/test/java/app/captionstudio/translation/TranslationFailureDiagnosticsTest.java`

- Size: 10,566 bytes; 189 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 5. Contract inventory:
  - Line 26: `classifiesStructuralAndTextFailuresWithoutLeakingPayloads`
  - Line 61: `preservesInitialSingletonAndRepairFailuresInOrder`
  - Line 82: `generationFailureIsLoggedWithoutExceptionDetails`
  - Line 92: `runtimeMetricsUseOnlyFiniteNonnegativeAllowlistedNumbers`
  - Line 117: `brokenDiagnosticSinkCannotChangeTranslationOutcome`

#### `android/src/test/java/app/captionstudio/translation/TranslationGenerationDiagnosticsTest.java`

- Size: 5,339 bytes; 106 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 4. Contract inventory:
  - Line 10: `optionalApiKeepsExistingRuntimesCompatible`
  - Line 19: `observedCountsAndTimingsAreReportedWithoutInventingEos`
  - Line 37: `unavailableInvalidOrPartialMetricsKeepTerminationUnknown`
  - Line 59: `diagnosticStateIsSafeBeforeGenerationAndClearsPreviousSnapshot`

#### `android/src/test/java/app/captionstudio/translation/TranslationLiteralBoundaryTest.java`

- Size: 7,487 bytes; 150 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 7. Contract inventory:
  - Line 26: `sourceChatMarkersRemainLiteralInInitialAndRetryResponses`
  - Line 51: `markersCannotBeIntroducedReplacedDuplicatedOrDropped`
  - Line 66: `literalMarkersAreNotBrokenByProtectedFragmentSplitting`
  - Line 75: `ordinaryComparisonBytesDoNotCauseExtraFragments`
  - Line 81: `ordinaryContextUsesItsActualSerializedByteBudget`
  - Line 89: `acceptedCodeMarkerRestoresAfterWorkerRecreationWithoutInference`
  - Line 93: `codeMarkerRepairAndCheckpointRestoreUseTheSameAcceptancePolicy`

#### `android/src/test/java/app/captionstudio/translation/TranslationPolicyRegressionTest.java`

- Size: 13,179 bytes; 228 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 9. Contract inventory:
  - Line 24: `refreshWritesReplacementThatResumeReadsWithoutGeneration`
  - Line 36: `distantTransportChangesAndMovedBatchReuseActualCueContext`
  - Line 56: `changedImmediateNeighborInvalidatesCue`
  - Line 65: `fragmentCheckpointsIgnoreTransportIdLength`
  - Line 77: `oversizedNeighborsSurviveInitialAndRepairWithinConservativeCapacity`
  - Line 96: `sameScriptAndArabicRetryCarryExactDirectionAndReadOnlyNeighbors`
  - Line 118: `outputCapExpandsOnlyWithNumericEvidenceAndWithinCapacity`
  - Line 131: `benchmarkNeitherReadsNorReplacesNormalCheckpoint`
  - Line 142: `preciseParserReasonsReachRepairAndMalformedSubtypeIsPrivate`

#### `android/src/test/java/app/captionstudio/translation/TranslationPreservationAcceptanceTest.java`

- Size: 26,484 bytes; 504 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 20. Contract inventory:
  - Line 25: `lostProtectedContentCannotPassQualityAcceptance`
  - Line 41: `legitimateLocaleChangesAndAcknowledgementsRemainAccepted`
  - Line 55: `failedProtectedFragmentIsNotAcceptedOrDurablyRestored`
  - Line 71: `corruptedOldCheckpointMustBeRevalidatedAgainstSource`
  - Line 88: `failedRepairCannotBecomeAcceptedBatchOrCheckpoint`
  - Line 100: `successfulPreservationRepairIsCachedAndNeverRegeneratesAcceptedText`
  - Line 113: `edgeAndInteriorLineBreaksSurviveFreshAndRestoredCheckpointOutput`
  - Line 126: `shortDecomposedCodeAndUrlSurviveRuntimeAndCheckpointWithoutNfcMutation`
  - Line 137: `oversizedOpaqueLiteralBypassesInferenceAndSurvivesChineseFragmentJoining`
  - Line 149: `laterTerminalFailureKeepsEarlierAcceptedProtectedBatchDurable`
  - Line 216: `protectedTargetScriptDecoysAreRejectedIndependently`
  - Line 233: `protectedDataNeitherContaminatesNorSuppliesProseScript`
  - Line 252: `translatedProseWithProtectedScriptSurvivesRuntimeAndReplay`
  - Line 267: `protectedTargetScriptDecoyCannotBeAcceptedByRuntime`
  - Line 275: `sharedProtectedCompositionQualityParity`
  - Line 294: `samsungCompositionBypassesGenerationAndReplaysAcceptedBatch`
  - Line 309: `literalCompositionBypassesGenerationForEveryTarget`
  - Line 320: `ordinaryProseWithLiteralsStillGeneratesAndRejectsEcho`
  - Line 330: `cancellationAfterInvariantBatchRetainsReplayAndResumeStillTranslatesProse`
  - Line 417: `numericAndSymbolCompositionsBypassGenerationAndReplayForEveryTarget`

#### `android/src/test/java/app/captionstudio/translation/TranslationPreservationContractTest.java`

- Size: 8,800 bytes; 151 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 8. Contract inventory:
  - Line 12: `sharedNativeJsPreservationCorpus`
  - Line 25: `sourcePartitionNeverSplitsProtectedLiteralsOrEmojiClusters`
  - Line 38: `integerFormsAreAcceptedWithoutTargetScriptFalsePositive`
  - Line 47: `lineBreaksSurviveStrictParserBeforeQualityAndCheckpointAcceptance`
  - Line 56: `seekerStandaloneOperatorQualityAndLexicalBoundaries`
  - Line 70: `seekerRuntimeRejectsDroppedOperatorAndGeneratesTranslatedProse`
  - Line 132: `unspacedChineseOperatorMustPassNativePreservationAndQuality`
  - Line 147: `unspacedChineseOperatorMustPassNativeQualityIndependently`

#### `android/src/test/java/app/captionstudio/translation/TranslationPreservationCountsTest.java`

- Size: 1,412 bytes; 26 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 6. Contract inventory:
  - Line 7: `addedCopyOfSourceEmojiIsRejected`
  - Line 10: `repeatedSourceEmojiCannotGainAnotherCopy`
  - Line 13: `sourceUrlCannotGainAnotherCopy`
  - Line 16: `sourceCodeCannotGainAnotherCopy`
  - Line 19: `duplicatedEmojiCannotPassNativeQualityAcceptance`
  - Line 22: `equalRepeatedCountsStillPass`

#### `android/src/test/java/app/captionstudio/translation/TranslationProductionRecoveryTest.java`

- Size: 6,511 bytes; 126 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 3. Contract inventory:
  - Line 23: `malformedEightCueBatchHasOnlyOneRecoveryPerCueThroughProductionWrapper`
  - Line 40: `mixedFailuresPreserveAcceptedCuesAndSourceNeighbors`
  - Line 51: `unsupportedRuntimeCannotSilentlyDropRequiredStructuredOutput`

#### `android/src/test/java/app/captionstudio/translation/TranslationPromptSerializationTest.java`

- Size: 8,337 bytes; 145 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 8. Contract inventory:
  - Line 45: `ordinaryOperatorsAndHtmlStayLiteralAndRoundTrip`
  - Line 57: `everyPinnedAddedTokenBlockedAcrossAllDataAndFeedbackFields`
  - Line 70: `futureUnknownAndUnclosedChatPrefixesBlockedAndRoundTrip`
  - Line 78: `initialRetryAndNeighborReSerializationPreserveLiteralOperators`
  - Line 95: `retryNeighborsAndReparseNeverExposeTokenizerMarkers`
  - Line 109: `literalUserBackslashUHasNoDoubleInterpretation`
  - Line 121: `selectiveEscapeIsIdempotentOnSerializedJson`
  - Line 129: `oldBlanketEscapeCheckpointIdentityCannotBeReused`

#### `android/src/test/java/app/captionstudio/translation/TranslationRepairTest.java`

- Size: 26,352 bytes; 458 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 14. Contract inventory:
  - Line 24: `translatesIsolatedCuesInOneEngineAndRestoresWithoutReloading`
  - Line 66: `absentOkResponseIsNotAcceptedOrResurrectedByCheckpoint`
  - Line 84: `qualityAllowsNativeAcknowledgementsButRejectsEnglishEchoes`
  - Line 98: `qualityRejectsMultiCueBleedEvenWhenUnderFormerAbsoluteCap`
  - Line 107: `qualityKeepsTraditionalTaiAndRejectsBorrowedOkForLongerCues`
  - Line 115: `changedContextOrNeighborRegeneratesButRenamedIdsRestoreDistinctPositions`
  - Line 156: `directSingleCueRecoveryAndOptionalRetryKeepNeighborContextAndBoundedCalls`
  - Line 198: `partiallyRestoredBatchKeepsCachedNeighborAsContext`
  - Line 235: `retryContextUsesCodePointBoundsAndEscapesUntrustedNeighbors`
  - Line 263: `borrowedAcknowledgementsDoNotExemptSentencesOrOtherWords`
  - Line 274: `structuredReasonsKeepEmptyLengthEchoAndScriptDistinct`
  - Line 289: `qualityRepairExplainsEachReasonAndRetainsContextInOneRuntime`
  - Line 356: `repairPreservesOversizedNeighborsAndQualityReason`
  - Line 392: `persistentQualityRejectionStaysInvalidAfterOneRepairAndIsNotCached`

#### `android/src/test/java/app/captionstudio/translation/TranslationResponseContractTest.java`

- Size: 11,541 bytes; 185 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 5. Contract inventory:
  - Line 34: `rejectsUnboundRetryTextForEveryTargetAndNeverCheckpointsIt`
  - Line 79: `batchAndRetryRejectTheSameMalformedSchemaAndControlText`
  - Line 95: `rejectsReorderedIdsInsteadOfSilentlyRepairingTheContract`
  - Line 103: `legacyNormalizedRetryCheckpointCannotBypassTheNewContract`
  - Line 137: `retryUsesBatchSchemaWithOnlyTheRequestedIdAndReadOnlyNeighborContext`

#### `android/src/test/java/app/captionstudio/translation/TranslationResponseFormatRuntimeTest.java`

- Size: 4,391 bytes; 94 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 3. Contract inventory:
  - Line 20: `wrapperForwardsAllFourArgumentsAndDelegateResultUnchanged`
  - Line 53: `defaultOverloadKeepsOldThreeArgumentFakesCompatible`
  - Line 59: `defaultOverloadRetainsUnsupportedStructuredOutputFailure`

#### `android/src/test/java/app/captionstudio/translation/TranslationResponseSchemaTest.java`

- Size: 5,034 bytes; 89 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 3. Contract inventory:
  - Line 25: `exactCountAndExpectedIdsConstrainActualResponses`
  - Line 36: `requiresNonemptyStringTextAndOnlyRequiredProperties`
  - Line 48: `rejectsInvalidDuplicateAndEscapedTransportIdsWithoutEchoingThem`

#### `android/src/test/java/app/captionstudio/translation/TranslationRuntimeReliabilityTest.java`

- Size: 20,490 bytes; 379 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 9. Contract inventory:
  - Line 34: `everyListedSourceReachesEveryListedTargetIncludingIdentityWithoutPivoting`
  - Line 63: `partitionsUnicodeAndHostileJsonLosslesslyWithinTheEscapedByteBudget`
  - Line 82: `malformedSourcesAreExplicitPerCueFailuresAndDoNotPoisonGoodCues`
  - Line 108: `longCueCheckpointsSurviveCancellationAndRebindingToAnotherTransportId`
  - Line 159: `successfulCuesInMixedFailureBatchAreNeverRegeneratedOrExposedToNeighbors`
  - Line 197: `rejectedCuesRecoverInTheSameRunWithoutRegeneratingAcceptedCues`
  - Line 270: `rejectsMalformedOutputUnicodeAndKeepsRetryIdentityStrict`
  - Line 278: `fortyOneFailuresDoNotDiscardTwentyThreeSuccessesOnRefresh`
  - Line 312: `generationAndRepairBudgetsStaySourceRelativeAndBounded`

#### `android/src/test/java/app/captionstudio/translation/TranslationSdkCancellationAdapterTest.java`

- Size: 17,967 bytes; 354 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 17. Contract inventory:
  - Line 129: `successUsesRawOrderedChunksSchemaTokenConfigAndCallingWorker`
  - Line 170: `actualPinnedSdkMapsOnlyStatusOneToCancellationWithoutNativeCalls`
  - Line 181: `actualSdkTypedCancellationIsTerminalWithoutDone`
  - Line 189: `generationFailureSurvivesConcurrentCancelAndLateCallbacks`
  - Line 199: `otherActualSdkStatusSurvivesStopRequest`
  - Line 206: `cancellationAfterTerminalDoesNotReplaceSuccessfulNativeResult`
  - Line 214: `startupDispatchExceptionPreservesIdentityWithoutTypedStatus`
  - Line 223: `doneInsideDispatchCannotCloseBeforeDispatchReturns`
  - Line 233: `deferredCancelAfterTryLockContentionReachesNativeBeforeTerminal`
  - Line 251: `cancelDuringDispatchIsDeferredUntilDispatchReturns`
  - Line 263: `boundedBufferFailureWaitsForNativeTerminalAndDoesNotKeepGrowing`
  - Line 272: `signalFailureDoesNotReleaseOwnerAndSurvivesTypedCancellation`
  - Line 283: `terminalDuringFailedStopSignalWaitsForSignalReturnAndKeepsFailure`
  - Line 303: `generationFailureRemainsPrimaryWhenCancelSignalAlsoFails`
  - Line 314: `closeWaitsForTerminalBeforeConversationOrEngineCleanup`
  - Line 328: `teardownBeforeCallbackPublicationStillJoinsTheWaitingWorker`
  - Line 342: `cleanupFailureKeepsTypedCancellationAsSuppressedEvidence`

#### `android/src/test/java/app/captionstudio/translation/TranslationSdkTypedStatusRegressionTest.java`

- Size: 1,951 bytes; 39 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 1. Contract inventory:
  - Line 12: `productionAdapterUsesTheSdkTypedCancellationCallback`

#### `android/src/test/java/app/captionstudio/translation/TranslationTruncationRecoveryTest.java`

- Size: 12,725 bytes; 243 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 8. Contract inventory:
  - Line 27: `initialAndRepairGenerationReceiveOnlyTheRequestedCueSchema`
  - Line 44: `secondObservedTruncationGetsOneLargerRepairAndCachesOnlyCompleteText`
  - Line 67: `missingBelowCapInvalidOrFlagOnlyMetricsNeverAuthorizeExtraRepair`
  - Line 77: `syntaxEchoAndWrongIdAtCapDoNotAuthorizeExtraRepair`
  - Line 87: `thirdTruncationStopsAndNeverCachesPartialText`
  - Line 97: `additionalRepairStillRejectsSyntaxWrongIdEchoAndTrailingContent`
  - Line 108: `outputCeilingPreventsExtraGeneration`
  - Line 117: `contextCapacityPreventsExpansionWithoutDroppingNeighbors`

#### `android/src/test/java/app/captionstudio/translation/UrduRemovalTest.java`

- Size: 1,535 bytes; 30 lines.
- Review: DEVONLY/KEEP: focused behavioral regression tests; assertions retained even if helper setup is later consolidated.
- Discovered JUnit methods: 1. Contract inventory:
  - Line 9: `rejectsUrduSourceTargetAndIdentityAtBatchAndSessionBoundaries`

#### `android/src/test/resources/translation-preservation-contract.json`

- Size: 17,170 bytes; 692 lines.
- Review: DEVONLY/KEEP: 115 shared native/JS preservation cases; name/source/translated/preserved.

#### `android/src/test/resources/translation-prompt-markers.json`

- Size: 1,192 bytes; 51 lines.
- Review: DEVONLY/KEEP: 22 known markers, 5 unknown prefixes, 12 ordinary literals, pinned tokenizer provenance and fixture license.

#### `android/src/test/resources/translation-protected-composition.json`

- Size: 34,426 bytes; 1,943 lines.
- Review: DEVONLY/KEEP: 104 shared composition/script cases spanning 19 targets; preserve expected review outcomes.

#### `android/src/test/run-focused.ps1`

- Size: 3,891 bytes; 52 lines.
- Review: CONSOLIDATE/DEVONLY: T8 divergent/incomplete runner wiring.

#### `expo-module.config.json`

- Size: 125 bytes; 6 lines.
- Review: KEEP: Android autolinking module identity.

#### `index.ts`

- Size: 197 bytes; 3 lines.
- Review: KEEP: package exports for native module/types/generated contract.

#### `package.json`

- Size: 266 bytes; 12 lines.
- Review: KEEP: local Expo module metadata/peer dependency.

#### `src/CaptionTranslation.types.ts`

- Size: 3,602 bytes; 127 lines.
- Review: KEEP: public request/result/progress/error/type contract; type declarations are not native runtime payload.

#### `src/CaptionTranslationModule.ts`

- Size: 1,032 bytes; 25 lines.
- Review: KEEP: native method/event declaration and requireNativeModule registration.

#### `src/CaptionTranslationModule.web.ts`

- Size: 1,469 bytes; 47 lines.
- Review: KEEP: web registration, limits and unsupported operations; separate support-method mismatch noted.

#### `src/TranslationReleaseContract.generated.ts`

- Size: 625 bytes; 11 lines.
- Review: KEEP: generated JS release identity and model download contract.

### External files traced (targeted, not claimed as full repository audit)

- `AGENTS.md`: repository instructions.
- `src/services/caption-translation.ts`: native support, accepted-event/replay/final-result consumption, backend/checkpoint/repair flags and progress polling.
- `src/lib/translation-preservation.ts`: mechanical equality of all four Unicode tables and shared preservation policy provenance.
- `src/lib/caption-languages.ts`: mechanical equality of both Chinese-variant character patterns.
- `config/product-contract.json`: source-of-truth model and prompt identity.
- `scripts/generate-product-contract.mjs`: exact generated Java/TS ownership and --check semantics.
- `tests/caption-translation-contract.test.mjs`: stale emptyFallback source-name assertion and checkpoint/strict-boundary contract checks.
- `tests/translation-native.ps1`: duplicated test-runner wiring.
- `tests/translation-preservation-cloud.py`: current resources/Mockito/ByteBuddy/JUnit test selection; not executed.
- `tests/translation-serialization-cloud.py`: reference to explicit SerializationTestReceipt invocation.
- `tests/receipt-android-api-compile.py`: reference to SerializationTestReceipt compatibility/compilation workflow.

Repository `git status --porcelain=v1` was empty during inspection. No install/build/test mutation was performed.


## Dependency, build, asset, vendor, and configuration compression audit

Scope: read-only at `3ae54ddb3cf3253037a1c53aaf86177d09c7770a`, isolated repository clone. No package installation, application code edits, prebuild, builds, signing, workflow dispatch, or external publication performed. Repository AGENTS.md was read and Expo SDK 57 reference checked. Byte figures below are uncompressed checked-out file sizes, not Git pack, npm installation, JS bundle, APK, AAB, or delivered per-device savings. No built artifact was measured in this scope, so artifact savings remain unmeasured.

### Executive findings

1. REMOVE candidates: direct `@react-navigation/native` and `expo-status-bar`, subject to clean-install/build validation in a separately authorized change. Neither has a first-party import, config/plugin registration, or another package-lock consumer. Router/React Native are retained. This is not a generic 'no imports means unused' claim: SDK57 Router documentation explicitly exposes navigation through `expo-router`; its locked dependencies/peers do not require `@react-navigation/native`. The likely lock cleanup is six placements, not a measured binary reduction.
2. CONSOLIDATE candidate: `assets/images/icon.png` and `android-icon-foreground.png` decode to exactly the same 1024×1024 RGBA pixels (SHA-256 of decoded pixels `cd8021f039801d4d4ce6917260b0c24ea909d27522ad91b48d28ac5553aaf941`), though file hashes differ due metadata. Redirect `app.json:22` to `icon.png` and delete one redundant source in a future implementation. This removes exactly 693,320 checked-out bytes; Expo can still emit separate launcher/adaptive resources, so APK/AAB and Git-clone savings are unmeasured.
3. All 68 TTFs are live, registered by static requires (`src/lib/font-catalog.ts:8–76`), presented in font choices (`:96–170`), loaded at startup (`src/app/_layout.tsx:19,33`), and resolved for native export (`src/services/export-font-assets.ts:6–18`). Their raw total is 17,023,888 bytes; the top ten are 9,698,532 bytes. Removing fonts or Latin-only subsetting changes the product and saved-project output. Lazy loading might reduce startup/RSS, but not APK bytes by itself.
4. CI consolidation is a substantial execution-cost opportunity, not an application-size saving. Every ordinary PR triggers the 75-minute-timeout commercial release gate, and every PR to main also triggers a 45-minute-timeout duplicate caption-media native suite. Those are timeout ceilings, not measured runtime/cost. Preserve release and behavioral coverage while deduplicating job execution; do not remove gates as 'bloat'.
5. Vendor is 6,442,133 bytes across 163 files, with two locked backport tarballs plus auditable source/tests/provenance. These are active security-maintenance inputs. Their large browser bundles/maps are build/tooling payload, not proven application payload. Do not delete them, replace forks with vulnerable upstream versions, or report their size as APK savings.

### Measurement and classification vocabulary

KEEP = active contract; REMOVE = supported removal candidate with validation gate; REPLACE = replacement design requiring a distinct tested implementation; CONSOLIDATE = merge duplicated representation without weakening behavior; DEVONLY = development/release/reproducibility input, not runtime dead code; NEEDS MEASUREMENT = no safe savings claim yet. Classifications below are recommendations only, no changes made.

### Complete direct dependency audit: 32 production + 5 development entries

| Dependency (package.json line) | Classification | Actual or implicit consumer and preservation contract |
|---|---|---|
| @react-native-community/slider (12) | KEEP | `src/components/editor/animation-browser.tsx:1`; line-spacing control (`animation-browser.tsx:107`); exercise line spacing, accessibility and text-layout regression. |
| @react-navigation/native (13) | REMOVE | No first-party imports or plugin registration. Only root consumes it in lock; native/core/routers at `package-lock.json:3050–3095`. App uses `expo-router` entry/Stack/useNavigation (`package.json:3`, `_layout.tsx:5`, `editor.tsx:14`). SDK57 Router docs say external navigation packages are unnecessary. Validate back handling, route focus/deep links and web after removal. |
| caption-diagnostics (14) | KEEP | `src/services/local-diagnostics.ts:3`; native process-exit history; module config registers Android class. |
| caption-media (15) | KEEP | `src/services/project-media.ts:4`, `timeline-audio-render.ts:3`, `project-export.ts:5`, `transcription.ts:4`, font/media permissions and export rendering. Local file link and native module registration, not removable dependency bloat. |
| caption-translation (16) | KEEP | `src/services/caption-translation.ts:7–10`; native translation/session cancellation and generated release contract; Android module config registration. |
| expo (17) | KEEP | SDK CLI, Metro defaults (`metro.config.js:2`), tsconfig base, config plugins, native module/view loading; SDK57 pinned toolchain. |
| expo-asset (18) | KEEP | `src/services/export-font-assets.ts:1`, `legal-notices.ts:1`, `app.json:62`; fonts and offline notices. Also expo transitive dependency. |
| expo-audio (19) | KEEP | `src/app/editor.tsx:15`, `timeline-audio-runtime.ts:1`, plugin `app.json:54–60`; voice-over recording/playback, intentionally no background recording/playback. |
| expo-constants (20) | KEEP | No app import, but expo dependency and expo-router peer at locked `expo` / `expo-router` entries; required patch target `scripts/patch-android-dependencies.js:87`. Do not remove based on source grep. |
| expo-document-picker (21) | KEEP | `src/services/media-import.ts:1`, `font-storage.ts:1`, plugin `app.json:34`; user-selected media/fonts and URI permissions. |
| expo-file-system (22) | KEEP | Modern API (`transcription.ts:1`, `verified-model-download.ts:1–4`) and legacy API (`database.ts:2`, `project-media.ts:1`, export/recovery). Consolidating modern/legacy call sites is a semantics migration, not duplicate packages. |
| expo-font (23) | KEEP | `_layout.tsx:4,19`, `font-storage.ts:3`, plugin `app.json:67`; bundled/imported font availability and same saved font identity for export. |
| expo-haptics (24) | KEEP | `src/services/timeline-haptics.ts:1`; behavioral coverage `tests/timeline-haptics.test.mjs`. |
| expo-image (25) | KEEP | `src/app/index.tsx:2`, editor timeline/image layer/source sheet, plugin `app.json:68`; media thumbnail/image rendering. Replacing with RN Image is not behavior-preserving without cache/format/perf checks. |
| expo-linking (26) | KEEP | No direct app import, but mandatory expo-router peer (^57.0.13), `app.json:8` scheme, file-system routing/deep links. |
| expo-router (27) | KEEP | `package.json:3`, app config plugin :33, `_layout.tsx:5`, editor/home/privacy/thank-you route APIs; do not swap navigator as compression shortcut. |
| expo-sharing (28) | KEEP | `project-export.ts:4`, `project-recovery.ts:2`, `local-diagnostics.ts:2`, `app.json:63`; share-sheet URI lifetime and recovery/export contracts. |
| expo-splash-screen (29) | KEEP | Plugin `app.json:46–52` and ordered companion :43, `tests/splash-screen-api-contract.test.mjs`; config/native usage suffices despite absent JS import. |
| expo-sqlite (30) | KEEP | `src/services/database.ts:1`, plugin `app.json:35`; project persistence and migrations. |
| expo-status-bar (31) | REMOVE | No JS imports/config plugin or other lock consumer; lock :6368. Router/native screen options own status bar behavior. Require cold-start/editor/fullscreen/dark appearance and edge-to-edge device comparison; JS/binary savings may be zero if already excluded from graph. |
| expo-system-ui (32) | KEEP | No direct JS import, but `app.json:9` forces dark UI. SDK57 SystemUI documents native build-time userInterfaceStyle. Verify generated manifest/resources before any future change, not grep-removal. |
| expo-video (33) | KEEP | `_layout.tsx:6,24`, `use-timeline-video-controller.ts:6`, video transition overlay; plugin :37–41 intentionally disables background/PiP. Preserve 128 MiB cache policy, playback, scrubbing and export preview. |
| react (34) | KEEP | JSX/runtime hooks throughout app, module peers; Expo57/React19.2.3 contract. |
| react-dom (35) | KEEP | Implicit web renderer peer; `package.json:74`, `app.json:28–31` declare supported web workflow; no direct import does not make it unused. Scope removal would retire web. |
| react-native (36) | KEEP | UI/runtime/native types throughout; SDK57 RN0.86.3 compatibility, ABI and build patch contracts. |
| react-native-gesture-handler (37) | KEEP | `_layout.tsx:7,36`, `timeline-native-gesture.tsx:3`; native gesture/thread lifecycle and cancellation tests. |
| react-native-reanimated (38) | KEEP | `timeline-native-gesture.tsx:4`; setGestureState/shared values; native gesture behavior. Reanimated peer requires worklets 0.10.x. |
| react-native-safe-area-context (39) | KEEP | `_layout.tsx:3`, editor/modals; mandatory Router peer; protects insets, keyboard/secondary-window layout. |
| react-native-screens (40) | KEEP | expo-router direct dependency and peer; patch target `patch-android-dependencies.js:92`; implicit native Stack registration. |
| react-native-web (41) | KEEP | Explicit web script/config and Expo/Router optional peers become relevant when web target is requested; do not retire supported platform implicitly. |
| react-native-worklets (42) | KEEP | `timeline-native-gesture.tsx:5` scheduleOnRN/scheduleOnUI plus Reanimated peer; thread marshaling contract. |
| whisper.rn (43) | KEEP | `src/services/transcription.ts:2` imports `/index`; native rnwhisper ABI required (`verify-android-abi.mjs:6–17`); model download and VAD/transcription behavior. |
| @types/react (46) | DEVONLY | React JSX/hook typechecking via tsconfig and CI `npx tsc --noEmit`; keep dev scope. |
| eslint (47) | DEVONLY | `eslint.config.js:1`, `package.json:75`; keep quality gate, not application dependency. |
| eslint-config-expo (48) | DEVONLY | `eslint.config.js:2,5`; Expo lint defaults plus explicit hook contracts. |
| tsx (49) | DEVONLY | `package.json:76`, branch workflow execution; `tests/*.test.mjs` loads TS modules. Keep locked. |
| typescript (50) | DEVONLY | tsconfig, CI tsc and extensive tests importing `typescript` to transpile mocked modules (e.g. `tests/root-window-insets.test.mjs:5`); not removable because runtime JS excludes it. |

External verification: [SDK 57 reference](https://docs.expo.dev/versions/v57.0.0/), [SDK57 Router](https://docs.expo.dev/versions/v57.0.0/sdk/router/), [SDK57 SystemUI](https://docs.expo.dev/versions/v57.0.0/sdk/system-ui/). These corroborate implicit contracts; repository lock/config remain the audited source of exact versions.

#### Removal closure and lockfile analysis

`package-lock.json` is 454,065 bytes, lockfile v3. It has 892 non-root records: 889 node_modules placements (including 3 local links) plus 3 local module definitions. There are 782 locked package names. 47 names have repeated placements; 45 span multiple versions; 50 locked placements repeat an already-present version; total excess placements by name is 107. Of locked placements, 279 are marked dev and 65 optional. These labels do not describe actual Metro inclusion: Expo CLI/build dependencies are under production expo, and optional per-platform packages may never be installed on a given host.

Static exclusive closure for the two REMOVE candidates: `@react-navigation/native`, `@react-navigation/core`, `@react-navigation/routers`, `use-sync-external-store`, top-level `standard-navigation@0.0.8`, `expo-status-bar`. Router's nested `standard-navigation@0.0.5` must remain; a regenerated npm lock might hoist it. Shared `use-latest-callback`, query-string, nanoid, react-is etc stay required elsewhere. This is six candidate removed placements, not six guaranteed package-name deletions or a size forecast.

NEEDS MEASUREMENT: dedupe compatible equal versions with a future isolated lock experiment and compare installed size plus Metro/native graphs. Nine placements each of hermes-parser and hermes-estree cover 0.25.1, 0.35.0, 0.36.0 and 0.36.1 across ESLint, Expo Metro and RN tooling; globally overriding them risks parser/codegen mismatch. Two Metro families (@expo/metro and metro 0.84.5) are explicitly integrated/tested, not automatically duplicates. Preserve package.json:52–63 overrides pending compatibility/security evidence. Do not run npm dedupe/upgrade as a blind audit fix.

### Asset findings and protected contract

All 143 assets inventoried: 68 fonts (17,023,888 bytes), 68 license files (341,673 bytes), 7 PNGs (2,530,614 bytes), total 19,896,175 bytes. No unused font proved. Source-only brand PNG is 921,566 bytes; retaining original brand source is a reproducibility choice, not application dead weight. All six assets/images PNGs are explicitly selected by app config. Complete per-file inventory follows at the end.

- CONSOLIDATE duplicate icon source: app.json:7/22 references two pixel-identical PNGs. Keep 1024×1024 content, alpha, color metadata and adaptive foreground safe-zone appearance, then compare prebuild icons/splash/native appearance. Saving is 693,320 raw working-tree bytes only; generated resource duplication can remain.
- NEEDS MEASUREMENT font representation/startup: total font size is known, but lossless font re-encoding, hinting removal, instantiating variable fonts, glyph subsetting and downloadable packs can change glyph repertoire, shaping, metrics, identity, offline availability or license obligations. Do not remove assets or alter the 68-family catalog. A staged load plan can retain bundled files, initially load UI/project-required fonts and load browser rows as needed, but must still support immediate saved-project render, imported fonts and export (`_layout.tsx:19–33`, `export-font-assets.ts:6–18`); measure cold startup and RSS separately from binary size.
- KEEP legal-source files: byte-identical license groups have 105,229 duplicate checked-out bytes (10 Rubik notices, 2 Bungee, 6 Apache, 2 Rubik microbe/vinyl). Individual files are intentionally preserved by README:231 / THIRD_PARTY_NOTICES.md:29. Keep the individual notices and all attribution obligations. Only anton-OFL.txt plus two third-party notices are statically bundled by `legal-notices.ts:4–6`; there is no demonstrated application-size gain from deleting the other notices. This is an inventory observation, not a proposed reduction.
- KEEP `shared/emoji-reactions.json` (11,268 bytes): JS imports `src/lib/emoji-reactions.ts:1`; native Gradle `modules/caption-media/android/build.gradle:21–24` packages shared directory and `EmojiReactionCatalog.kt:143` opens the name dynamically. One shared authority already avoids divergent catalogs. Zero-import searches cannot assess native resource reads.
- KEEP third-party notices and `licenses/translation-preservation-unicode.txt`; copyright/license/provenance obligations are not dead text to remove.

### Native/implicit dependencies and configuration

- KEEP `caption-refract` even though absent from package.json: `modules/caption-refract/expo-module.config.json:2–4` registers it and `src/components/refract-background.tsx:1–7` uses requireNativeView('CaptionRefract'). Its Gradle project is an Expo module. Module scanning must be included in any autolink audit.
- KEEP media Gradle `exifinterface:1.4.2`, `media3-transformer:1.10.1`, `media3-effect:1.10.1` (`modules/caption-media/android/build.gradle:29–31`). Exif is used by BitmapOrientation/CaptionMediaModule/exporter; Media3 supplies timeline audio/video compositions and effects. JUnit/Robolectric :32–33 are DEVONLY test dependencies.
- KEEP translation `litertlm-android:0.16.1` (`modules/caption-translation/android/build.gradle:23`), invoked by LiteRtLmTranslationRuntime and TranslationSdkGateway. Java21 toolchain/Java17 output (:28–41,64–83) is a checked SDK-classfile contract; JUnit/Mockito/ByteBuddy (:24,50–61) are DEVONLY. NEEDS MEASUREMENT broad `consumer-rules.pro:1` keep-all rule: narrowing requires the SDK's JNI/reflection/serialization keep contract, R8 usage report and real release-device translation/cancellation tests. No size savings measured.
- KEEP ABI baseline: `scripts/verify-android-abi.mjs:6–20` requires RN/Whisper in arm64-v8a, armeabi-v7a, x86, x86_64, and LiteRT JNI in arm64-v8a/x86_64. Deleting architectures is a supported-device change. AAB delivered per-device splits should be measured separately from universal APK size; do not relax verifier to make a smaller artifact pass.
- KEEP release minify/resource shrink already enabled (`configure-android-release.js:79–80`, verifier :83–84), pinned R8/Gradle/checksum (:60–71 / verifier :86–91). These optimizations are already present, not new opportunities.
- KEEP app.json identity, version, dark UI, permission blocking, backup=false, typedRoutes/reactCompiler, plugin order and web output; these are product/security/runtime contracts.
- KEEP metro.config.js:5 txt registration for offline notices and :7–17 safe-buffer resolution to lightweight Hermes shim; whisper.rn depends on safe-buffer. Removing shim would change Buffer availability/bundle dependencies. Check `src/shims/safe-buffer.ts` and transcription binary behavior before changing.
- DEVONLY eslint.config.js, tsconfig.json, .vscode/*, .claude/settings.json, .codex/environments/environment.toml. They are development settings; removing their tiny files does not prove app-size savings. Preserve Windows entry actions in environment.toml if consolidating build wrappers.
- KEEP config/product-contract.json as authority for identity, certificate pin, translation model URL/revision/size/digest/prompt version; generator emits TS/Java copies and --check enforces exact identity. The 1,597,931,520-byte model is downloaded, not in these tracked assets or APK; changing model is outside compression cleanup.
- KEEP config/android-lint.xml:3–5 narrow Expo video notification warning exception and first-party lint init script; do not broaden exclusions.
- DEVONLY .gitattributes/.gitignore: binary/text normalization and ignored generated android/ios/build/cache outputs. Generated directories are deliberately absent; do not mistake ignored state for missing source.

#### All six custom plugins

| File | Classification | Actual role and tests |
|---|---|---|
| plugins/with-android-lint-contract.js | KEEP | app.json:69; :3–18 inserts exact narrow lint config, Groovy/anchor checks; tests/android-media-runtime-contract.test.mjs. |
| plugins/with-font-scale-configuration.js | KEEP | app.json:44; :16–25 adds only fontScale to MainActivity configChanges, prevents recreation while retaining resources/layout events; tests/font-scale-configuration.test.mjs. |
| plugins/with-legacy-export-permission.js | KEEP | app.json:64; :10–19 bounds WRITE_EXTERNAL_STORAGE to API28; tests/legacy-export-permission.test.mjs. |
| plugins/with-litert-gpu-libraries.js | KEEP | app.json:66; :3,13–18 optional native library declarations (not binary copies). Removing declarations is not removal of bundled GPU code. Native SDK/backend contract must decide future retirement. |
| plugins/with-soloader-metadata.js | KEEP | app.json:65; :9–19 overrides com.facebook.soloader.enabled=true; tests/editor-logic.test.mjs:294; native startup contract. |
| plugins/with-splash-screen-api-contract.js | KEEP | app.json:43,46 order; :9–17 annotates generated API33 behavior without changing splash; tests/splash-screen-api-contract.test.mjs. |

#### All build/release scripts (18 files including script/ wrappers)

| File | Classification | Consumer/contract and compression decision |
|---|---|---|
| scripts/android-patch-utils.js | DEVONLY / CONSOLIDATE only with tests | Shared patch primitives; no blanket deletion. findNamedBlockRange :81–92 resembles verifier findNamedBlock :128–139, but write/read validation boundaries differ; tiny unmeasured maintenance consolidation, not priority size win. |
| scripts/patch-android-dependencies.js | KEEP (build-only) | postinstall wrapper invokes it; Kotlin alignment, manifest cleanup, Groovy modernization; :98–101 validates outcomes. Must survive clean Expo prebuild and exact SDK patch guards. |
| scripts/patch-react-native-gradle.js | KEEP (build-only) | package.json:66,68–71 and workflows; composes dependency patch and release config. Wrapper is 335 bytes, useful contract boundary. |
| scripts/configure-android-release.js | KEEP (build-only) | Pins Gradle/R8, minify/shrink, signing binding/guard; release tasks fail closed without credentials. |
| scripts/verify-android-release-config.js | KEEP (build-only) | package.json:72 and workflows; package, SDK24/36, R8, wrapper hash, backup=false, no debug-release signing. |
| scripts/generate-product-contract.mjs | KEEP (build-only) | package scripts :77–78, release workflow; preserves one JSON authority with TS/Java generation and exact --check. |
| scripts/configure-sidecar-release.mjs | KEEP (release-only) | CI/private stamp and publish workflow; validates prior releases, monotonic identity, approved source/cert, refuses replacement. Do not merge its publication trust boundary with generic helpers without negative tests. |
| scripts/sign-android-release.js | DEVONLY / NEEDS MEASUREMENT retirement | Explicit one-time `--migration` signer (:7–9), package migration script :70, signing lineage :34–37; 3,857 bytes. Can retire only after maintainer confirms old installed users no longer need migration and documentation is updated. Never run during audit. |
| scripts/install-caption-studio.ps1 | KEEP (distribution-only) | Public installer flow, verifies release hash/cert/package (:248–294), adb update without uninstall (:296), installed version (:314–315); security contract outweighs source reduction. |
| scripts/verify-android-abi.mjs | KEEP (artifact verification) | CI, signed/unsigned packaging; exact supported ABI/library contract. |
| scripts/check-elf-16k-alignment.sh | KEEP (artifact verification) | CI/release script; verifies 64-bit .so LOAD alignments >=2**14, fails on missing/unverified libraries. |
| scripts/first-party-android-lint.gradle | KEEP (build-only) | Only dependency-project lintAnalyze is disabled; first-party lint and pinned narrow exception remain. Tests/android-lint-scope.test.mjs. |
| scripts/unsigned-play-release.gradle | KEEP (separate release-only boundary) | Rejects real signing properties/env and validateSigning tasks, forces unsigned release; not duplicate of signed guard. Tests/unsigned-play-aab.test.mjs. |
| scripts/verify-unsigned-play-aab.mjs | KEEP (artifact verification) | Immutable approved source/tree/version :11–18, rejects credentials :33–37, signature absence :52–66, mapping/identity/16K :70–98; separation protects explicit unsigned workflow. |
| scripts/verify-play-aab.mjs | KEEP (artifact verification) | Signed approval/tag/source/certificate/mapping provenance; :16–69, :106 onward; not interchangeable with unsigned verifier. Small hash/mapping utilities can be consolidated only after signed/unsigned negative tests stay distinct. |
| scripts/test-private-artifact-gate.mjs | DEVONLY | Official GitHub expression evaluator and YAML harness verifies real publish workflow/ref/input/status guard (including failure/cancelled), not generic lint; executed in isolated pinned harness workflow. |
| script/build_and_run.sh | DEVONLY / CONSOLIDATE candidate | Unix convenience aliases, CLI :23–37; preserve run/android/dev-client/build/doctor UX and no unintended signing. |
| script/build_and_run.ps1 | DEVONLY / CONSOLIDATE candidate | Windows UI task entry; :12–16 same modes but GRADLE_OPTS and shell semantics differ. Shared Node dispatcher would reduce duplication but likely adds more files/LOC than 1,697-byte wrappers; defer unless maintenance issue. |

### Vendor/security backports

`package.json:62–63` installs immutable-commit URL tarballs; source directories are not file: runtime dependencies. Active dependency edges: micromatch→braces; Expo CLI and @expo/code-signing-certificates→node-forge. These must not be removed from lock or downgraded merely because app src does not import them.

All 163 vendor files were inventoried. Reviewed groups: braces 24 files /166,325 bytes; node-forge 137 /5,169,907 bytes; tarballs 15,197 and 1,090,704 bytes. Node-forge dist's 6 files total 3,286,532 bytes, primarily source maps; package manifest :27–31 intentionally includes lib, flash, minified browser distributions and maps. Braces manifest :19–22 includes index/lib, not its test tree. Original licenses/private names, patched source, provenance, regression tests and tarball integrity are distinct representations with different jobs.

KEEP current backports; REPLACE later with a maintained published fix only after proving exact defensive behavior/API compatibility against current consumers. `docs/dependency-reviewed-backports/README.md:2–5` requires provenance/RED-GREEN/compatibility evidence and explicitly notes npm audit cannot validate private forks. Existing evidence is historical at other SHAs, not a fresh security or test certification of this audit SHA. `tests/dependency-api-compatibility.cjs:19–28` exercises both Metro consumers and :30–55 Expo certificate consumer; `tests/published-dependency-regressions.cjs` exercises the shell-quote/source-map overrides. Security-sensitive pruning of vendor package contents requires independent review and regenerated provenance/tarball/lock integrity, not deleting checked-in bytes and claiming runtime savings.

NEEDS MEASUREMENT distribution slimming option: a deliberately Node-only backport tarball could omit browser bundles/maps/Flash only after resolving every actual package consumer/export entry and preserving source/tests in a separately accessible reproducible source artifact. Current exact tgz has 1,090,704 bytes; any smaller replacement is unmeasured. No safe claim of 3.29MB APK reduction follows from uncompressed vendor dist. No current upstream advisory status was inferred from old audit JSON.

### Workflow scope, duplication and publication safety

11 workflow files fully enumerated. No pull_request_target, workflow_run, workflow_call, repository_dispatch, or scheduled Actions trigger exists. Dependabot has its own weekly/monthly schedules. No workflow dispatch or run was requested/performed.

| Workflow | Triggers | Cost/side effect and disposition |
|---|---|---|
| ci.yml | all pull_request; push main and codex/source-echo-protected-composition; v* tags; manual | 75m timeout; npm ci, audit/logic/types/lint/Expo check; clean Android prebuild, ephemeral CI key generation, lint/tests, APK+AAB builds; 14d reports/artifacts. KEEP release gate, NEEDS MEASUREMENT split lightweight checks from native/artifact gate by changes or explicit release intent. |
| native-audio-lanes.yml | PR to main; 3 named push branches | 45m timeout; second npm ci/prebuild and caption-media release tests; 90d evidence. CONSOLIDATE PR execution with ci.yml:114, preserving complete raw logs and unit reports. Branch-specific evidence may still matter. |
| audio-cancellation-boundary.yml | only codex/audio-cancellation-boundary push | 20m timeout; targeted JS + full logic/product/type/lint/inventory. DEVONLY historical repair gate; archive/remove only once tests remain in normal gate and branch work is closed. |
| translation-listener-lifecycle.yml | only codex/translation-listener-lifecycle push | 30m; dependency CJS tests, lifecycle/full logic/types/lint, 14d logs. DEVONLY; preserve tests before consolidating branch workflow. |
| translation-preservation-red.yml | four named repair-branch pushes | 30m; Java21, dependency tests, Python harness, Expo prebuild and native translation tests, 14d reports. DEVONLY; do not erase repair evidence/coverage. |
| translation-selective-wire.yml | only codex/translation-selective-wire-review push | 60m; RED/GREEN stage-controlled install, Python/API compile, optional ephemeral-key release tests, 14d reports. DEVONLY; unique stage logic, not redundant YAML deletion until closed. |
| private-artifact-gate-test.yml | two named repair branches + specific changed paths | four-state matrix, 10m each ceiling; isolated pinned npm harness install, no application build/publication. DEVONLY, keep real expression negative tests. |
| pages.yml | main push touching docs/privacy/** or this workflow; manual | Publishes privacy site with pages/id-token write permission. KEEP. A docs/compression audit path does not match. Never stage audit under public privacy site accidentally. |
| publish-sidecar.yml | manual only | 90m; exact main or restricted private-test ref guard precedes checkout; production signing and conditional gh release create; 30d artifacts. KEEP distinct production boundary. No automatic PR publication. |
| verify-play-aab.yml | manual only | 90m; main/repository restricted, verifies existing published release, production signing + AAB, 14d artifacts. KEEP distinct source approval and signer checks. |
| unsigned-play-aab.yml | named build branch push; PR changing only specified four paths; manual | 5m regression job; 90m packaging only push/manual on named branch/main, immutable product-source checkout; refuses signing inputs; 14d artifacts. KEEP unsigned boundary, no packaging on PR. |

CI opportunity order: first collect run timing/cache/artifact-retention bytes; then route docs-only changes to a cheap successful doc check (requires authorized workflow change), share native caption-media results between CI and native-audio lane, centralize repeated environment setup if it improves maintenance, and retire closed one-off branch gates after all unique tests are retained. Do not combine signed/unsigned trust boundaries or weaken tests for savings. Avoid blanket paths-ignore if required status checks would remain pending and block merge.

Dependency regression caveat: normal `test:logic` is `tests/*.test.mjs` (`package.json:76`), so the two `.cjs` dependency security/compatibility suites are not in that glob. Branch listener/preservation workflows explicitly run them. If retiring branch gates, add/retain these tests in a consciously approved normal validation path first; this audit does not change CI.

#### Safe docs-only PR plan (no expensive workflow execution)

1. Prepare only audit markdown and companion coverage CSV in a new branch name not used by branch-triggered workflows; do not alter workflows, manifest, lock, app.json or release inputs.
2. Maintainer reviews diff and confirms docs-only scope. Put `[skip ci]` in the HEAD commit message before push/PR creation. GitHub documents this for push/pull_request triggers: https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs . A draft PR alone does not suppress workflows. This repo has no pull_request_target or workflow_run exception trigger.
3. Open the requested draft PR with clear disclosure that CI is intentionally skipped and builds/signing were not run; required checks can remain pending and therefore block merge. No force-merge or branch-protection change. Do not manually dispatch any workflow. Every subsequent commit must retain the intended skip instruction.
4. Confirm afterward read-only that no expensive runs started and the file diff is docs-only. If anything unexpectedly queues, report the exact run; cancellation would require scope/approval under the task’s authorization. Do not mark unrun checks passed.
5. Keep eventual implementation/measurement PRs separate and obtain approval for paid CI/build/signing/workflow changes. On eventual merge, main push may run gates unless the merge commit also satisfies skip instructions; this plan is draft-publication only, not merge authorization.

### Recommended future implementation/test cascade

A. Lowest-risk dependency/source change: remove the two dependency declarations and consolidate duplicate icon source in separate reviewable commits; regenerate lock with pinned npm, clean install and confirm predicted prune graph. Run current product/logic/TypeScript/lint checks, explicit CJS security and consumer tests, SDK57 install-check/doctor. Verify web route export, Android cold launch/Stack/back/deep links/status bars/insets, then clean prebuild/diff autolinking/resources. Build/size comparison only when separately authorized. Hold identity/permissions/ABI/signing/minification unchanged.

B. CI consolidation: snapshot exact job commands/check names/evidence destinations and branch-protection requirements; implement testable change classifier or reusable job; prove all main/release native lint/unit suites still execute and all dependency/translation gate tests remain reachable. Compare representative run minutes, npm/Gradle cache hits and artifact retention; a 120-minute combined timeout is not current actual spend.

C. Asset/performance experiment: retain all 68 fonts and offline behavior, record cold startup time/peak RSS/font-selection latency. If testing font re-encoding, preserve complete Unicode cmap, glyph shapes/metrics/shaping/kerning, family identifiers, variation behavior, native export/preview pixel comparisons and licenses. No assumed savings.

D. Vendor package experiment: provenance hashes, exact tarball entries/integrity and consumer entry paths; rerun backport regression/normal API tests in both Metro and Expo CLI consumers before narrowing distribution or replacing upstream. Keep code-signing and unsigned release verification boundaries separate. Measure npm download/install and source bytes independently of application size.


### Appendix A: all repeated lockfile package names

All 47 names are covered below. Different-major/peer-context copies are not automatically dedupable; same-version copies are experiment candidates. Paths are exact lock keys.

| Name | Locked placement versions | Count | Disposition |
|---|---|---:|---|
| @radix-ui/react-presence | 1.1.11 × 2 | 2 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| @radix-ui/react-primitive | 2.2.0 × 2 | 2 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| @react-native/normalize-colors | 0.74.89 × 1, 0.86.3 × 1 | 2 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| accepts | 1.3.8 × 1, 2.0.0 × 1 | 2 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| ansi-regex | 4.1.1 × 1, 5.0.1 × 1 | 2 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| ansi-styles | 3.2.1 × 2, 4.3.0 × 1, 5.2.0 × 1 | 4 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| babel-plugin-syntax-hermes-parser | 0.36.0 × 2, 0.36.1 × 1 | 3 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| balanced-match | 1.0.2 × 1, 4.0.4 × 3 | 4 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| brace-expansion | 1.1.21 × 1, 5.0.12 × 3 | 4 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| chalk | 2.4.2 × 2, 4.1.2 × 1 | 3 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| ci-info | 2.0.0 × 1, 3.9.0 × 2 | 3 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| color-convert | 1.9.3 × 2, 2.0.1 × 1 | 3 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| color-name | 1.1.3 × 2, 1.1.4 × 1 | 3 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| commander | 12.1.0 × 1, 2.20.3 × 1, 7.2.0 × 1 | 3 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| debug | 2.6.9 × 5, 3.2.7 × 4, 4.4.3 × 1 | 10 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| encodeurl | 1.0.2 × 1, 2.0.0 × 2 | 3 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| escape-string-regexp | 1.0.5 × 2, 4.0.0 × 1 | 3 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| eslint-visitor-keys | 3.4.3 × 1, 4.2.1 × 1, 5.0.1 × 1 | 3 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| globals | 14.0.0 × 1, 16.5.0 × 1 | 2 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| has-flag | 3.0.0 × 2, 4.0.0 × 1 | 3 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| hermes-estree | 0.25.1 × 1, 0.35.0 × 2, 0.36.0 × 4, 0.36.1 × 2 | 9 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| hermes-parser | 0.25.1 × 1, 0.35.0 × 2, 0.36.0 × 4, 0.36.1 × 2 | 9 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| ignore | 5.3.2 × 1, 7.0.8 × 1 | 2 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| json5 | 1.0.2 × 1, 2.2.3 × 1 | 2 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| lru-cache | 10.4.3 × 1, 11.5.2 × 1, 5.1.1 × 1 | 3 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| memoize-one | 5.2.1 × 1, 6.0.0 × 1 | 2 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| mime-db | 1.52.0 × 1, 1.54.0 × 1 | 2 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| mime-types | 2.1.35 × 1, 3.0.2 × 1 | 2 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| minimatch | 10.2.6 × 3, 3.1.5 × 1 | 4 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| ms | 2.0.0 × 5, 2.1.3 × 1 | 6 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| negotiator | 0.6.3 × 1, 0.6.4 × 1, 1.1.0 × 1 | 3 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| on-finished | 2.3.0 × 1, 2.4.1 × 1 | 2 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| picomatch | 2.3.2 × 2, 4.0.7 × 1 | 3 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| promise | 7.3.1 × 1, 8.3.0 × 1 | 2 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| react-is | 16.13.1 × 2, 18.3.1 × 1, 19.2.8 × 1 | 4 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| resolve | 1.22.12 × 1, 2.0.0-next.7 × 1 | 2 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| resolve-from | 4.0.0 × 1, 5.0.0 × 1 | 2 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| semver | 6.3.1 × 9, 7.8.5 × 1 | 10 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| source-map | 0.5.7 × 1, 0.6.1 × 1 | 2 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| standard-navigation | 0.0.5 × 1, 0.0.8 × 1 | 2 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| statuses | 1.5.0 × 1, 2.0.2 × 2 | 3 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| strip-ansi | 5.2.0 × 1, 6.0.1 × 1 | 2 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| supports-color | 5.5.0 × 2, 7.2.0 × 1, 8.1.1 × 1 | 4 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| type-fest | 0.21.3 × 1, 0.7.1 × 1 | 2 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| ws | 7.5.13 × 1, 8.22.0 × 1 | 2 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| xmlbuilder | 11.0.1 × 1, 15.1.1 × 1 | 2 | NEEDS MEASUREMENT; preserve parent ranges/peer context |
| zod | 3.25.76 × 1, 4.5.4 × 1 | 2 | NEEDS MEASUREMENT; preserve parent ranges/peer context |

### Appendix B: every tracked asset and registration

Font rows map exact static require lines; all feed the dynamic family lookup/export and root load described above. License rows remain attribution sources for the correspondingly named fonts; a source-only notice is not permission to delete it.

| Asset | Raw bytes | Classification and registration |
|---|---:|---|
| assets/brand/caption-studio-icon-source.png | 921,566 | DEVONLY brand source; no app registration found; preserve source/reproducibility |
| assets/fonts/abrilfatface.ttf | 67,364 | KEEP; src/lib/font-catalog.ts:53 |
| assets/fonts/alfaslabone.ttf | 97,376 | KEEP; src/lib/font-catalog.ts:54 |
| assets/fonts/anton.ttf | 170,812 | KEEP; src/lib/font-catalog.ts:9 |
| assets/fonts/archivoblack.ttf | 90,988 | KEEP; src/lib/font-catalog.ts:55 |
| assets/fonts/audiowide.ttf | 69,916 | KEEP; src/lib/font-catalog.ts:56 |
| assets/fonts/bangers.ttf | 93,148 | KEEP; src/lib/font-catalog.ts:57 |
| assets/fonts/bebasneue.ttf | 61,400 | KEEP; src/lib/font-catalog.ts:10 |
| assets/fonts/blackopsone.ttf | 166,532 | KEEP; src/lib/font-catalog.ts:41 |
| assets/fonts/boogaloo.ttf | 33,960 | KEEP; src/lib/font-catalog.ts:58 |
| assets/fonts/bowlbyonesc.ttf | 55,200 | KEEP; src/lib/font-catalog.ts:42 |
| assets/fonts/bungee.ttf | 118,996 | KEEP; src/lib/font-catalog.ts:11 |
| assets/fonts/bungeeshade.ttf | 304,936 | KEEP; src/lib/font-catalog.ts:12 |
| assets/fonts/cabinsketch.ttf | 271,012 | KEEP; src/lib/font-catalog.ts:43 |
| assets/fonts/chewy.ttf | 41,248 | KEEP; src/lib/font-catalog.ts:59 |
| assets/fonts/concertone.ttf | 71,028 | KEEP; src/lib/font-catalog.ts:60 |
| assets/fonts/creepster.ttf | 62,724 | KEEP; src/lib/font-catalog.ts:13 |
| assets/fonts/dmserifdisplay.ttf | 76,580 | KEEP; src/lib/font-catalog.ts:61 |
| assets/fonts/dokdo.ttf | 2,150,860 | KEEP; src/lib/font-catalog.ts:44 |
| assets/fonts/eater.ttf | 83,928 | KEEP; src/lib/font-catalog.ts:14 |
| assets/fonts/fascinateinline.ttf | 59,604 | KEEP; src/lib/font-catalog.ts:15 |
| assets/fonts/fasterone.ttf | 94,044 | KEEP; src/lib/font-catalog.ts:16 |
| assets/fonts/fjallaone.ttf | 209,052 | KEEP; src/lib/font-catalog.ts:63 |
| assets/fonts/fontdinerswanky.ttf | 45,524 | KEEP; src/lib/font-catalog.ts:45 |
| assets/fonts/francoisone.ttf | 79,356 | KEEP; src/lib/font-catalog.ts:62 |
| assets/fonts/frederickathegreat.ttf | 486,016 | KEEP; src/lib/font-catalog.ts:17 |
| assets/fonts/frijole.ttf | 227,860 | KEEP; src/lib/font-catalog.ts:18 |
| assets/fonts/gravitasone.ttf | 41,448 | KEEP; src/lib/font-catalog.ts:46 |
| assets/fonts/hennypenny.ttf | 92,596 | KEEP; src/lib/font-catalog.ts:19 |
| assets/fonts/knewave.ttf | 32,460 | KEEP; src/lib/font-catalog.ts:47 |
| assets/fonts/lacquer.ttf | 294,060 | KEEP; src/lib/font-catalog.ts:20 |
| assets/fonts/licenses/abrilfatface-OFL.txt | 4,413 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/alfaslabone-OFL.txt | 4,429 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/anton-OFL.txt | 4,391 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29; runtime import src/services/legal-notices.ts:6 |
| assets/fonts/licenses/archivoblack-OFL.txt | 4,398 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/audiowide-OFL.txt | 4,429 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/bangers-OFL.txt | 4,387 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/bebasneue-OFL.txt | 4,337 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/blackopsone-OFL.txt | 4,410 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/boogaloo-OFL.txt | 4,439 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/bowlbyonesc-OFL.txt | 4,432 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/bungee-OFL.txt | 4,380 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/bungeeshade-OFL.txt | 4,380 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/cabinsketch-OFL.txt | 4,415 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/chewy-Apache-2.0.txt | 11,358 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/concertone-OFL.txt | 4,472 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/creepster-OFL.txt | 4,399 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/dmserifdisplay-OFL.txt | 4,512 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/dokdo-OFL.txt | 4,356 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/eater-OFL.txt | 4,368 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/fascinateinline-OFL.txt | 4,455 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/fasterone-OFL.txt | 4,415 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/fjallaone-OFL.txt | 4,391 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/fontdinerswanky-APACHE.txt | 11,358 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/francoisone-OFL.txt | 4,375 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/frederickathegreat-OFL.txt | 4,433 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/frijole-OFL.txt | 4,415 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/gravitasone-OFL.txt | 4,397 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/hennypenny-OFL.txt | 4,677 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/knewave-OFL.txt | 4,418 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/lacquer-OFL.txt | 4,388 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/lilitaone-OFL.txt | 4,390 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/limelight-OFL.txt | 4,399 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/luckiestguy-Apache-2.0.txt | 11,358 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/metalmania-OFL.txt | 4,401 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/modak-OFL.txt | 4,345 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/monofett-OFL.txt | 4,424 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/monoton-OFL.txt | 4,401 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/nosifer-OFL.txt | 4,369 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/paytoneone-OFL.txt | 4,445 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/permanentmarker-APACHE.txt | 11,358 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/pressstart2p-OFL.txt | 4,413 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/racingsansone-OFL.txt | 4,479 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/rammettoone-OFL.txt | 4,428 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/ranchers-OFL.txt | 4,473 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/rocksalt-Apache-2.0.txt | 11,358 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/rowdies-OFL.txt | 4,383 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/rubikbeastly-OFL.txt | 4,406 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/rubikbubbles-OFL.txt | 4,406 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/rubikburned-OFL.txt | 4,406 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/rubikdirt-OFL.txt | 4,406 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/rubikdistressed-OFL.txt | 4,406 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/rubikglitch-OFL.txt | 4,406 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/rubikiso-OFL.txt | 4,406 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/rubikmarkerhatch-OFL.txt | 4,406 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/rubikmicrobe-OFL.txt | 4,405 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/rubikmoonrocks-OFL.txt | 4,406 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/rubikpuddles-OFL.txt | 4,406 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/rubikvinyl-OFL.txt | 4,405 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/russoone-OFL.txt | 4,389 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/rye-OFL.txt | 4,393 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/sancreek-OFL.txt | 4,390 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/sixtyfour-OFL.txt | 4,400 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/specialelite-Apache-2.0.txt | 11,358 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/squadaone-OFL.txt | 4,419 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/staatliches-OFL.txt | 4,386 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/tiltprism-OFL.txt | 4,387 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/titanone-OFL.txt | 4,417 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/licenses/unifrakturcook-OFL.txt | 4,413 | KEEP attribution source; README:231 / THIRD_PARTY_NOTICES.md:29 |
| assets/fonts/lilitaone.ttf | 28,092 | KEEP; src/lib/font-catalog.ts:64 |
| assets/fonts/limelight.ttf | 132,292 | KEEP; src/lib/font-catalog.ts:21 |
| assets/fonts/luckiestguy.ttf | 73,320 | KEEP; src/lib/font-catalog.ts:65 |
| assets/fonts/metalmania.ttf | 254,568 | KEEP; src/lib/font-catalog.ts:22 |
| assets/fonts/modak.ttf | 650,188 | KEEP; src/lib/font-catalog.ts:48 |
| assets/fonts/monofett.ttf | 72,328 | KEEP; src/lib/font-catalog.ts:66 |
| assets/fonts/monoton.ttf | 51,604 | KEEP; src/lib/font-catalog.ts:23 |
| assets/fonts/nosifer.ttf | 43,272 | KEEP; src/lib/font-catalog.ts:24 |
| assets/fonts/paytoneone.ttf | 114,648 | KEEP; src/lib/font-catalog.ts:67 |
| assets/fonts/permanentmarker.ttf | 74,632 | KEEP; src/lib/font-catalog.ts:49 |
| assets/fonts/pressstart2p.ttf | 118,204 | KEEP; src/lib/font-catalog.ts:25 |
| assets/fonts/racingsansone.ttf | 145,796 | KEEP; src/lib/font-catalog.ts:68 |
| assets/fonts/rammettoone.ttf | 69,392 | KEEP; src/lib/font-catalog.ts:69 |
| assets/fonts/ranchers.ttf | 167,420 | KEEP; src/lib/font-catalog.ts:26 |
| assets/fonts/rocksalt.ttf | 124,372 | KEEP; src/lib/font-catalog.ts:70 |
| assets/fonts/rowdies.ttf | 76,352 | KEEP; src/lib/font-catalog.ts:71 |
| assets/fonts/rubikbeastly.ttf | 512,684 | KEEP; src/lib/font-catalog.ts:27 |
| assets/fonts/rubikbubbles.ttf | 219,564 | KEEP; src/lib/font-catalog.ts:28 |
| assets/fonts/rubikburned.ttf | 605,348 | KEEP; src/lib/font-catalog.ts:29 |
| assets/fonts/rubikdirt.ttf | 1,492,292 | KEEP; src/lib/font-catalog.ts:30 |
| assets/fonts/rubikdistressed.ttf | 892,544 | KEEP; src/lib/font-catalog.ts:31 |
| assets/fonts/rubikglitch.ttf | 407,304 | KEEP; src/lib/font-catalog.ts:32 |
| assets/fonts/rubikiso.ttf | 132,376 | KEEP; src/lib/font-catalog.ts:33 |
| assets/fonts/rubikmarkerhatch.ttf | 363,876 | KEEP; src/lib/font-catalog.ts:34 |
| assets/fonts/rubikmicrobe.ttf | 1,444,176 | KEEP; src/lib/font-catalog.ts:50 |
| assets/fonts/rubikmoonrocks.ttf | 403,712 | KEEP; src/lib/font-catalog.ts:35 |
| assets/fonts/rubikpuddles.ttf | 404,956 | KEEP; src/lib/font-catalog.ts:36 |
| assets/fonts/rubikvinyl.ttf | 414,752 | KEEP; src/lib/font-catalog.ts:51 |
| assets/fonts/russoone.ttf | 39,124 | KEEP; src/lib/font-catalog.ts:72 |
| assets/fonts/rye.ttf | 183,244 | KEEP; src/lib/font-catalog.ts:37 |
| assets/fonts/sancreek.ttf | 93,252 | KEEP; src/lib/font-catalog.ts:38 |
| assets/fonts/sixtyfour.ttf | 71,536 | KEEP; src/lib/font-catalog.ts:52 |
| assets/fonts/specialelite.ttf | 166,180 | KEEP; src/lib/font-catalog.ts:73 |
| assets/fonts/squadaone.ttf | 19,072 | KEEP; src/lib/font-catalog.ts:74 |
| assets/fonts/staatliches.ttf | 63,316 | KEEP; src/lib/font-catalog.ts:75 |
| assets/fonts/tiltprism.ttf | 1,049,672 | KEEP; src/lib/font-catalog.ts:39 |
| assets/fonts/titanone.ttf | 55,712 | KEEP; src/lib/font-catalog.ts:76 |
| assets/fonts/unifrakturcook.ttf | 42,688 | KEEP; src/lib/font-catalog.ts:40 |
| assets/images/android-icon-background.png | 451 | KEEP; app.json:23 |
| assets/images/android-icon-foreground.png | 693,320 | KEEP; app.json:22; conditional source consolidation with icon.png |
| assets/images/android-icon-monochrome.png | 9,062 | KEEP; app.json:24 |
| assets/images/favicon.png | 18,045 | KEEP; app.json:30 |
| assets/images/icon.png | 693,320 | KEEP; app.json:7 |
| assets/images/splash-icon.png | 194,850 | KEEP; app.json:49 |

PNG source-equivalence check: icon.png and android-icon-foreground.png have identical chunk ordering, IHDR, cHRM, bKGD, and every IDAT payload. Neither contains ICC/iCCP, gAMA, sRGB or pHYs chunks. Only tIME and tEXt date:timestamp differ by two seconds; creation/modification text is identical. Generated Expo resource comparison remains required.

### Appendix C: every vendor file, provenance and content role

Complete inventory, with per-file roles. KEEP security-source does not mean each file is shipped in the application; manifests/tarball contents determine npm installation and Metro/native graph determines packaged runtime.

| Vendor file | Raw bytes | Role |
|---|---:|---|
| vendor/reviewed-backports/braces/BACKPORT-PROVENANCE.json | 10,438 | KEEP integrity/provenance |
| vendor/reviewed-backports/braces/LICENSE | 1,091 | KEEP license/API/package provenance |
| vendor/reviewed-backports/braces/README.md | 21,505 | KEEP license/API/package provenance |
| vendor/reviewed-backports/braces/index.js | 4,380 | KEEP patched package source |
| vendor/reviewed-backports/braces/lib/compile.js | 1,864 | KEEP patched package source |
| vendor/reviewed-backports/braces/lib/constants.js | 1,607 | KEEP patched package source |
| vendor/reviewed-backports/braces/lib/expand.js | 3,268 | KEEP patched package source |
| vendor/reviewed-backports/braces/lib/parse.js | 7,379 | KEEP patched package source |
| vendor/reviewed-backports/braces/lib/stringify.js | 1,081 | KEEP patched package source |
| vendor/reviewed-backports/braces/lib/utils.js | 2,518 | KEEP patched package source |
| vendor/reviewed-backports/braces/package.json | 3,436 | KEEP license/API/package provenance |
| vendor/reviewed-backports/braces/test/bash-compiled-ranges.js | 7,518 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/braces/test/bash-compiled-sets.js | 7,144 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/braces/test/bash-expanded-ranges.js | 23,599 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/braces/test/bash-expanded-sets.js | 11,202 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/braces/test/bash-spec.js | 13,428 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/braces/test/braces.compile.js | 2,936 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/braces/test/braces.expand.js | 8,307 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/braces/test/braces.parse.js | 2,364 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/braces/test/braces.stringify.js | 737 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/braces/test/minimatch.js | 981 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/braces/test/multiples.js | 7,171 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/braces/test/readme.js | 1,429 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/braces/test/regression.js | 20,942 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/caption-studio-braces-backport-3.0.3-caption-studio.1.tgz | 15,197 | KEEP immutable locked distribution; locally integrity checked |
| vendor/reviewed-backports/caption-studio-node-forge-backport-1.4.0-caption-studio.1.tgz | 1,090,704 | KEEP immutable locked distribution; locally integrity checked |
| vendor/reviewed-backports/node-forge/BACKPORT-PROVENANCE.json | 24,439 | KEEP integrity/provenance |
| vendor/reviewed-backports/node-forge/LICENSE | 17,972 | KEEP license/API/package provenance |
| vendor/reviewed-backports/node-forge/README.md | 59,605 | KEEP license/API/package provenance |
| vendor/reviewed-backports/node-forge/dist/forge.all.min.js | 303,738 | NEEDS MEASUREMENT browser distribution/source map; manifest intentionally includes it |
| vendor/reviewed-backports/node-forge/dist/forge.all.min.js.map | 1,358,800 | NEEDS MEASUREMENT browser distribution/source map; manifest intentionally includes it |
| vendor/reviewed-backports/node-forge/dist/forge.min.js | 282,217 | NEEDS MEASUREMENT browser distribution/source map; manifest intentionally includes it |
| vendor/reviewed-backports/node-forge/dist/forge.min.js.map | 1,244,105 | NEEDS MEASUREMENT browser distribution/source map; manifest intentionally includes it |
| vendor/reviewed-backports/node-forge/dist/prime.worker.min.js | 20,589 | NEEDS MEASUREMENT browser distribution/source map; manifest intentionally includes it |
| vendor/reviewed-backports/node-forge/dist/prime.worker.min.js.map | 77,083 | NEEDS MEASUREMENT browser distribution/source map; manifest intentionally includes it |
| vendor/reviewed-backports/node-forge/flash/swf/SocketPool.swf | 21,162 | NEEDS MEASUREMENT legacy distribution; cannot remove from published contract untested |
| vendor/reviewed-backports/node-forge/lib/aes.js | 39,025 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/aesCipherSuites.js | 9,112 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/asn1-validator.js | 2,295 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/asn1.js | 45,406 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/baseN.js | 5,068 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/cipher.js | 6,668 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/cipherModes.js | 28,917 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/des.js | 20,445 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/ed25519.js | 25,349 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/forge.js | 200 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/form.js | 3,880 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/hmac.js | 3,833 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/http.js | 39,070 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/index.all.js | 366 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/index.js | 640 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/jsbn.js | 36,893 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/kem.js | 5,217 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/log.js | 9,264 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/md.all.js | 251 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/md.js | 253 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/md5.js | 7,983 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/mgf.js | 274 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/mgf1.js | 1,645 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/oids.js | 6,874 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/pbe.js | 30,999 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/pbkdf2.js | 5,809 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/pem.js | 6,693 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/pkcs1.js | 8,375 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/pkcs12.js | 33,596 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/pkcs7.js | 39,869 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/pkcs7asn1.js | 11,484 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/pki.js | 2,651 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/prime.js | 8,776 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/prime.worker.js | 4,805 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/prng.js | 12,326 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/pss.js | 7,854 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/random.js | 5,438 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/rc2.js | 11,949 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/rsa.js | 61,199 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/sha1.js | 9,089 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/sha256.js | 9,574 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/sha512.js | 17,133 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/socket.js | 8,329 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/ssh.js | 7,163 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/tls.js | 132,975 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/tlssocket.js | 6,967 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/util.js | 69,861 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/x509.js | 102,130 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/lib/xhr.js | 22,117 | KEEP patched package source |
| vendor/reviewed-backports/node-forge/package.json | 2,240 | KEEP license/API/package provenance |
| vendor/reviewed-backports/node-forge/tests/.eslintrc.js | 51 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/README.md | 93 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/benchmarks/aes-speed.js | 1,676 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/benchmarks/so-44303784.js | 6,863 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/flash/README.md | 188 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/flash/Test.as | 2,677 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/flash/build-flash.xml | 139 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/flash/index.html | 712 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/index.html | 1,016 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/issues/heartbleed.js | 1,436 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/issues/issue-428.html | 4,073 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/issues/issue-428.js | 12,024 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/karma/index.js | 312 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/karma/testWorker.js | 1,969 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/karma/web-worker-rsa.js | 2,004 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/legacy/common.html | 1,774 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/legacy/common.js | 71,704 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/legacy/form.html | 5,142 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/legacy/form.js | 890 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/legacy/http.html | 6,620 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/legacy/index.html | 2,024 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/legacy/keygen.html | 3,153 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/legacy/login.css | 259 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/legacy/loginDemo.html | 979 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/legacy/loginDemo.js | 4,133 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/legacy/performance.html | 16,338 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/legacy/result.txt | 16 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/legacy/socketPool.html | 10,377 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/legacy/tasks.html | 1,438 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/legacy/tasks.js | 10,349 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/legacy/tls.html | 14,704 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/legacy/webid.html | 2,532 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/legacy/webid.js | 9,062 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/legacy/ws-webid.js | 4,904 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/legacy/xhr.html | 1,880 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/legacy/xhr.js | 15,213 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/pocs/ghsa-2328-f5f3-gj25.js | 3,306 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/pocs/ghsa-ppp5-5v6c-4jwp.js | 6,284 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/pocs/ghsa-q67f-28xg-22rw.js | 3,538 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/security/cve-2025-12816.js | 2,245 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/security/ghsa-554w-wpv2-vw27.js | 2,711 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/security/index.js | 126 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/server.crt | 1,590 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/server.js | 2,638 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/server.key | 1,675 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/support/task.js | 19,576 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/tests.css | 985 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/aes.js | 51,404 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/asn1.js | 44,751 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/csr.js | 5,801 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/des.js | 8,882 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/ed25519.js | 12,588 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/forge.js | 65 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/hmac.js | 2,591 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/index.html | 549 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/index.js | 524 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/jsbn.js | 1,489 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/kem.js | 9,455 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/md5.js | 5,501 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/mgf1.js | 868 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/pbkdf2.js | 7,863 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/pem.js | 9,249 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/pkcs1.js | 81,077 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/pkcs12.js | 48,385 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/pkcs7.js | 43,872 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/random.js | 1,483 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/rc2.js | 4,062 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/rsa.js | 65,021 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/sha1.js | 2,318 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/sha256.js | 2,655 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/sha512.js | 7,693 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/ssh.js | 10,325 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/tls.js | 5,816 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/util.js | 20,961 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/unit/x509.js | 85,580 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/websockets/server-webid.js | 13,379 | DEVONLY regression/compatibility fixture; preserve backport evidence |
| vendor/reviewed-backports/node-forge/tests/websockets/server-ws.js | 4,263 | DEVONLY regression/compatibility fixture; preserve backport evidence |

Tarball integrity verification (local, read-only; no extraction/execution):

- caption-studio-braces-backport-3.0.3-caption-studio.1.tgz: 15,197 compressed bytes; 10 archive entries / 48,129 member bytes; SHA-512 matches node_modules/micromatch/node_modules/braces.
- caption-studio-node-forge-backport-1.4.0-caption-studio.1.tgz: 1,090,704 compressed bytes; 59 archive entries / 4,323,600 member bytes; SHA-512 matches node_modules/node-forge.
