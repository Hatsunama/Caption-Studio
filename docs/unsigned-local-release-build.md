# Future unsigned release producer

This additive producer is prepared for a future trusted main commit. It does not
sign, publish, activate a signer, change repository secrets, recover credentials,
or replace the verified public 1.4.135 APK/AAB. The existing frozen 129/141 AAB
workflow and its source pins remain independent.

The parent must first verify both original signing keys on C before proceeding
with its separate local signing phase. This producer neither accesses keys nor
implements that phase. Source configuration, Expo 57, models, dependencies and
application behavior remain governed by the existing product contract.

## Invocation and authority

After review and integration into main, the exact repository owner `Hatsunama`
may manually dispatch `unsigned-store-build.yml` on main with `version` and
`versionCode`. There is no source-ref input. Both initial and rerun actors must
be the owner. The native job asserts repository, owner, event, ref, workflow ref,
SHA and canonical input syntax before checkout, then checks out precisely
`github.sha` with credentials persistence disabled. The script repeats the
authority checks and binds the checkout HEAD and tree to the dispatched SHA.

Canonical version/range validation and the exact name, slug, scheme, package,
version, versionCode and production channel stamp use `configureSidecarApp`.
Only the runner's `app.json` is stamped, after source checks. The final stamp
must match the transformation of `git show HEAD:app.json` exactly. Other tracked
changes, including lockfile changes, cause rejection.

The only explicitly exposed built-in token is scoped to the shared read-only
published-history check, which rejects reused/non-increasing versions and codes
and fails on unavailable or invalid history. Checkout uses the action's normal
read-only source access without persisting its credential. No production secret,
signing credential, publishing permission or artifact download credential is
supplied. Read-only history cannot establish unpublished Google Play version
codes; the parent must account for those separately before selecting a code.

## Safety and validation responsibilities

This workflow adds a producer; it does not replace existing CI, PR, device,
product, native-test or release responsibilities. PR runs execute synthetic
tests only, without dependency installation or native builds. Only an owner
main dispatch can reach the actual native job.

The native job retains `npm ci`, product-contract verification, production
dependency audit, all logic tests, TypeScript, lint, Expo install checks and
the pinned Expo doctor. It performs a clean prebuild, the existing Gradle patch
and original native configuration verification, original release lint with the
first-party lint init script, and all four existing release unit-test tasks.
Both assembleRelease and bundleRelease use the unchanged unsigned init script.
Injected property credentials and direct/Gradle-prefixed environment credentials
must fail behaviorally for the established credential families. Failures must
contain the specific unsigned-credential rejection, so an unrelated Gradle
failure cannot satisfy this test. Native reports are retained even on failure.

The verifier reuses the shared unsigned archive/digest, signing-input, mapping
and ABI rules without using the frozen source approval or identity functions.
APK checks adapt only the manifest entry name for the shared archive verifier.
ZIP paths and symlinks are rejected before extraction. APK signing blocks at the
central directory boundary are rejected in addition to JAR signing files/digests.
Both archives must have the exact package, requested version/code, min SDK 24
and target SDK 36. ABI coverage retains the translation library's 64-bit exception.
APK zipalign checks use `-c -P 16 -v 4`; the existing ELF alignment script checks
both APK native libraries and AAB native bytes. Bundletool 1.18.3 is SHA-256
pinned, validates the bundle, and must report `PAGE_ALIGNMENT_16K`. The embedded
AAB mapping must exactly match the generated nonempty R8 mapping. Both native
outputs are built in the same Gradle invocation so they share release R8 output.

## Output contract

The artifact is explicitly `UNSIGNED-not-installable`. Its directory contains:

- `caption-studio-UNSIGNED-not-installable.apk`
- `caption-studio-UNSIGNED-not-installable.aab`
- `mapping.txt`
- `provenance.json`

Public provenance records the source commit/tree, workflow/run identity,
package/version/code, unsigned status, validation results, payload names, byte
counts and SHA-256 hashes. It contains no credentials or local key paths.

The output directory must not exist, even if empty. Files are copied exclusively
into a pending directory and their hashes are compared with verified source
payload hashes. Atomic exclusive hard links expose payloads, then provenance
as the final commit marker after all final payload hashes match. Ordinary
failures remove the newly reserved output directory; existing output is never
overwritten. A process termination can leave an incomplete directory without
provenance. Consumers must require provenance and independently rehash all three
payloads; a directory without its final marker is never a successful release.
No success artifact upload runs after a failed verification step.

## Verification evidence and remaining runtime work

The first acceptance run failed with `ERR_MODULE_NOT_FOUND` before the producer
existed. The executable synthetic suite covers canonical/authority rejection,
real Git HEAD/tree and exact stamp enforcement, unsigned archive/signature and
mapping failures, tool command failures, actual copied-byte/provenance hashes,
copy corruption/failure, missing payloads and output overwrite refusal. Run it
without installing dependencies (Node 22 and Python 3 are required; both are
already present on the hosted runner):

```text
node --max-old-space-size=64 --test tests/unsigned-store-build.test.mjs tests/unsigned-play-aab.test.mjs
```

Local green evidence: 15 tests passed (nine new producer tests and six unchanged
frozen-AAB regressions), using Node 22.23.4 with a 64 MB heap. Real synthetic ZIP
fixtures exercised signing-block detection and symlink/malformed ZIP rejection.
YAML parsing with duplicate-key rejection, workflow authority/permission
assertions, Bash syntax checks for all 15 run blocks and Node syntax checks passed.

No local Gradle, installation, signing, cloud dispatch, or publication is part of
this preparation. A future authorized main dispatch must validate hosted SDK
36.0.0/tool availability, the JDK trust-store setup, actual Gradle credential
rejection, all original source/native gates, actual APK/AAB identities and
alignment, exact embedded R8 mapping, and artifact upload/download hashes.
Synthetic tests do not substitute for that runtime evidence. The unsigned APK
alignment check also does not discharge alignment/signature checks after any
future local signing operation.
