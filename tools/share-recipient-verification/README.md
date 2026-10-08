# Subtitle export verification for private APK122

Test-only package app.captionstudio.verification.sharereceiver, label
Caption Studio Verification, Android API 24+. The parent reports exact APK122
installed on both phones with SHA256
703008d89d03ccf008c5839cb254e4d3b54505fe47e6f247a7c8928a176d66db.
This app installation claim is parent-provided, not checked by CI.

## Source, executing evidence and build

Receiver base ad7a90455d971ae27d4cf16d083e4f1abeeeea82 and the original
codex/share-recipient-verification branch remain unchanged.
Use the manual .github/workflows/share-recipient-verification.yml workflow on
codex/subtitle-export-verification-122. Its branch guard permits only that branch.
Root AGENTS and its required exact https://docs.expo.dev/versions/v57.0.0/
documentation were read.

RED source: 0d79f7059bf69c9e261b5c5fc7f4f4ce6719888d.
RED execution: https://github.com/Hatsunama/Caption-Studio/actions/runs/37746199648
Original 30 checks passed; 21 of 23 new checks failed against the untouched
validator. GREEN executes the same test sources unchanged.
Original ValidatorTest and the synthetic 98-byte source-expected.srt remain.
Expected fixture SHA256:
07770511b259c6486be01ff9f168759ae15247a5244b44babb6a5dd20f14a4ed.

All builds, Android SDK installation and APK signing run on GitHub.
Stock Java, official platform/build-tools 36; no Gradle/Expo/npm dependencies.
A disposable runner debug key is deleted at exit; no Caption Studio keys or
secrets are used. A new certificate can require parent-owned removal of an
earlier tool. No app/model/publish/main changes or public release.
Seven-day artifacts contain the APK, APK SHA256/size, source pins, executing
tests, change-impact audit, binary manifest, permissions, signature and alignment.
Artifact ZIP digest and APK digest are different.

## Metadata and validation

Display fields: Format, Bytes, SHA256, Cue count, First start ms, Maximum end ms,
Error. Format is parsed from content, never established by filename/MIME.
SRT milliseconds are exact integers; ASS centiseconds multiply by 10.
First start means the first parsed cue in file order, not minimum start.
Maximum end scans every cue, not just the final event. Overlap and independently
ordered translation cues are valid. Each individual cue needs positive duration.
Error NONE means syntactic validity only. On errors, timeline is unavailable;
cue count can be a validated prefix and is not complete-file evidence.

ASS requires [Events] and declared Format with unique Start, End and final Text
columns (3-32 columns, schema line <=512 characters). Fields follow declared
order; commas and \N in Text remain intact. Non-event header/style sections,
blank lines, semicolon comments and Comment events are not cues.
Times have 1-9 hour digits, minutes/seconds 00-59, exactly two fractional digits.
Missing fields, empty text/no Dialogue, malformed/reversed/zero timing fail.
This checks event timing, not exhaustive ASS style correctness or rendering.
SRT retains consecutive numbering from 1, optional BOM, LF/CRLF, nonempty
content and literal number/timestamp caption-line behavior.

Locally authored synthetic dual timing regressions:

| Fixture | Cues | First start ms | Maximum end ms |
| --- | ---: | ---: | ---: |
| ASS primary 1.23-5.67, translation 0.99-2.34 | 2 | 1230 | 5670 |
| SRT primary 1.237-5.678, translation 0.999-2.345 | 2 | 1237 | 5678 |

## Parent-owned phone checks

This task does not install, launch, use ADB on or otherwise touch either phone.
On each parent-confirmed exact APK122, share real SRT and ASS exports to the
tool and keep it visible until Error resolves. It waits 1500 ms before opening
the granted URI. Record scalar metadata only; never upload private captions.

Require Error NONE, expected format/cue count and Maximum end ms <= independently
measured footage duration in ms. Compare first start with the expected first
cue. Use locally authored bilingual footage with independent fractional offsets
for alignment, applying the exporter's specified ms/centisecond quantization.
First/max alone cannot prove every translation cue aligns. Compare exact bytes
and SHA256 with independently expected complete export bytes where available,
or inspect the locally authored fixture under parent control.
Synthetic parser tests do not establish real APK122 export alignment.

Delayed granted read, sender cleanup, install/launch, lifecycle, footage bounds
and full dual alignment remain parent-owned phone runtime evidence.

## Bounds, safety and audit limits

BoundedRead is unchanged from the pinned base blob. VerificationActivity is
unchanged except its unknown-result metadata string, proven by undoing exactly
that replacement and comparing the base Git blob hash. The source audit proves
control-flow preservation, not a device runtime result.

Only ACTION_SEND plus one EXTRA_STREAM content URI, read-grant flag and verified
grant is accepted. ClipData/EXTRA_TEXT/other URIs and SEND_MULTIPLE are not read.
Read-only descriptor with CancellationSignal; single process-wide worker,
zero queue, 1 MiB fixed buffer, 1500 ms delay and 12-second timeout remain.
Exact-capacity streams fail without an extra EOF-probe byte. Stop/destroy/new
intent cancel; stale results are suppressed; raw bytes are wiped in finally.
Size/read/cancel failures report no prefix digest or supposed exact size.
Provider cancellation/interruption are best effort: a hostile provider may stay
blocked and later work remains BUSY without replacement threads.

Tests execute malformed times, strict invalid UTF8, byte limits, reader
cancellation and no-progress behavior. Controls/bare CR stay invalid.
No permissions, networking, file picker, clipboard, persistent grants, disk
cache, outbound sharing, raw-text display, caption logs or private-caption upload.
Only scalar evidence stays in process RAM. Intent/view/bundle saving and backup
remain disabled. Android/provider internals and privileged debuggers are outside
the RAM/privacy guarantee. Debuggable is intentional.
