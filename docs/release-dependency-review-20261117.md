# Final release dependency review â€” 2026-11-17

Starting main: `2f5969791d1852273825684d5c272a3394572a67`, tree
`dc1460809809ed72301257df376da7b165269dfd` (merged PR #169).
Expo 57, the pinned model/runtime, application behavior, signing certificates,
and existing verified public artifacts remain protected.

## Decisions and impact

| Candidate | Decision | Evidence and boundary |
| --- | --- | --- |
| Gradle 9.4.0 | Adapt to fixed 8.14.7, subject to complete native CI | [Official release](https://docs.gradle.org/8.14.7/release-notes.html), [catalog advisory](https://github.com/gradle/gradle/security/advisories/GHSA-3cfg-jpcr-gfp3), and official distribution checksum. Configure/verify the generated wrapper; retain R8, SDK and credential guards. This is a build-tool change, not a claim of an Android runtime exploit. |
| Private Forge 1.4.0 backport | Replace only its override/lock node with exact official 1.4.3 | The previous RSA repair is useful but does not contain all subsequent fixes. [Upstream changelog](https://github.com/digitalbazaar/forge/blob/v1.4.3/CHANGELOG.md). Existing RSA vectors and actual Expo certificate/CLI consumers remain covered. Invalid X.509 chains may now correctly fail stricter validation. See `node-forge-143-security.md`. |
| Okio catalog 2.9.0 | Already resolved above this advisory's fixed range; no override | Successful CI 44021664098 artifact 14304712573 SHA-256 `cb3467742f1be8dc1eeb08fbc7c0d26468d41067a6f4471bb4e19e8db0816897`: `app-kotlin-stdlib-runtime.txt:7360â€“7366` resolves Okio/okio-jvm **3.16.0**, not requested 2.9.0. Recheck the final graph. |
| Kotlin/KAPT | Retain compiler pins; conditional tooling exposure recorded | [Primary fix](https://github.com/JetBrains/kotlin/commit/bf51df665b458fda7c3eaf436c4d88dc119d7ec6) concerns KAPT incremental-cache deserialization. `expo-image/android/build.gradle` declares KAPT, correcting the initial negative search. This build uses published Expo Image; its complete successful log emitted 1,144 distinct tasks and no KAPT tasks. No active vulnerable cache read or shipped Android flaw was demonstrated. Source-module/processor changes require reassessment; compiler version is not claimed patched. |
| Media3 1.11.1, other optional library/tool patches | Defer from this security batch | [Media3 notes](https://developer.android.com/jetpack/androidx/releases/media3#1.11.1) include an API removal and conditional playback changes. No demonstrated app defect requires this upgrade. Preserve the just-verified native behavior rather than calling metadata alone proof of safe compatibility. Newer major/minor lines do not override Expo/model constraints. |

The public npm bulk audit checked 834 resolved name/version pairs and returned
no advisories. Private aliases were reviewed separately: a clean registry audit
is not proof that a private fork contains later upstream security fixes.

## Observed regression baseline

Tests-only commit `1819e37e72cad4c2e44a1abbda5bed127a475c81`,
[CI 44042924596](https://github.com/Hatsunama/Caption-Studio/actions/runs/44042924596),
job 133901615512: **4,202 tests; 4,182 passed, 11 failed, nine Windows-specific
signing/process cases skipped on Linux**. The 11 failures were exactly the Forge
identity-key forgery and ten Gradle version/active URL/checksum cases. Existing
RSA, honest-signature, real Expo consumers, and credential/minify/SDK controls
passed. Production files were unchanged before this observed RED.

The first update (9ccfd456) passed all 11 original security regressions. Its
logic gate exposed two integration defects: the compatibility script was imported
relative to the repository root without its tests/ prefix, and the retained
whole-graph fingerprint had not incorporated the independently verified Forge-only
change. Both were corrected; every other package/field remains covered by the
fingerprint, with no new exclusions. That run is not accepted as GREEN.

The new Forge test exercises only the installed graph; it contains no alternate
package loader. The existing dependency API compatibility script is also wired
into normal logic-test discovery without changing its assertions.

## Acceptance and recovery

Pending: fresh locked installation, complete logic/build-tool/type/lint/Expo
and native release gates, exact final source/graph review, then the trusted-main
unsigned build. Gradle 9.9.1 was rejected by actual native CI 44045592119: AGP 8.12.0 uses
the InternalProblems API removed in Gradle 9.6. The compatible-component
candidate is official security-fixed 8.14.7, retaining AGP 8.12.0, R8 8.13.19
and existing Kotlin preparation. [JetBrains' matrix](https://kotlinlang.org/docs/gradle-configure-project.html)
supports these KGP versions on 8.14.7; [AGP 8.12](https://developer.android.com/build/releases/agp-8-12-0-release-notes)
requires Gradle 8.13 or newer. Complete project compatibility still needs native CI.
No internal-API shim, compiler suppression, or AGP major migration is introduced. Local installed
Expo modules predate the lock and cannot substitute for clean CI evidence.

After normal main integration, sign locally on C: using the original distinct
Solana and Play keys, verify signatures/payloads/provenance, and cold-start/test
the exact APK and AAB-derived APKs on both phones. Exercise only affected paths;
reuse existing test media. No publication or installation recommendation until
those release gates pass. These dependency changes require no stored-data
migration. A failed validation blocks acceptance; do not suppress tests or
bypass repository protections to ship.
