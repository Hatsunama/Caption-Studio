# Cloud signing retirement proposal

These working-tree edits are not active on main. Parent reports original D02
private-key sign/verify proof completed on C after recovery run 40239617753;
50D Play proof had already succeeded. Parent retained the encrypted C backup and
deleted the recovery artifact after proof. Parent also reports the three legacy
workflow IDs are now `disabled_manually`. This follow-up does not inspect keys or
independently establish those remote facts.

The four original signing secrets remain retained pending full unsigned/local
signer pipeline proof. Parent reports future unsigned 1.4.136/code 148 build
40239905976 running on main e4e8aef without secrets. Parent alone owns that run,
Actions changes and eventual secret removal. Published 1.4.135 APK/AAB bytes remain
immutable. Key recovery no longer blocks review of this retirement proposal.

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
The remaining validation gap is hosted follow-up workflow execution and parent's
full unsigned/local signer pipeline proof; this task does not establish either.

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
