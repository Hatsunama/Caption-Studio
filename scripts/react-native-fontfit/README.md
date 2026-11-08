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
The source build must pass the original seven and twelve additional real-SDK
cases before product wiring, full checks, and both-phone visual verification.

## ReactTextView ownership repair

CI 42490340323 at b1636ad ran 24 real-SDK tests: all 19 arithmetic tests passed;
three of five ownership tests failed assertions, with zero errors. Cached raw
size 30 became 12 and a shared prepared layout poisoned other views.

The separate `repair-textview-source.cjs <project-root>` entry point installs the
approved revised view using ten exact byte chunks in `textview-chunks.json`.
It requires RN 0.86.3 and these independent full-file SHA256 values:

- Before: `f6854ff6811b1ead2c93edbe7ae740ac76de78782478bcc2e07f73457a1ab99d`
- After: `c6621b5224ab4cb980d36dc0c6bca5ae58c84f0bf79e0b3b2a1c2b69439d760a`

Each original/replacement chunk has its own hash; all intervening bytes are
copied verbatim. The final hash is checked before staging and again on disk.
Both repairs share `immutable-rn-source.cjs`, retaining the original ancestor,
link, hard-link, exact-version, identity/time/mode and concurrent-change checks,
exclusive lock, exclusive staging, fsync, atomic rename and owned cleanup.
Already approved source is a no-write result and still requires safe paths and
the exact package version. The fitter payload and its hash guards are unchanged.

Review of the revised Java found the intended ownership boundary: raw cached
text and layout paint remain inputs; each fit creates a span container and
working paint, and applies the result to the view. The raw base survives frame
refits; external size setters invalidate it, and recycle restores it. Selection
is restored only for valid endpoints. The original five ownership methods and
all their supporting code are byte-identical; eleven tests/helpers are inserted
into the same class, giving 16 tests. All 19 arithmetic tests remain unchanged.

Behavior to carry into runtime review: toggling fitting off after a fitted draw
does not immediately restore raw presentation (the existing toggle setter is
unchanged). A fitted recycle now restores the base through the PX setter, so
its remembered text-size unit can become PX; an unfitted SP recycle retains SP.
Direct paint mutation after fitting is not tracked as a new base-size setter.
No unrelated source changes were found in the approved chunks. Constructor,
AppCompat setter dispatch, recycle/JNI and actual draw behavior still need the
parent's source-built runtime tests; host success does not establish native GREEN.

Targeted host verification (temporary packages only; never point the writer at
the working checkout during this review):

```powershell
node --max-old-space-size=128 --test tests/react-native-fontfit-source.test.mjs tests/react-native-textview-source.test.mjs
```

The 24 unchanged fitter host tests and 34 view host tests pass. On Windows,
directory junction tests use real OS junctions; file symlinks use modeled lstat
flags when the OS denies symlink creation. Native/build/workflow integration and
device checks are owned by the parent. No installed dependency is changed by
this implementation work.
