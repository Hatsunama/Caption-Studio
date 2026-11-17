# Picomatch repeated-extglob security backport

This is a private, explicitly named MIT-licensed backport for
GHSA-fc5q-39xc-vjpf / CVE-2026-112366. The public npm latest package was 4.0.7
and the advisory listed no fixed version when checked on 2026-11-17.
It is not an upstream release or proof against every possible glob/regex issue.

## Scope and authority

The existing release security audit failed before compilation. Standing approval
for compatible security repairs permits this directly required release repair,
while retaining Expo 57.0.33, React Native 0.86.3, the current model and all gates.
There is no audit suppression, platform downgrade or broad dependency upgrade.

Two original dependency lines remain separate: 2.3.2 for Micromatch/Jest and
4.0.7 for Expo CLI/Metro configuration/tinyglobby/fdir. Downloads were checked
against the original lockfile's SHA-512 integrity before vendoring.
config/picomatch-backports.json records original URLs, integrities, file hashes,
private identities, pinned distribution URLs and the three changed lock nodes.
Every unrelated upstream byte and every other lock node remains verified.

## Small repair and intentional behavior change

Both upstream parsers already classify hazardous repeated extglobs and either
use a proven linear equivalent or treat the hazardous pattern as literal text.
Their single-branch path misses ordinary wildcard stars, allowing exponential
partitioning under outer plus/star repetitions.

Extend that same authoritative safeguard after its existing linear-fold cases.
The added scanner respects escaping, quoted literals, character classes and
POSIX class terminators. It does not replace the parser or add a regex engine.
Existing explicit guard opt-out options retain their original semantics and
are not used by the inspected default build consumers.

Hazardous repeated wildcard patterns are now treated literally through the
existing fallback. This is an intentional security behavior repair, not a claim
that every formerly accepted hostile glob retains its matching semantics.
Ordinary build globs, brace alternatives, exclusions, fixed-width extglobs and
the existing safe linear folds remain covered by preservation tests.

The aliases identify private reviewed code honestly. A clean registry audit
alone cannot establish security of a private fork: the exploit, provenance and
actual installed-consumer tests are mandatory as well. Reassess relevant future
upstream advisories against these original major lines, and retire the forks
when compatible official fixes pass the same checks.

## Observed evidence and acceptance still required

Tests-only source 76fc3f6 staged integrity-verified, unmodified original code.
GitHub 44184921988 observed eight real subprocess timeouts across both major
lines. The ordinary-corpus harness initially passed Array.filter's index as the
matcher's returnObject option; its callback was corrected without changing the
expected matches. First repair d11e339 passed all 91 focused tests except the
eight documented Windows-only skips.

A selective cascade then reproduced four character-class/quote bypasses in the
new scanner on tests-only ba35a10 (GitHub 44185606925). Repair 02dbbc6 passed
87 tests, zero failures, eight Windows-only skips in GitHub 44186018199.
No initial failing run is represented as accepted evidence.

Next requirements: actual fresh npm ci, the installed Expo/Metro/Jest/fdir
consumers and bounded exploit tests, unchanged full npm security audit, entire
logic/build-tool/type/lint/Expo/native gates, and the real optimized release.
Only the three reviewed Picomatch lock nodes and explicit major-preserving consumer overrides may
change; the independent whole-graph fingerprint remains comprehensive.

No private signing material is in these sources or archives. Final APK/AAB
generation stays on GitHub, signing uses the original separate C: keys, and
both final forms must pass native checks on both phones before new publication.

Primary references:
- https://github.com/advisories/GHSA-fc5q-39xc-vjpf
- https://github.com/micromatch/picomatch
- https://github.com/micromatch/picomatch/pull/194 (partial related work, explicitly not adopted as a complete security fix)
Actual installed-consumer RED: CI 44186018030 reproduced the timeout through all seven real root/Expo/Metro/Micromatch/Jest/tinyglobby/fdir resolutions; both ordinary consumer tests passed. The override integration changes only the three independently compared lock nodes. Remote distributions at the pinned commit were downloaded again and their SHA-512 integrities matched the reviewed local archives.

Integration repair: npm ci rejected version-range selectors with a conflicting ideal hoist. Keep global v4 explicit and scope the v2 fork to its actual Micromatch/Jest owners, retaining all three reviewed lock nodes. No peer-check suppression or package-manager option was added.
