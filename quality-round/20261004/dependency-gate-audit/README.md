# Dependency gate audit preparation

Baseline: cbb60fb58ed448f2146145ae2d2ccca2ec75dde1.
SRT draft PR132 head: e3b8b9fe8d3f944c44996a7cb8e25de08c2c150c.
PR132 changes only subtitle export and its test; it changes neither dependency manifest.
Historical failing merge checkout: 946bf1a96a0f9f52199b3151fdc6c05992939c57.
Historical run: https://github.com/Hatsunama/Caption-Studio/actions/runs/37239948094

## Root evidence and ownership

- https://github.com/advisories/GHSA-vfj7-8cjw-p6xm: braces <=3.0.3 affected, no patched version; recursive compile/expand stack exhaustion. Locked braces 3.0.3. micromatch 4.0.8 requests ^3.0.3; @expo/metro-file-map 57.0.3 and metro-file-map 0.84.5 use micromatch for glob/file map work. Expo and React Native CLI/Metro retain this production dependency path.
- https://github.com/advisories/GHSA-86w9-cpqp-85rv: node-forge <=1.4.0 affected, no patched version; nested DigestAlgorithm element counts not validated in RSA PKCS#1 v1.5 verification. Locked 1.4.0. Expo CLI 57.0.27 and @expo/code-signing-certificates 0.0.6 request ^1.3.3. This concerns certificate/signature tooling; installed production classification alone does not establish app-runtime exploitability.
- https://github.com/digitalbazaar/forge/pull/1152 is open, not a published patched release. Its proposed 1.4.1 changelog is not proof that npm 1.4.1 exists.
- https://docs.npmjs.com/cli/v10/commands/npm-audit/ explains propagated meta-vulnerabilities. Nineteen affected package entries are not nineteen independent root CVEs. Human '*' is not a substitute for the root advisory's affected range.
- https://docs.expo.dev/versions/v57.0.0/ ties SDK57 to RN0.86, React19.2.3 and Node22.13.x. Expo44 downgrade is not a compatible lock repair for this application.

## Decision and options

No production package/lock edits are justified until a compatible published patch is verified in registry metadata, upstream source, behavior and the complete resolved tree. This harness fetches official npm packuments and records all published versions above the two advisory bounds. A version above a bound is only a candidate, not proof of a patch.

Wait for real fixed releases and compatible consuming ranges; or independently evaluate a maintained, pinned fork/replacement across every consuming path. A local guard or node_modules patch can improve behavior but leaves npm's affected package/version identity and audit gate red. Moving Expo/RN to devDependencies, disabling/suppressing the gate, force-fixing or applying unpatched/nonexistent overrides is not remediation. No UI or application code changes are included.

## Regression and subsequent required checks

Harness controls: ordinary brace expansion, micromatch file selection, valid RSA signature and wrong-message rejection. Negative probes: nested patterns below braces' input-length limit must avoid stack overflow; RSA verifier must reject extra nested DigestAlgorithm children. Generated-key malformed signature isolates verifier parsing and does not demonstrate a public-key-only forgery. Red evidence is retained; no green remediation claim.

Once a real compatible candidate exists, use isolated cloud npm10.9.2/Node22.13.1 to regenerate package-lock alongside exact package changes, inspect npm ls/npm explain for braces/node-forge and every consumer, confirm no duplicate vulnerable nodes, peer/engine integrity and unchanged native-module resolutions. Repeat the behavior probes red/green and unchanged npm audit --omit=dev --audit-level=high (including JSON roots). Any forks require their own security review; an audit pass alone is insufficient.

Run the existing complete CI on the candidate and its integration with pinned PR132: verify:product-contract; test:logic including SRT regression; tsc --noEmit; lint; expo install --check; expo-doctor1.20.4; clean Android prebuild, Gradle patch and verify:android-config; first-party lintRelease; app and all three caption modules' release unit tests; assembleRelease/bundleRelease; ABI, identity/version/targetSDK36, APK16KB zip/ELF alignment and ephemeral CI signing verification. Preserve required test reports and validation-only artifacts. Confirm required status contexts from repository rules before declaring ready. No device run, main merge or public release is authorized here.
