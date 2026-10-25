# One-time encrypted Solana recovery (phase 1)

This adds a manual export of the four existing repository Actions signing secrets.
It does not recover anything automatically, install a local key, change signing pipelines,
delete secrets, build the app, or alter the published 1.4.135 APK/AAB. No local importer
is included. Keep all four GitHub secrets and existing workflows until a separate local
production private-key sign-and-verify proof succeeds.

After review/integration on main, only Hatsunama can dispatch or rerun
`recover-local-signing.yml` in `Hatsunama/Caption-Studio` on `refs/heads/main`, using
the exact confirmation `RECOVER_EXISTING_SOLANA_TO_C_ENCRYPTED`. Both jobs are gated
by job expressions and an exact, case-sensitive Bash preflight as the first step
before checkout. GitHub expression equality is case-insensitive, so the preflight
independently checks repository, repository owner, event, ref, actor, and confirmation.
Confirmation enters only through the step environment, never shell interpolation.
They check out that dispatch's immutable `github.sha` with credentials
not persisted. The synthetic job has no production secrets; only the exporter step
receives the four existing secrets through environment variables. Both jobs use the
existing pinned setup-java action with Temurin `17.0.21+9` and no dependency cache.
No Gradle, app changes, or local tool installations are involved.

The recipient certificate is pinned to the independently supplied DER SHA-256
`5be66294eff75a2c9aee7ca70d71b94c740113a768f26f46b6c75346cc72e6a4`.
The tests contain this approval value as a literal rather than deriving trust from the
checked-in certificate. Export checks that pin and `openssl x509 -checkend 0`
before reading credentials. There is no CLI/environment pin override. The certificate's
seven-day lifetime limits this recovery window; its expiry prevents new exports, not
decryption of an existing envelope. Manual retries remain possible within that window;
there is no persistent single-use server state.

