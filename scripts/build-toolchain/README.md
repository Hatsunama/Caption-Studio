# Verified Java bootstrap

This is a transport change for the same Temurin 21.0.13+9 and 17.0.21+9 Linux x64 builds. It does not change application TLS, SDK, model, app signing, or the JDK security baseline.

The original setup-java downloads returned HTTP504 on two fresh runners and the host. Official Adoptium API range requests returned the expected complete ranges. The new transport uses two bounded 8MiB requests, HTTPS-only redirects, exact Content-Range/total/length checks, a finite deadline, and ordered writes. Directory listing sizes on Windows while a writer is open are not progress evidence; transfer counts and final checks are.

Transport does not establish trust. Before extraction or Java execution the bootstrap requires the exact archive size/SHA256, the exact detached-signature size/SHA256, and gpgv success for one valid unexpired/unrevoked Adoptium signature with SHA256 or stronger. It uses a fresh isolated GPG home and the pinned public key/fingerprint from actions/setup-java b843ebf9b913146b38da2eaa7aeddf76074ae1ad, not an ambient keyring. All roots and content pins are immutable in the checked-in catalog. No private signing key is included or accessed.

Sources checked 2026-11-08:
- https://api.github.com/repos/adoptium/temurin21-binaries/releases/tags/jdk-21.0.13%2B9
- https://api.github.com/repos/adoptium/temurin17-binaries/releases/tags/jdk-17.0.21%2B9
- https://raw.githubusercontent.com/actions/setup-java/b843ebf9b913146b38da2eaa7aeddf76074ae1ad/src/distributions/temurin/adoptium-key.ts
- https://raw.githubusercontent.com/actions/setup-java/b843ebf9b913146b38da2eaa7aeddf76074ae1ad/src/gpg.ts

`--verify-only <existing staging parent> --receipt <new JSON path>` downloads and verifies both Linux archives without installing or executing them; its owned temporary directory is removed on success/failure. `--install` is restricted to the isolated Linux GitHub repository job. Fresh installation is required inside RUNNER_TOOL_CACHE, preserving the existing hardening location guard without accepting any cached JDK. Only after both archives verify does it export both Java homes, then the workflow must run the existing trust-store hardening before any consuming build. Verified extracted JDKs remain only for that disposable job. No JDK installation cache is accepted.

Prerequisites are the existing Node runtime, Python3 stdlib, GPG/gpgv, and tar on the Linux runner. Windows verification uses the already installed Python311 and Git GPG tools, including that distribution's cygpath converter. GPG keyring initialization runs before any large download so incompatible path wiring fails early. No tool is installed on the host. No production dependencies change.

Tests: `node --test tests/verified-java-download.test.mjs tests/release-toolchain-patches.test.mjs`. These include actual transport control flow with deterministic network doubles, range/length/HTTPS rejection, archive integrity/link rejection, strict GPG status interpretation, and workflow ordering. They do not replace real archive/GPG verification or native font tests. An initial queue error was reproduced in the actual downloader's small-file path before correction. Exact host and CI receipts remain the evidence of real cryptographic verification.