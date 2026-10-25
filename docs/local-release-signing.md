# Future local Windows production signer

This is an additive signer for future unsigned producer artifacts. Run
`scripts/local-signing/sign-release.ps1` locally on Windows with Windows
PowerShell 5.1 or PowerShell 7. It performs no downloads, builds, uploads,
publication, credential recovery, or GitHub secret deletion. The verified public
1.4.135 APK/AAB must remain unchanged. The public contract records that published
version as code 147. Versions through 1.4.135 and codes through 147 are refused; the parent must independently choose a new version/code above
all published and unpublished store submissions. This offline signer cannot
establish store history or authenticate an unsigned provenance document by itself.

## Inputs and invocation

Supply the four files from `unsigned-store-build.mjs` together with the expected
source commit and Actions run ID obtained independently from the trusted owner
main dispatch. Do not derive those expectations from the downloaded JSON. Require
the successful trusted producer job and independently verify its artifact origin.
The signer consumes the actual schema in `docs/unsigned-local-release-build.md`,
including source tree, workflow/ref, run attempt, producer checks, byte counts and
all three payload hashes. It does not accept the older frozen 129/141 provenance.

Use explicit absolute paths for each tool and file. Example with placeholders
(this command has not been run against production credentials or release files):

```powershell
& .\scripts\local-signing\sign-release.ps1 `
  -UnsignedApk 'C:\future-input\caption-studio-UNSIGNED-not-installable.apk' `
  -UnsignedAab 'C:\future-input\caption-studio-UNSIGNED-not-installable.aab' `
  -Mapping 'C:\future-input\mapping.txt' `
  -Provenance 'C:\future-input\provenance.json' `
  -ExpectedSourceCommit '<independently-approved-40-hex-commit>' `
  -ExpectedRunId '<independently-approved-run-id>' `
  -OutputDirectory 'C:\future-output\new-release' `
  -JavaBin 'C:\tools\jdk17\bin' `
  -BuildTools 'C:\Android\Sdk\build-tools\36.0.0' `
  -Bundletool 'C:\tools\bundletool-all-1.18.3.jar' `
  -NodePath 'C:\tools\node22\node.exe' `
  -PythonPath 'C:\Python311\python.exe'
```

The output parent must already exist; the output directory must not exist, even
if empty. Inputs, output and tool paths must be on fixed local C with no reparse
points. Output cannot overlap inputs or the key root. No input is rewritten.
`GITHUB_ACTIONS` being present, including an empty value, refuses execution.
There are no CLI or environment certificate-pin overrides.

`-KeyRoot` defaults to the canonical `C:\caption_studio\signing`, independent of
`USERPROFILE`. Explicit `-KeyRoot` paths remain supported for synthetic tests and
checks and must resolve to local C without links. The relocated protected root
has not been accessed for this default-path correction. Expected profiles:

| Role | Files below key root | Password format | Alias |
| --- | --- | --- | --- |
| APK D02 | `solana-release\key.p12`, `solana-release\store-password.dpapi`, `solana-release\key-password.dpapi`, `solana-release\alias.txt` | Raw `ProtectedData.Protect(CurrentUser)` over original UTF-8 bytes | Exact alias file contents |
| Play upload 50D | `caption-studio-play-upload.p12`, `caption-studio-play-upload.password.dpapi` | Existing `ConvertFrom-SecureString` CurrentUser DPAPI hex; same store/key password | `caption-studio-play-upload` |

Both readers support both formats. Only outer encrypted hex whitespace/BOM may be
removed; plaintext passwords are never trimmed. AES-key SecureString formats,
plaintext, malformed blobs and DPAPI LocalMachine blobs are rejected. Passwords
are read only after unsigned artifact checks pass. Input and profile file handles
deny concurrent writes/deletes for the transaction. Recovery/import is separate;
the importer was consulted read-only to confirm raw UTF-8 DPAPI compatibility.

The public-only `config/local-signing-contract.json` pins distinct certificate
roles and the known published version/code baseline. Both version comparisons
come from that baseline; independent store-history checking remains required. APK D02 is checked against `config/product-contract.json`; Play upload is
50D. Wrong role, migration or debug lineage cannot substitute. Certificate
presence in a keystore is only a preflight: final artifact verification must pass.

## Validation and publication

