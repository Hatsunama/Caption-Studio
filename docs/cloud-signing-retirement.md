# Local production signing and cloud retirement

On 2026-10-25 the existing Solana D02 key was recovered through approved run
40239617753. Both D02 and the distinct Play upload 50D key signed and verified
locally, and passed again after relocation to `C:\caption_studio\signing`.
The protected C folder retains the original keys, DPAPI passwords, encrypted
recovery backup and local proof receipt. The completed encrypted Actions artifact
was deleted after local proof. No new production key or certificate was generated.

After both local private-key proofs, the four original repository signing secrets
were removed. The repository and `github-pages` environment each reported zero
remaining secrets. The three legacy workflow IDs are disabled manually. This PR
also replaces their source with the fail-closed tombstones below. These operational
facts were checked separately from source tests; possession of a certificate or a
passing unit test alone was not accepted as private-key proof.

The published 1.4.135 APK/AAB bytes remain unchanged. Actual future unsigned/local
pipeline verification is incomplete: run 40239905976 passed source, native build
and artifact checks but failed creating its final output because `dist` was absent.
The clean-checkout regression reproduced that ENOENT; this PR creates the parent
while retaining exclusive final-output ownership. The local producer/signer suite
then passed 28/28. A successful fresh trusted-main unsigned build and full local
APK/AAB signing remain required after the owner merge, before this replacement
pipeline is accepted. New releases additionally require exact-artifact device tests.

`publish-sidecar.yml`, `verify-play-aab.yml` and `recover-local-signing.yml` retain
their filenames as manual compatibility tombstones. Each has empty permissions
and one unconditional Bash refusal with exit code 1. There are no secret or token
references, checkout, dependency installation, native builds, signing or uploads.
GitHub does not trigger them for other events; even if evaluated for another
event or rerun after failure/cancellation, the only step still refuses.

Future releases use `.github/workflows/unsigned-store-build.yml` followed by
`scripts/local-signing/sign-release.ps1`. Follow
[unsigned build instructions](unsigned-local-release-build.md) and
[local signing instructions](local-release-signing.md). These edits do not authorize
a build, signing run or publication. D02 remains the APK identity; the distinct
50D role in `config/local-signing-contract.json` is authoritative for new Play AABs.
The retired `verify-play-aab.mjs` CLI fails before reading configuration or creating
files. Its pure exports remain historical D02 evidence and mapping test utilities.

| Previous responsibility | Current owner and regression coverage |
| --- | --- |
| Trust boundary, no unintended publication | Three exact tombstones; `cloud-signing-retirement.test.mjs` and dependency-free `test-private-artifact-gate.mjs` |
| Source, package/version, published-history monotonicity | Unsigned producer; `android-package-transition`, `sidecar-release`, `play-aab-release-gate`, `unsigned-store-build` tests |
| First-party lint and all owned native unit tasks before packaging | Unsigned workflow and CI; `android-lint-scope`, `android-release-gate`, `sidecar-workflow-structure` tests |
| ABI, 16 KiB ZIP/ELF alignment, bundletool, exact embedded R8 mapping | Unsigned producer and local validator; `unsigned-store-build`, `local-release-signing`, `play-aab-mapping` tests |
| Separate APK/Play signer roles, signature and provenance checks | Local tools; `local-release-signing` tests; historical D02 parsing remains explicitly historical |
| Recovery encryption, pins, payload allowlist, cleanup and redaction | Retained synthetic Python acceptance through `signing-recovery.test.mjs`; no active cloud exporter |

The gate harness uses only Node built-ins. Its exact small YAML grammar rejects
extra jobs, commands, permissions, aliases and conditional bypasses. It executes
each extracted refusal for seven event contexts and success/failure/cancelled/
recovery statuses (84 cases). No pinned historical commit or dependency install is
needed. The caller runs the same harness in its status matrix.

