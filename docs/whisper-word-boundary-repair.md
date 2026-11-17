# Native word boundary repair (whisper.rn 0.7.4)

This project-local source backport adds one strict-interior predicate to
`cpp/whisper.cpp::whisper_wrap_segment`. A token can split the current fragment
only when `token.t0 > segment.t0 && token.t0 < segment.t1`. Both are native
`int64_t` timestamps in 10ms units. The copied remaining segment retains the
original parent's end on every split. Rejected boundaries keep their text and
tokens with the current fragment until a valid boundary appears. Timestamps,
token order, length/word split policy and speaker flags otherwise follow the
existing implementation. A fragment can exceed `max_len` when timestamps cannot
support another positive interval. Invalid original parents stay invalid for
the application's existing strict validation.

The authoritative `scripts/patch-react-native-gradle.js` postinstall calls this
guard first, before any other repair. It requires installed version **0.7.4**
and exactly one of these complete-file SHA-256 values (LF bytes):

| State | SHA-256 |
| --- | --- |
| Pristine | `4eeac03d31372e34193f670394de19e625c87878743ca90d39da398c20ace4a6` |
| Repaired | `e6cd3b480140b6060af8fcd0da88e71babefb461399cdc0e91504149fff51b83` |

An entirely absent dependency tree remains an inert no-op, matching the existing postinstall owners. An incomplete or invalid dependency tree, unknown version, missing package input, or unknown content throws before mutation.
The computed postimage is verified before an exclusive temporary write and a
same-directory atomic rename. A recognized postimage is a byte-preserving no-op.
An I/O failure preserves the target; temporary files are retained for diagnosis.
This is one-file atomic installation, not a transaction over all postinstall
helpers. The native backport changes no dependency version, package lock, model, canonical source validator or ASR
configuration changes are included. A rebuilt native binary is required.

## Provenance and licensing

The installed pristine source matches the published
[npm whisper.rn 0.7.4 archive](https://registry.npmjs.org/whisper.rn/-/whisper.rn-0.7.4.tgz)
byte for byte. The archive's SHA-512 matches the existing lock:
`sha512-9MyWFoRmUWHDHLhjm4dZgZzxG2fFNuClOPE/Ne5KXlm0vSi4It5oS2xZi9WfPEfUGHcgPMiVviv9t18zC4BSNw==`.
Registry metadata identifies git head `4d750cb7917973c2528a46cd3902dfe4ebbcbe7f`.
The archive reports whisper.cpp version 1.9.3; the npm archive, rather than a
GitHub tag snapshot, is the source of the pinned file.

The [whisper.rn license](https://github.com/mybigday/whisper.rn/blob/v0.7.4/LICENSE)
is MIT, copyright (c) 2023 Jhen-Jie Hong. The corresponding
[whisper.cpp 1.9.3 license](https://github.com/ggml-org/whisper.cpp/blob/v1.9.3/LICENSE)
is MIT, copyright (c) 2023-2026 The ggml authors. MIT permits modification with
the existing notices and permission text retained. This repair neither removes
those notices nor vendors a wholesale native source copy. It is a local repair,
not a claim that an upstream fix was adopted from another release.

## Regression and acceptance

`tests/whisper-word-boundaries.test.mjs` participates in the existing
`npm run test:logic` glob. Its tiny C++ harness extracts the actual installed
function, native token/segment structures, UTF-8 counter and word-split helper;
only vocabulary/context/state accessors are stubbed. It compiles the pristine
and repaired functions together using existing `g++`/`clang++`. The baseline
must fail and print consecutive `[400,400]` intervals; the repaired algorithm
must preserve text/tokens and pass all bounded interval and normal-equivalence
checks. Token text is synthetic: the observed diagnostic supplies numeric
segments 12/13, not the original token sequence. No model inference is simulated.

CI fails if the compiler/resource limiter is missing. Windows without a usable
bounded compiler explicitly skips native execution; this is not native proof.
POSIX compilation is sequential with 384MiB address-space and 30s CPU limits,
and requires >=1GiB free RAM. On Windows, callers must hold
`Local\CaptionStudioNodeChecks` across Node and all its children. Use a sequential
Node runner with `--max-old-space-size=192 --test --test-concurrency=1`.
`WHISPER_BOUNDARY_INSTALLED=1` tests the installed native source unchanged for
the pre-repair RED. Default mode installs into an isolated fixture; it never
patches the checkout's installed source. Fixture files are retained in the OS
temporary directory, with no deletes.

Local RED/GREEN logs and the explicit native-execution gap are recorded outside
the checkout at
`C:\caption_studio\pip-move-order-20261112-evidence\native-word-boundary-repair`.
Prerequisite docs read: [Expo 57 reference](https://docs.expo.dev/versions/v57.0.0/)
and [versioned package.json reference](https://docs.expo.dev/versions/v57.0.0/config/package-json/).

## Connected application timing contract

The coalescer rejects invalid lexical parent intervals instead of manufacturing
10ms support. It keeps the established rounded allocation when all shared
boundaries remain positive and inside the native parent; only a segment whose
rounding collapses or escapes uses representable fractional boundaries.
Punctuation, token-piece attachment, normalization and text order remain intact.
Speech selection uses the actual word duration, including intervals below 10ms. Primary and translated MP4 cues retain their original fractional bounds in the shared native model, as do primary word intervals. Other layer timing and SRT/ASS quantization stay unchanged.
The strict source canonicalizer remains unchanged.

Alignment/VAD fingerprint revision 3 prevents reuse of revision-2 source and
mixed-timeline caches during regeneration. Existing saved captions and project
schema stay intact; no data deletion or migration is required. Native extraction,
cancellation, context release, model bytes and UI controls are unchanged.
Synthetic and source checks do not establish native model acceptance. The
compiled regression, fresh APK and final separately signed artifacts must pass
the affected workflows on both phones before release.