The signer checks JDK 17's release descriptor, build-tools 36.0.0, and the exact
bundletool 1.18.3 SHA-256 imported from the producer. Child tools use explicit
paths and a minimal environment without inherited Java options or unrelated
credentials. Node has a 64 MiB heap; Java has a 96 MiB maximum heap and one active
CPU. Children receive passwords only through their own environment. Both output
pipes are drained concurrently and failures disclose no tool output or argv.
Each outer signer/validator invocation is limited to five minutes; each internal
verification adapter is limited to three minutes. Timeout or cooperative
cancellation terminates the retained child process tree before staging cleanup.
On Windows, termination uses the exact owned PID with `taskkill /T /F` after a
lifecycle check, with bounded termination/drain waits. No process enumeration,
shared ADB operation, or global process kill is used. Shorter timeouts are internal
fixture arguments; request JSON, CLI and environment cannot override these limits.
Environment copies are cleared, BSTRs are zero-freed, decrypted byte buffers are
cleared and SecureStrings disposed. Windows/.NET immutable string/environment
copies can remain until reclaimed; this is not a claim of whole-process memory
zeroization. No plaintext password files or signing property files are created.

Before signing, actual ZIP members are streamed and hashed. Unsafe paths,
duplicates, encrypted/nonregular entries, JAR signature files/digests and the APK
v2/v3 signing block at the central-directory boundary are refused. Shared unsigned
and ABI rules are reused. APK badging and bundletool manifest dumps must match
the exact production package, version/code, min SDK 24 and target SDK 36. Bundle
validation and `PAGE_ALIGNMENT_16K`, APK `zipalign -c -P 16 -v 4`, and every
64-bit native library's ELF LOAD alignment are checked. The ELF reader applies
the existing script's 64-bit LOAD alignment rule using Python's standard library,
without extraction or an NDK dependency. The nonempty generated mapping's hash
must equal the embedded AAB mapping's hash.

Only exclusive copies in a fresh sibling staging directory are signed. Java
apksigner signs the APK with D02 and v2/v3, with v1/v4 disabled; jarsigner signs
the AAB with 50D using SHA-256/RSA and no timestamp service. After signing, native
identity, ZIP alignment and bundletool checks run again. Apksigner must verify
exactly one pinned nondebug signer and both v2 and v3. Java JarFile verification
streams every AAB payload member, requires exactly one actual signer per member,
the pinned 50D leaf certificate, certificate validity and a nondebug subject;
unsigned appended entries fail. A keystore certificate listing or mocked output
never counts as signature verification.

Every ZIP entry's uncompressed-byte SHA-256 is compared before/after, excluding
only root `META-INF/MANIFEST.MF` and exact JAR signature metadata patterns
(`*.SF`, `*.RSA`, `*.DSA`, `*.EC`, `SIG-*` directly under `META-INF`). Licenses,
services, native libraries, assets, profiles and mapping remain in the comparison.
The generated mapping is retained unchanged. Signing cannot silently rewrite
payloads. Final input hashes are checked again before publication.

The final local directory appears through a single Windows `Directory.Move`
after all checks; that primitive refuses existing destinations. Ordinary failures
delete only this invocation's owned staging directory. A killed process can leave
a sibling `.local-signing-pending-*` directory; it is not a successful release.
Do not consume pending directories. No production key material is staged.

Final contents:

- `caption-studio-android.apk`, `caption-studio-play-android.aab`, `mapping.txt`
- SHA-256 sidecars for those three payloads
- `source-signature-receipt.json`, binding source/run/tree, unsigned provenance
  hash, certificate roles, payload hashes and completed local checks
- `caption-studio-release.json`, schema 1, validated by the same
  `validateReleaseMetadata` used by `configure-sidecar-release.mjs`

The receipt always says `runtimeVerification: REQUIRED`,
`deviceTests: NOT_PERFORMED`, `storeReady: false`, `published: false`. The sidecar
metadata is a compatible identity/hash record, not permission to publish.

## Cloud responsibilities replaced and remaining proof

For a future approved workflow transition, local signing replaces cloud access
to production private keys/passwords, cloud APK/AAB signing, and cloud signed
artifact verification/receipt creation. The unsigned producer retains source
approval, clean native build, dependency/security checks, unit tests, R8 mapping,
ABI/ELF and unsigned artifact provenance responsibilities. This change does not
edit any workflow or disable its current signing/publishing behavior. The parent
must complete its separate reviewed transition before retiring that behavior.

Keep GitHub production signing secrets until the parent has recovered both
original keys on C, proved private-key signing with the original D02 and 50D,
and run this full signer against a trusted future unsigned build. Secret removal
is a separate parent action after those local proofs. This signer never deletes
secrets or claims their deletion. Original Solana recovery/main integration was
still pending when this signer was implemented.

After actual production signing, independently verify certificate pins, hashes,
source and store version ordering, and retain mapping/receipts. Device update
compatibility, install/launch on the Seeker, project/data preservation, editing,
translation, export and the original release runtime gates remain required. Play
upload acceptance and applicable store checks also remain separate. No local
receipt claims device tests or store readiness.