Tests here are synthetic/source checks. They do not establish hosted Actions
execution, possession of real keys, actual secret removal or store acceptance.
The exact [Expo 57 docs](https://docs.expo.dev/versions/v57.0.0/) required by AGENTS
were read before edits.

Validation on Windows, 2026-10-25:

- Red first: initial five retirement tests failed against the original active
  workflows, CLI and history-dependent harness (0 passed, 5 failed).
- Serial affected suite: 42 passed, 0 failed, 0 Node skips (42.525 seconds).
  Included retirement, sidecar structure/release, Play gate/mapping, recovery,
  Android lint/package/native-task gates and unsigned producer tests.
- Final serial rerun after assertion refinements: 25 passed, 0 failed, 0 skips
  (12.686 seconds): retirement, sidecar release, Play gate, ABI and CI alignment.
- Local-validator pure subset: 3 passed, 0 failed, 0 skips (0.418 seconds):
  source-bound provenance, published baseline and distinct certificate roles.
- Recovery subprocess: 23 Python tests discovered, 22 passed, 1 existing Windows
  skip for POSIX modes/symlinks; original security acceptance remains unchanged.
- Direct retirement harness: 84 behavioral cases passed.
- `git diff --check` passed. No application, dependency, model, unsigned producer
  or parent-owned local-signing files changed. No repository commit/push performed.

All Node commands used the existing
`../release135-final-20261024/security-patches/tools/node-v22.23.4-win-x64/node.exe`
with `--max-old-space-size=64`; multi-file tests used `--test-concurrency=1`.
Recovery selected `C:/Python311/python.exe` and existing Git OpenSSL; the refusal
harness selected existing Git Bash. No dependency installation or local Gradle ran.
Hosted final-head checks and a successful fresh trusted-main unsigned/local
signing proof remain acceptance prerequisites; synthetic tests do not establish them.

Changed files (17):

- `.github/workflows/publish-sidecar.yml`
- `.github/workflows/verify-play-aab.yml`
- `.github/workflows/recover-local-signing.yml`
- `.github/workflows/private-artifact-gate-test.yml`
- `scripts/verify-play-aab.mjs`
- `scripts/test-private-artifact-gate.mjs`
- `tests/cloud-signing-retirement.test.mjs` (new)
- `tests/android-lint-scope.test.mjs`
- `tests/android-package-transition.test.mjs`
- `tests/android-release-gate.test.mjs`
- `tests/play-aab-release-gate.test.mjs`
- `tests/sidecar-release.test.mjs`
- `tests/sidecar-workflow-structure.test.mjs`
- `tests/signing-recovery.test.mjs`
- `docs/cloud-signing-retirement.md` (new)
- `docs/local-signing-recovery.md`
- `docs/play-aab-release-gate.md`

## Runner JDK cache follow-up (2026-10-30)

Unsigned run 41154200235 stopped before compilation at the Java truststore guard.
The diagnostic run 41154944241 identified the rejected component as
`/opt/hostedtoolcache/Java_Temurin-Hotspot_jdk/17.0.21-9/x64`; the setup log showed
that Java 17 had been reused from the runner tool cache. The strict link rejection
was correct, and the build-tool error now identifies its offending component.

All 14 Java setup steps across the six active Java workflows now request the same
pinned JDK 17/21 archives with `force-download: true` and
`verify-signature: true`. JDK archive caching is explicitly disabled with
`cache-jdk: false`; existing Gradle dependency caches remain enabled where already
configured. The action replaces the cache entry from the downloaded archive. We
keep the existing containment, no-link, certificate filtering, backup/rollback and
Java/Gradle override guards intact instead of accepting the linked runtime.

These options were checked against the exact pinned action's
[action inputs](https://github.com/actions/setup-java/blob/b843ebf9b913146b38da2eaa7aeddf76074ae1ad/action.yml),
[installer](https://github.com/actions/setup-java/blob/b843ebf9b913146b38da2eaa7aeddf76074ae1ad/src/distributions/base-installer.ts)
and [cache placement](https://github.com/actions/setup-java/blob/b843ebf9b913146b38da2eaa7aeddf76074ae1ad/src/util.ts).
Fresh vendor downloads add network work; no performance improvement is claimed.
Hosted execution must still prove that the fresh runtimes pass the unchanged
truststore guards, followed by the full required checks. The complete unsigned
build/local original-key signing test remains an acceptance requirement after the
repair reaches trusted main. Published 1.4.135 artifacts remain unchanged.