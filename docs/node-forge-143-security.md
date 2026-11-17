# Official node-forge 1.4.3 security review

Reviewed 2026-11-17 on `security/final-release-audit-20261117`, base
`2f5969791d1852273825684d5c272a3394572a67`, after reading AGENTS.md and the
[exact Expo SDK 57 docs](https://docs.expo.dev/versions/v57.0.0/).

The parent-confirmed tests-only [PR #170](https://github.com/Hatsunama/Caption-Studio/pull/170)
head `1819e37e72cad4c2e44a1abbda5bed127a475c81` produced actual hosted
[RED run 44042924596, job 133901615512](https://github.com/Hatsunama/Caption-Studio/actions/runs/44042924596/job/133901615512):
4,202 total, 4,182 passed, 11 failed, 9 skipped. Exactly ten failures were the
expected Gradle regressions; the remaining failure was Ed25519 identity-key
forgery (`true != false`). Honest Ed25519 controls, all 14 existing RSA vectors,
and actual Expo certificate/CSR/CLI signing consumers passed. This establishes
a behavioral baseline, rather than a dependency-loading failure. Independent
[native run 44042924772](https://github.com/Hatsunama/Caption-Studio/actions/runs/44042924772)
succeeded; it is baseline evidence, not validation of this replacement.

The production change pins `overrides.node-forge` to official exact `1.4.3`,
updates only `node_modules/node-forge` in the lock (removing the private package
name), and changes its SDK 57 override expectation. License and Node engine
metadata remain unchanged. Root manifest/lock dependency pins, Expo 57, model
pins, and the braces override are preserved.

Fresh [npm registry metadata](https://registry.npmjs.org/node-forge/1.4.3) was
independently retrieved and compared with the existing private metadata and
unpacked package. The existing official tarball's computed SHA-512 matches both
the fresh registry and the reviewed integrity:

```text
https://registry.npmjs.org/node-forge/-/node-forge-1.4.3.tgz
sha512-P6wzfh6t70avmV8FrVEAd/36sOPJQ+hkaJVX1Laap9J/77m7M0eyozDvc8SwnDf4P7MP94gwbAAo0rg3YVXT+g==
```

There are no runtime dependencies. Evidence remains at
`C:/caption_studio/pip-move-order-20261112-evidence/transition-integration-20261115/node-forge-143-20261117/`.
The lock has one Forge entry and two consumers: `expo/node_modules/@expo/cli`
and `@expo/code-signing-certificates`; both request compatible `^1.3.3`.
Consumer tests and `tests/dependency-api-compatibility.cjs` remain intact; the
parent's standard logic discovery also executes that existing CJS suite.
The only active old override expectation was in the updated SDK 57 test.
Archived private RSA source, vectors, bundles, and review provenance are retained.

The [upstream changelog](https://github.com/digitalbazaar/forge/blob/v1.4.3/CHANGELOG.md)
documents additional RSA canonical-encoding and ASN.1/PEM/TLS/HTTP protections,
Buffer PEM compatibility, X.509 name constraints, and
[Ed25519 small-order rejection](https://github.com/digitalbazaar/forge/security/advisories/GHSA-6889-vf6x-f3g5).
The private backport covered the nested RSA element-count defect only.
X.509 validation is deliberately stricter: chains violating name constraints
now fail; supported critical constraints can now validate compliant chains.
Resource guards may reject malformed or excessive inputs. No application UI code changes; preserving user-visible behavior still requires
the final runtime acceptance checks.

Static JSON, graph-preservation, integrity, and diff checks completed locally.
No local Node tests or install ran: observed free RAM was 586 MiB, below the
768 MiB gate. No local GREEN is claimed. The parent must obtain full hosted
GREEN against the installed lock graph, including the unchanged Ed25519/RSA
and real Expo consumers, the existing compatibility CJS suite, and SDK 57 lock
expectations. Gradle/native integration remains with the parent.
