# Caption Studio 1.4.8 audit

## Device evidence

Seeker SM02G4061962301, Fixed 1.4.7: a 37-cue Chinese translation returned with 12 cues requiring refresh. Choosing Rendered MP4 returned to the timeline without a visible error. This reproduced a preflight failure, not proof of a native encoder crash.

## Repairs

- Replaced proportional translation-document splitting with identity-preserving per-cue translation and surrounding context.
- Persisted successful and failed results together. Failed attempts show FAILED - RETRY, retain existing text, and produce an incomplete-translation summary.
- Prevented cancellation during model repair from becoming success.
- Added explicit export failure alerts and retained meaningful long errors.
- Excluded disabled and off-timeline captions from MP4 readiness checks.
- Preserved independently visible translations in SRT/ASS when primary cues are hidden.
- Serialized draft read/write/clear operations and exposed filesystem read/write failures.
- Restored translation controller lifecycle initialization during React development-effect remounts.
- Pointed README phone-download routes and the data-preserving installer at the fixed release, not stale production latest.

## Coverage and remaining work

The existing 252 logic tests covered timeline selection and trim isolation, clip remapping, transitions, media ownership, persistence, caption styles/animations, export contracts, translation identities, cancellation, and signing configuration. All passed before this repair despite the reproduced defect. Added behavioral regressions cover partial translation commit/retry, failed status, export visibility, independent subtitle delivery, and journal ordering.

Inspection also covered translation/model lifecycle, project snapshots and recovery, media-permission retention/deletion, export storage/delivery, and native caption parsing/rendering. This is not exhaustive proof of correctness. Semantic translation quality, successful dual-language MP4 playback on the updated Seeker, and interruption behavior still need release-device verification. Journal filename collisions for unusually long historical identities remain a migration concern; existing journals were not renamed or deleted.

Release CI runs JS tests, TypeScript, lint, Expo compatibility, dependency audit, native media and translation tests, and APK version/signature/alignment checks. Android builds run on GitHub to avoid local SDK/build storage. Signing keys and phone projects are not cleanup targets.

Local repaired-source results: 256 logic tests passed, TypeScript passed, lint passed, and installer PowerShell parsing passed. Local production dependency audit reported six moderate advisories, no high-severity advisories. The suggested forced dependency downgrade was not applied. Local Expo compatibility checking found installed node_modules older than the committed lockfile; the clean release build validates the locked versions. A mocked Windows installer execution was blocked by the execution environment and is not reported as tested.
