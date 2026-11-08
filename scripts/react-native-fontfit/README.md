# React Native 0.86.3 Android text fitting

Private source-build integration; device acceptance and production wiring remain pending.
Expo 57, RN 0.86.3, the model, toolbar props, and supported ABIs are unchanged.
Derived RN source remains under Meta's MIT license in the installed package.

`install-final-sources.cjs <project-root>` is the single final installer. Its pinned
payload changes exactly five files: TextLayoutManager, PreparedLayout,
ReactTextViewManager, ReactTextView, and Android paragraph MapBuffer serialization.
The manifest records independent original/final full-file digests. Unknown versions,
files, links, hardlinks, payloads, or concurrent changes fail closed. Every file is
preflighted before any write. Same-directory staging/fsync/rename publishes one
complete file at a time; this is not an atomic five-file transaction. Exact mixed
original/final states allow retry. Run only on a quiescent locked dependency tree.

The final implementation keeps the existing fitting search and 13-argument API:
- Each trial scales call-entry sizes, avoiding cumulative integer rounding.
- View fitting owns its text/paint, preserving cached input, selection and an
  unfitted base through resize, external setters and recycle.
- The existing minimumFontScale prop is serialized at upstream key 10. Its floor
  is resolved against original spans once and carried through PreparedLayout;
  a later view fit cannot multiply an already reduced floor again.
- Explicit minimum size takes precedence; absent/invalid scale keeps the legacy
  4dp floor. Non-fitting text and unrelated styles are not redesigned.

Evidence: prebuilt RN arithmetic regression had six assertion failures in seven
cases (run 42481285211). Ownership RED had three failures in five view cases with
all 19 fitter tests passing (42490340323). Revised ownership/arithmetic source ran
241 native tests with zero failures/errors/skips (42491813743), but its all-ABI
APK build reached the 75-minute job budget before producing an APK. Minimum-scale
RED 42499752484 executed actual RN createLayout and WritableMapBuffer on SDK36:
20px expected, 12px observed, one assertion failure and zero errors. The SDK36
sandbox explicitly runs on the freshly verified Java21 launcher; app Java
source/target compatibility is unchanged. Final native GREEN is pending.

The private integration workflow uses official RN composite source substitutions,
source-only Kotlin 2.3.21 alignment for the verified compiler defect, and the
pinned Hermes archive-prefix repair. It retains JUnit before its bounded 120-minute
C++/APK build. Neither passing host checks nor an APK build establishes physical
font restoration, accessible font scaling, PiP rendering, or release readiness.

Run host tests against clean locked dependencies before installing sources:

```
node --max-old-space-size=128 --test --test-concurrency=1 tests/react-native-final-source.test.mjs tests/react-native-fontfit-source.test.mjs tests/react-native-textview-source.test.mjs tests/react-native-source-settings.test.mjs tests/react-native-source-kotlin.test.mjs tests/react-native-hermes-source-layout.test.mjs
```

Those 167 host tests pass, including 55 final-publication tests. Older two-phase
installers/tests are historical diagnostics, not the final workflow's write path.
Preserve the 19 fitter and 16 ownership native tests unchanged. Windows junction
and hardlink cases use real OS links; file symlink flags are modeled only when
Windows denies creation, and those cases are labelled. No dependency update,
production signing key, release artifact, or product workflow is changed here.
