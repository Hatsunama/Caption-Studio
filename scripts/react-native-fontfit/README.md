# React Native 0.86.3 font-fitting repair

Private source-build integration; physical toolbar verification is pending.
The real prebuilt SDK regression ran seven tests: six ample-space failures,
one required-shrink control pass (CI 42481285211). The repair scales each
search trial from call-entry sizes, retaining fractional paint, per-run minimum
clamps, the existing search and the 13-argument API. It does not recover sizes
from an earlier legitimate shrink or implement minimumFontScale propagation.

The body is derived from Meta Platforms React Native 0.86.3 TextLayoutManager.kt,
under its MIT license (node_modules/react-native/LICENSE); its copyright applies.
Only the function interior is replaced, with exact before/after SHA256 guards.
Unknown source/version and observed linked paths fail before publication. A
same-directory staged rename preserves complete bytes; run with a quiescent
node_modules tree. Portable path checks are not an adversarial filesystem
transaction. A killed process may leave a lock requiring review.

Editing this source is insufficient when Maven supplies react-android. The
private workflow also uses the official includeBuild dependency substitutions
for the same installed RN and Hermes projects, after clean Expo prebuild.
https://reactnative.dev/contributing/how-to-build-from-source (checked 2026-11-08).
No SDK/model upgrade or supported ABI removal is authorized by this backport.
The source build must pass the original seven and eleven additional real-SDK
cases before product wiring, full checks, and both-phone visual verification.
