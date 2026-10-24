# Public truststore regression fixtures

Public CA certificates only. No private keys or generated key pairs.
These files are from the immutable OpenJDK `jdk-25+36` tag:

- `emsigneccrootcag3.pem`: `src/java.base/share/data/cacerts/emsigneccrootcag3`
- `comodoaaaca.pem`: `src/java.base/share/data/cacerts/comodoaaaca`
- `isrgrootx1.pem`: `src/java.base/share/data/cacerts/letsencryptisrgx1`

Source: https://github.com/openjdk/jdk/tree/jdk-25%2B36/src/java.base/share/data/cacerts

Blocked DER SHA-256 fingerprints (not PEM file hashes):

- `86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b`
- `d7a7a0fb5d7e2731d771e9484ebcdef71d5f0c3e0a2948782bc83ee0ea699ef4`

ISRG Root X1 is retained, including when its test alias resembles a blocked root.
Tests use temporary, disposable JKS stores and sequential keytool processes with
`-J-Xmx64m`. Set `JAVA_TRUSTSTORE_TEST_KEYTOOL` to select a different keytool.
Run `node --test --test-concurrency=1 tests/java-truststore-security.test.mjs`.

## Utility interface and integration

`node scripts/harden-java-truststores.mjs --prepare --java-home <JDK_HOME> --output <NEW_FILE>`
reads the runtime's `lib/security/cacerts` and publishes an exclusive hardened copy.
The output parent must already exist. Use the copy explicitly with
`-Djavax.net.ssl.trustStore=<NEW_FILE>`; the utility does not change `JAVA_HOME`.

`node scripts/harden-java-truststores.mjs --ci` requires the exact repository
`Hatsunama/Caption-Studio`, `GITHUB_ACTIONS=true`, both setup-java environment
variables `JAVA_HOME_17_X64` and `JAVA_HOME_21_X64`, canonical homes strictly under
`RUNNER_TOOL_CACHE`, and a writable `RUNNER_TEMP`. `JAVA_HOME` must select one of
the two runtimes. Both stores are staged and audited before either is replaced.
Verified backups remain in a private directory under `RUNNER_TEMP` for recovery.
Only execute in an isolated job, after both JDK installs and before Java network
access or Gradle. Filesystem checks assume there are no concurrent writers.

`HOME/.gradle` is made private. Existing `gradle.properties` bytes are preserved
and effective overrides restrict discovery to the two environment variables,
clear additional paths, disable auto-detection/download, and retain the active
JDK for the Gradle daemon. An alternate `GRADLE_USER_HOME` is rejected. Alternate
`jssecacerts`, symlink/junction paths, shared hard-linked files, unknown options,
nonstandard store passwords, and stores containing private keys fail closed.
Product source, bytecode targets, environment variables, and host global stores
are not changed. Integration must not supply a separate JSSE truststore or
override these Gradle restrictions later.

Success writes one JSON object to stdout (public fingerprints, paths, counts).
Failure writes JSON to stderr, returns nonzero, and never emits keytool output
or Gradle property contents. Each keytool process has a 64 MB maximum heap and
a 30 second timeout; truststores/output listings are bounded to 16 MiB.
Failure cleanup preserves complete copies/recovery backups rather than deleting
the only usable artifact. Permission or cleanup errors remain fatal.

The POSIX-only end-to-end CI test uses disposable runtime wrappers around actual
keytool; it does not claim to prove vendor JDK provenance. On Windows this case
is skipped, and file symlink tests require developer mode or suitable privilege.
Directory junction guards, actual local prepare, keytool removal, preservation,
backup integrity, rollback, and cleanup failures still run on Windows.