Only `recovery.p7m` and `manifest.json` are uploaded, with one-day retention.
`recovery.p7m` is binary DER CMS **AuthEnvelopedData**, AES-256-GCM with an RSA-OAEP
recipient using SHA-256 for OAEP and MGF1. This is standard
[OpenSSL CMS](https://docs.openssl.org/3.0/man1/openssl-cms/).
The manifest records the ciphertext SHA-256, exporter SHA-256, schema/OpenSSL versions,
algorithm names, recipient pin, and **expected** production signing certificate pin
`d02d23b28cbc615e3686d181aedefbbe5de993a0b6ba3f8e4ea2b6160211b35f`.
Java 17 `keytool -list -rfc` auto-detects JKS or PKCS#12 from the bytes, verifies
the store password, and reads the public signing certificate. Exactly one certificate
is required, and its DER SHA-256 must match the fixed D02 pin above. The alias is
not passed to keytool; any alias in tool output stays captured and is never logged.
This is a certificate/password sanity check; private-key signing proof remains local
after recovery. The manifest does not claim that proof occurred.
No plaintext/password hashes or secret values are in the public manifest.

The encrypted payload is a ZIP_STORED archive, schema version 1, with **exactly** these
four regular file entries, in this order; no directory entries, nested paths, duplicate
names, schema manifest entry, or additional entries:

| Entry | Exact contents |
| --- | --- |
| `keystore.p12` | Original base64-decoded keystore bytes (JKS or PKCS#12), maximum 512 KiB |
| `store-password.txt` | Store password, UTF-8, maximum 4096 bytes |
| `key-password.txt` | Key password, UTF-8, maximum 4096 bytes |
| `alias.txt` | Alias, UTF-8, maximum 4096 bytes |

Text is nonempty and contains no NUL, CR, LF, BOM added by the exporter, or added newline.
ZIP entries carry Unix regular-file mode 0600 and fixed default ZIP timestamps. The
public `payload` object specifies this exact list and disallows paths and extra entries.
The base64 decoder accepts LF-wrapped input, matching prior `base64 --decode`
usage; other non-base64 characters (including spaces and CR) are rejected. Secrets
are preserved; the exporter does not trim, convert stores, or change passwords.
The legacy `keystore.p12` ZIP name is retained even when the bytes are JKS.

All plaintext files are exclusive-created mode 0600 inside a unique mode 0700 directory
under `RUNNER_TEMP`. Children get a minimal environment without Java option overrides;
only keytool inspection receives the store password via `-storepass:env`, never argv.
Keytool uses an explicit 16 MiB initial heap, 64 MiB maximum heap, and one active CPU.
Child stdout and stderr are captured and never logged. Failures produce a fixed, value-free error. Success is silent. Plaintext
is removed before publication, and context cleanup covers ordinary exceptions and
keyboard interruption. Final output must be a nonexistent immediate child of
`RUNNER_TEMP`; exclusive directory creation refuses existing destinations. Publication
failure removes partial output. Workflow `always()` cleanup removes recovery paths.

For a later local decryption (instructions only; not executed here), download only the
two artifact files to an owner-restricted location on C. Independently check both pins
against the approval values above, require manifest schema 1 and its exact payload
schema, and compare `recovery.p7m` SHA-256 to the manifest. Do not trust a manifest
solely because it accompanies the ciphertext: it is not signed. Verify the source
workflow/revision and retain the independent pins as the trust anchors.

In a **fresh owner-restricted staging directory** under
`C:\Users\1thea\.caption-studio-signing`, a future importer can run the equivalent of:

```text
openssl cms -decrypt -binary -inform DER -in <downloaded-recovery.p7m> -recip <approved-public-recipient.crt> -inkey <encrypted-C-only-recipient-private-key> -out <fresh-private-staging-directory>\payload.pending.zip
```

Let OpenSSL request the private-key passphrase interactively, or use the separately
approved DPAPI-to-environment mechanism; never put it on the command line. Do not
decrypt to stdout. OpenSSL may write bytes before the GCM tag is checked: require
exit code zero before inspecting/importing any ZIP bytes and delete staged output
on any failure. Refuse pre-existing staging/output paths. Before extraction, require
exactly the four unique regular-file members above, ZIP_STORED, no paths, links,
encryption, extras, or excess uncompressed sizes (524288/4096/4096/4096 bytes).
Read individual allowlisted entries; never use unrestricted `extractall`.

A later Windows importer must verify the local private key by signing and verifying a
synthetic JAR with Java tools and independently matching the expected production
certificate fingerprint. Only after that proof should it save passwords with Windows
CurrentUser DPAPI and atomically rename the verified staging directory to a new final
destination. It must never modify Play signing files or published APK/AABs. None of
these local decryption/import/signing steps was performed in this change.

Assumptions and limits: GitHub's hosted runner, the gated main revision, pinned actions,
system OpenSSL, Java 17, and the account/recipient private key are trusted. The private
recipient key/passphrase remain outside this repository. The exporter accepts a JKS
or PKCS#12 store with exactly one public signing certificate; unsupported formats/crypto
fail closed. Certificate presence is not proof that the corresponding private key/password
or alias can sign. AEAD detects corruption but does not authenticate the sender against
an attacker who can replace the artifact and knows the public recipient certificate.
Deletion is ordinary filesystem cleanup, not forensic secure erasure; hard kills and
host failure rely on ephemeral runner disposal. POSIX permission checks run in the
Ubuntu synthetic job; Windows synthetic tests inherit temporary-directory ACLs.
Local OpenSSL 3.5.9 synthetic tests do not establish an actual Ubuntu/OpenSSL 3.0 run;
the manual workflow runs the same suite on Ubuntu 24.04 before receiving secrets.

Validation uses Node 22 with `--max-old-space-size=64 --test tests/signing-recovery.test.mjs`
and Python 3.11+ with Java 17 keytool (`PYTHON_BIN`/`OPENSSL_BIN`/`KEYTOOL_BIN`
can select installed synthetic test tools; `BASH_BIN` selects Git Bash on Windows).
Tests execute the extracted first-step Bash from each job with exact and rejected
contexts, and roundtrip both a synthetic PKCS#12 and a real synthetic JKS through
the envelope with exact ZIP byte comparisons. Success fixtures use newly generated
certificates and do not depend on the fixed recipient certificate expiry.
GitHub Ubuntu 24.04/OpenSSL 3.0 integration remains a required gate before export;
Windows/Git Bash results alone do not establish that integration result.
The Expo 57 reference required by AGENTS was read:
[exact versioned documentation](https://docs.expo.dev/versions/v57.0.0/).
