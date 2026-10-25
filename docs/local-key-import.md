# Local Windows key importer

This importer is a separate, local step after the approved encrypted export. It does
not run recovery, delete cloud credentials, sign an app, or change release 135. Cloud
key deletion remains blocked until the original D02 private key has been proven locally.
Synthetic results below do not establish that production proof. The Play key is untouched.

Use Windows PowerShell **5.1** under the intended Windows account, Java 17, Node 22,
and OpenSSL 3. Supply absolute canonical C-drive paths explicitly. Read AGENTS and the
[Expo 57 reference](https://docs.expo.dev/versions/v57.0.0/) before changing this code.

```powershell
powershell.exe -NoProfile -NonInteractive -File scripts/local-signing/import-recovered-key.ps1 `
  -Envelope '<encrypted backup path>\recovery.p7m' `
  -Manifest '<encrypted backup path>\manifest.json' `
  -RecipientCertificate '<approved public recipient certificate>' `
  -RecipientPrivatePem '<encrypted recipient PEM>' `
  -RecipientPasswordDpapi '<CurrentUser DPAPI recipient password file>' `
  -ApprovedExporterSha256 '<independently approved exporter source SHA-256>' `
  -JdkBin '<Java 17 bin directory>' `
  -OpenSslExe '<OpenSSL executable>' `
  -NodeExe '<Node 22 executable>' `
  -DestinationRoot 'C:\Users\1thea\.caption-studio-signing'
```

Placeholders must be replaced with explicit parent-supplied paths. Do not take the
approved exporter hash solely from the accompanying unsigned manifest. There is no
production CLI/environment override for either certificate pin. The destination root
must already exist with the current user as owner, protected inheritance, and only
that user's FullControl allow rule. The importer checks every path's ancestors for
reparse points and refuses existing `solana-release`. It never changes root ACLs.

The recipient password input accepts raw Windows CurrentUser DPAPI protecting UTF-8
bytes, with no optional entropy, or the Windows `ConvertFrom-SecureString` hex format
without a separate key. It does not accept plaintext or CLIXML. New password files
are raw `ProtectedData.Protect(UTF8Bytes, null, CurrentUser)` blobs, without entropy.
They are tied to the same Windows account and profile.

The script validates public/encrypted input snapshots, exact manifest fields and
payload schema, independently approved exporter hash, both fixed certificate pins,
ciphertext hash, and actual DER CMS algorithms. It accepts a single RSA-OAEP recipient
with SHA-256 OAEP/MGF1, AES-256-GCM with a 12-byte nonce and 16-byte tag, and no optional
CMS attributes. OpenSSL must exit zero before ZIP parsing. The bounded ZIP parser
accepts only the exporter's four ordered regular mode-0600 ZIP_STORED members. It
checks central/local agreement, CRCs, sizes, strict UTF-8, and forbidden text bytes;
it rejects extras, encryption, paths, links, directories, trailers, and leading data.
There is no general extraction call or keystore conversion.

Private-key proof signs a disposable one-entry JAR with the exact recovered alias and
store/key passwords, verifies it with jarsigner, then reads the signed JAR's certificate
with keytool and compares its DER SHA-256 to D02. Certificate-only stores fail. Child
stdout/stderr are captured and discarded on failure; passwords enter child environment
variables, never argv. Children have closed stdin, a minimal environment, a 60-second
timeout and termination cleanup. Java uses a 64 MiB heap and one active CPU.

On success, the complete private stage contains only:

- `key.p12`: original unmodified JKS or PKCS#12 bytes.
- `alias.txt`: exact original UTF-8 bytes, without an added newline.
- `store-password.dpapi` and `key-password.dpapi`: CurrentUser DPAPI blobs.
- `receipt.json`: public proof description, certificate fingerprints, ciphertext,
  exporter and keystore hashes. No password hashes or secret values.

Raw payload/password files and the proof JAR are removed before an atomic same-volume
directory rename to `solana-release`. The original encrypted backup and recipient
key/password inputs are preserved. Cleanup only targets the importer-owned GUID stage
after rechecking its ancestry, ACL and entire tree for reparse points. Unexpected
filesystem tampering makes cleanup refuse rather than traverse outside that stage.
Ordinary exceptions/cancellation run `finally`; a hard process kill or host failure
can leave a private stage for owner review, but cannot expose a partially built final
bundle. Cleanup is normal deletion, not forensic erasure. The current Windows account,
OS and explicit tool executables are trusted; same-account malicious mutation is out
of scope. BSTRs, password byte arrays and child environments are cleared; managed
immutable strings cannot be reliably overwritten.

Run only synthetic tests (no installation or app build):

```powershell
$env:LOCAL_IMPORT_TEST_JDK = '<Java 17 bin directory>'
$env:LOCAL_IMPORT_TEST_OPENSSL = '<OpenSSL executable>'
& '<Node 22 executable>' --max-old-space-size=64 --test tests/local-key-import.test.mjs
```

The first run failed with `ERR_MODULE_NOT_FOUND` before implementation. The final
2026-10-25 local run passed **7 tests, 0 failures, 0 skips**, using Node 22.23.4 with
a 64 MiB heap, Windows PowerShell 5.1.26100.9711, Java 17.0.21 and OpenSSL 3.5.9.
Tests cover
manifest/provenance/hash/recipient failures, member/path/layout/CRC/encoding failures,
real synthetic OpenSSL CMS roundtrip and tamper rejection, and Windows DPAPI, ACL,
PKCS#12/JKS private-key proof (including distinct JKS key password), certificate-only
store rejection, wrong password/alias/fingerprint, child failure gating, reparse-point
rejection, cleanup, atomic rename and no-overwrite. Tests load function ASTs to exercise
synthetic keys with a synthetic expected fingerprint; production CLI pins remain fixed.
The production CLI is exercised only on rejection/no-overwrite paths.

Cross-platform parser/CMS tests can run on Linux with OpenSSL 3; Windows-specific tests
are explicitly skipped there. Linux CI, OpenSSL 3.0, forced process termination and a
full production import are not established by the local Windows/OpenSSL 3.5.9 run.
No protected production material was opened or recovered during implementation.
