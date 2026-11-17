# R8 release optimization verification

Starting main/source: 55e3fa0fbb62f41d23f954cb60e3dda6edbb3e4d.
Working branch: fix/r8-release-optimization-20261117.
The pre-existing untracked evidence/ directory is preserved.

## Confirmed baseline

The published 1.4.145 Play AAB (versionCode 157), SHA-256
7c84f4f37b9bde6feaa7de8f939f891b2ecb79948fd9546c546977bb9ad2104b,
contains BUNDLE-METADATA/com.android.tools/r8.json reporting
isOptimizationsEnabled: false, noOptimizationPercentage: 100,
isShrinkingEnabled: true, and isObfuscationEnabled: true.
The exact bundle has 3 DEX files totaling 19,380,916 uncompressed bytes.
Existing checks required minification, resource shrinking and an exact mapping,
but did not require actual optimization.

Expo's local 57.0.32 template selects proguard-android.txt; the installed RN
0.86.3 selects AGP 8.12.0, whose default includes -dontoptimize. Local Expo
dependencies predate the current locked 57.0.33 version, so the clean hosted
npm ci and native prebuild remain authoritative for the final release.
The configurator previously left this default untouched.

## Repair and connected impact

Use Android's standard proguard-android-optimize.txt in release builds.
Preserve project and dependency JNI/reflection keep rules and debug behavior.
Verify the generated release configuration and reject explicit disabling rules.
Validate actual embedded R8 metadata and bind it to both APK/AAB DEX payloads.
Apply that artifact check before CI binary retention, unsigned producer
publication and local signing. Existing unsigned-source approval, alignment,
mapping, certificate, payload-preservation and native-test gates remain required.
Historical source-pinned retired release helpers retain their historical contracts.

The affected runtime boundary is Java/Kotlin bytecode, including Expo module
registration, React Native/Hermes integration, media rendering/export and local
AI native bridges. No interface, Expo version, model, project data
format or signing-key changes are authorized in this batch.

## Acceptance

- Regression tests reject disabled/missing/malformed optimization evidence and
  mismatched DEX inventories; an honestly optimized, partially kept build passes.
- The published 1.4.145 bundle is a negative control for the new artifact guard.
- GitHub runs locked source checks, release lint, all existing native unit tests,
  and the actual optimized release APK/AAB build.
- New immutable unsigned provenance binds the approved main source and outputs.
- Original, distinct signing keys remain on C; signed payloads are unchanged
  except for the required signing structures.
- Cold-start both exact final artifact forms on Samsung and Seeker. Exercise
  native-backed caption generation and optional translation, save/reopen,
  multi-clip playback with overlays and audio, and an MP4 export. Include one
  portrait/landscape rotation and background/resume path, reuse existing source
  videos, and remove only newly created test exports.
- Compare build size/DEX bytes and actual R8 percentages with the baseline.
  Do not promise a speed or memory improvement without measurements.
- Keep the old verified release intact. Publish new links only after the new
  final artifact checks pass on both phones.

## Evidence and current status

Local artifact/source inspection completed; new regression tests were authored
before the corresponding source changes. Local Node tests are deferred while
physical free memory is below the established 768 MiB gate. Full clean hosted
checks, actual optimized artifact measurements, local signing and both-phone
verification are still pending. This record must be updated with exact
commit/run/artifact identities and results before acceptance.

Primary references checked 2026-11-17:
- https://developer.android.com/google/play/vitals/code-optimization
- https://developer.android.com/topic/performance/app-optimization/enable-app-optimization
- https://docs.expo.dev/versions/v57.0.0/
The fresh security gate also requires the separately recorded compatible Picomatch backport in picomatch-security-backport.md; no unrelated dependency update is included.