## Acceptance evidence and limits

Review regression tests were added before runtime fixes. The baseline test failed
with `Missing expected exception` for code 146. The portable-load test failed with
`ERR_INVALID_ARG_TYPE` after removing `SystemRoot`. Timeout tests failed because
the bounded runtime adapter and PowerShell timeout argument were absent. The
baseline regression covers 146/147 rejection and 148 acceptance.

Tests use temporary synthetic inputs and keys only. Core provenance, hashes,
archive safety, payload preservation and injected native-identity failures run
across platforms, using a discovered absolute Python 3 interpreter. Only actual
Windows crypto, DPAPI, process/publication and production-entry tests are guarded
on other operating systems; the entire file is never skipped. The production CLI
remains Windows-only. Both DPAPI formats preserve original plaintext spaces.

The controlled timeout fixtures record owned parent/descendant PIDs and a delayed
success sentinel. They require both processes to be gone, sanitized failure,
unchanged inputs, no published directory and no owned pending directory after
cleanup. The Windows fixture supplies only a synthetic password, confirms it did
not reach the parent environment, and refuses to report success after timeout.
JavaScript cancellation is also exercised through its registered SIGTERM handler.
Forcefully terminating the host prevents its finally blocks from running; such
an interruption can leave pending staging and never establishes a successful release.

Run just this focused file serially, without dependency installation:

```text
node --max-old-space-size=64 --test --test-concurrency=1 tests/local-release-signing.test.mjs
```

Final focused Windows run: **15 passed, 0 failed, 0 skipped**, in 35.618 seconds.
Node syntax and scoped whitespace checks passed; tracked files and the Git index
were unchanged. The full source suite was not run.

Windows validation uses Node 22.23.4 with a 64 MiB heap, Windows PowerShell 5.1,
Java 17 and build-tools 36.0.0. Synthetic JAR/APK signatures must verify and reject
the production pins; tampered JARs and appended unsigned members must fail.
These tests do not prove original-key signing or real Android identity/bundletool
validation. Linux execution remains unverified on this Windows host; the missing
Windows-environment load regression runs here, but is not a Linux execution claim.

The full original-key production flow, actual future APK/AAB native identity,
bundletool/16 KiB results, device/runtime checks, and independent store-history
proof remain prerequisites. No private directory, real credentials, actual release
files, GitHub secrets, Gradle, uploads, commits or pushes were accessed or run for
this review. AGENTS and its exact online Expo 57 documentation were read. No
importer, workflow, application or dependency files changed.

## Canonical root correction validation (2026-10-25)

The parameter-default regression was added before the correction. It parses the
production PowerShell `ParamBlock` and executes it with a harmless output-only
body and synthetic mandatory arguments. Before the fix, the two synthetic
`USERPROFILE` values produced two profile-relative `.caption-studio-signing`
paths, failing the expected `C:\caption_studio\signing` assertion. After the fix,
both resolve to the canonical root, and an explicit synthetic `-KeyRoot` with
spaces is preserved. The harness never executes the production signing body or
opens the resolved key root.

The targeted regression passed after the fix. The full synthetic release-signing
file passed **16 tests, 0 failures, 0 skips** in 29.320 seconds; the unchanged
key-import test file then passed **7 tests, 0 failures, 0 skips** in 18.379 seconds.
Both ran serially with `--max-old-space-size=64 --test --test-concurrency=1`, using
Node 22.23.4 from
`C:\caption_studio\workspace\release135-final-20261024\security-patches\tools\node-v22.23.4-win-x64\node.exe`.
Each command set process-local `TEMP` and `TMP` to `C:\caption_studio\tmp`.
Release tests derived Java 17 from the sibling bundled JDK and SDK build-tools
36.0.0 from `LOCALAPPDATA`. Callers can override synthetic tools through
`LOCAL_RELEASE_TEST_JDK` (or `LOCAL_IMPORT_TEST_JDK`) and
`LOCAL_RELEASE_TEST_BUILD_TOOLS`; production tool validation is unchanged.
The importer run explicitly supplied `LOCAL_IMPORT_TEST_JDK` for that same JDK
and `LOCAL_IMPORT_TEST_OPENSSL` for `C:\Program Files\Git\usr\bin\openssl.exe`.
Node syntax and scoped whitespace checks passed.

Only `scripts/local-signing/sign-release.ps1`,
`tests/local-release-signing.test.mjs`, `docs/local-release-signing.md`, and
`docs/local-key-import.md` changed for this correction. Earlier evidence above
describes its original runs and has not been rewritten to imply relocated paths.
No protected production directory or real key/DPAPI material was accessed.
Full production APK/AAB signing with the new default remains the parent's step.
