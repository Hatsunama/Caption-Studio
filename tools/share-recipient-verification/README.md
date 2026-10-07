# Caption Studio Verification

Isolated Android recipient-byte tool; Caption Studio is unchanged.
Package: app.captionstudio.verification.sharereceiver.
Label in launcher and sharesheet: Caption Studio Verification.
Requires Android 7/API 24 or later. CI creates an ephemeral debug key, not a
Caption Studio signing key. Each build may require uninstalling an earlier
tool APK because the ephemeral certificate changes.

## Build and evidence

Use the Share recipient verification tool manual GitHub workflow on
codex/share-recipient-verification. A push trigger restricted to this same
branch and these tool paths bootstraps workflow registration without modifying
main/integration. The workflow refuses every other branch, uses stock Java and
official Android SDK build-tools 36.0.0/platform 36, and runs pure Java tests
before SDK installation or APK compilation. No Gradle/Expo/npm dependencies.
CI artifacts retain the signed APK, its exact SHA256/byte count, tests, binary
manifest, permissions, alignment and signature evidence for seven days.
No public release is created. No app secrets or signing credentials are used.

The synthetic source-expected.srt fixture is exactly the expected serialized
First/Second/Third + Following cue case from
tests/subtitle-srt-content-boundary.test.mjs at integration commit
8067566f2e7e80667090bbe0a30ee8a083e920cc. Tests assert its exact UTF-8 bytes,
validation, SHA256 known vector, multiline/Unicode/literal timestamp content,
malformed UTF-8, empty input/cues, malformed/range/reversed timestamps, numbering,
premature blank lines, size boundary, cancellation and no-progress streams.
The build audits both source and packaged binary manifests and verifies APK signing.

## Parent-owned phone procedure

The parent owns installation and phoneADB; this task never accesses either phone.
Install the CI artifact APK. From the actual final release of Caption Studio,
share the synthetic SRT export and select Caption Studio Verification.
Keep the receiver visible until its four evidence fields finish. It waits
1500 ms before opening the URI so sender cleanup can run. Record the displayed
exact byte count, SHA256, cue count and error. Compare SHA256 and count with the
independently expected export bytes, never the filename. Error NONE means
syntactic validity, not equality to an expected source or proof of no lost captions.
The launcher displays the latest metadata within the current process without
reading a project or reopening a URI. Process death clears evidence.
No private caption text is displayed or logged. Do not upload received captions.

## Safety audit and limitations

- No requested Android permissions, networking, microphone, storage API,
  file picker, clipboard, outbound sharing, persistent grants, disk cache or
  content execution. No logs or exception messages contain URI/text.
- Only ACTION_SEND with one EXTRA_STREAM content URI, a read-grant flag and a
  verified URI read grant is accepted. Other ClipData URIs, EXTRA_TEXT, file/http
  URIs and SEND_MULTIPLE are ignored/rejected. Wildcard MIME permits ExpoSharing;
  MIME and filenames never establish validity.
- One process-wide worker with no queue opens the incoming URI read-only through
  ContentResolver.openAssetFileDescriptor and its CancellationSignal. Raw bytes
  stay in a fixed 1 MiB RAM buffer and are overwritten in finally; decoded text
  stays in bounded RAM until garbage collection. Android/provider internals and
  a privileged debugger are outside the no-cache/no-exfil guarantee.
- At most 1 MiB is read. Exact-capacity streams also fail SIZE_LIMIT_REACHED,
  because probing EOF would risk reading byte 1,048,577. No prefix digest or
  supposedly exact byte count is reported for size, cancellation or read errors.
- A 12-second timeout and stop/destroy/new-intent cancellation prevent stale
  results. Future interruption and provider cancellation are best effort:
  a hostile provider can block a read/cancel indefinitely. The one-worker/no-queue
  limit prevents replacement threads or repeated memory allocation; later shares
  fail BUSY until it returns. Restarting the tool process can recover.
- Only metadata is retained in static process RAM. No bundle/intent contains
  retained received data; view-state saving and backup are disabled.
- Strict UTF-8 (optional BOM), LF/CRLF, consecutive numbering from 1, timestamp
  ranges and positive duration, and nonempty cue content are required. Blank
  continuation text after a delimiter fails. Overlapping cue timing is allowed
  for translations. Literal number/timestamp lines within captions are allowed.
- Syntax cannot distinguish an interior blank followed by an otherwise valid
  next cue from an intentional cue boundary, nor detect omitted content or an
  absent separator before timestamp-like literal lines. Expected byte/digest
  comparison is necessary for actual release verification.
- No device/instrumentation test is performed. CI verifies Java behavior and APK
  structure; parent must verify actual sharesheet grants, sender cleanup timing,
  install/launch, lifecycle handling and final release recipient bytes on phones.
- Debuggable is intentional for the requested debug-signed tool. Do not use
  private captions on a device with an attached untrusted debugger.
