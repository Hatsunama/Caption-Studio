# Retired cloud Play AAB gate

`verify-play-aab.yml` is a manual fail-closed compatibility tombstone. It has no
credentials, checkout, build, signing, artifact upload or publication path.
`verify-play-aab.mjs` refuses every CLI mode before configuration reads, downloads
or writes. Its pure exported approval, identity, certificate and mapping helpers
remain available for historical tests. The D02 certificate helper describes old
APK-lineage evidence; it must never authorize a new Play AAB. The authoritative
local contract assigns D02 to APK and 50D to Play AAB.

Use [the unsigned producer](unsigned-local-release-build.md),
`.github/workflows/unsigned-store-build.yml`, then the separately approved
`scripts/local-signing/sign-release.ps1` procedure in
[local release signing](local-release-signing.md). The producer checks immutable
source, published version history, package/version identity, bundletool, ABI,
16 KiB alignment, unsigned payloads and exact embedded R8 mapping. Local tools
recheck payload provenance, roles, signatures and mapping before final output.
Actions artifacts in this public repository are downloadable by signed-in users
with read access during retention; they are not private distribution channels.

See [retirement sequencing and test responsibilities](cloud-signing-retirement.md).
These local edits are not active on main. Parent reports D02 and 50D key proof
completed on C and all three old workflow IDs disabled. Secrets remain retained
until full unsigned/local pipeline proof. Published 1.4.135 APK/AAB remain immutable. No Play upload or release publication is authorized by this guide.
