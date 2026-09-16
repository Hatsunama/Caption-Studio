# Android document access repair

Base: origin/main a6fb17d. Isolated branch: codex/android-document-grants-20260915.

## Evidence and scope

The supplied Seeker log for pid 31116 reports an ExoPlayer Source error caused by
SecurityException reading document/video%3A7121 from the Android media documents
provider. A timeline clip and cached JPEG do not establish source readability.
This is a provider-access failure; removing captions or masking player errors
cannot repair it. The log alone cannot establish when the original grant was lost.

The inspected installed Expo 57 picker uses ACTION_OPEN_DOCUMENT, but does not
retain grants in its activity result handler. The previous app import separately
called takePersistableUriPermission after decoding metadata. Project reopen
accepted cached posters without checking source grants. Android can also revoke
access outside this import flow. This patch does not claim GET_CONTENT was used
by the live APK: that APK was not inspected or replaced.

## Implementation

- CaptionMedia owns a video-only ACTION_OPEN_DOCUMENT picker. It requests read
  and persistable flags, accepts data and ClipData, retains and verifies the
  actual result grants, and opens/closes a descriptor before returning any URI.
  Providers offering only temporary access fail with an actionable error.
- New video imports and extracted-audio video selection use that contract.
  Multi-select import failure cleanup tracks all returned URIs, including videos
  not yet probed. Existing saved-project-aware release policy is retained.
- Reopen probes descriptors, independently of cached thumbnails, before playback
  mounts. A still-offered legacy grant can be retained. Lost permission, missing
  files and unavailable providers lead to explicit recovery.
- Re-link uses the original project and source IDs. It verifies video decoding,
  source duration, dimensions, rotation, known size and available edit range.
  The user must confirm the original recording: metadata is not identity proof.
  It changes only matching source URI/storage mode (including matching legacy
  background references). It preserves project revision, lifecycle, captions,
  translations, cuts, transforms, audio, posters and external draft journals.
- Multi-source changes are saved once, only after every source is resolved.
  Same-URI grant recovery requires no project write. Cancel or failed validation
  prevents editor playback from mounting and preserves recovery data. No grants
  are speculatively revoked by the native picker or recovery flow.
- No timeline/caption controls, permissions manifest, signing material or release
  configuration are changed. No large media copy or new runtime dependency.

## Limits and device steps

Persistable access survives process death/reboot only when offered by the provider
and successfully taken by the app. It cannot restore a revoked grant, deleted or
moved document, unavailable volume, or unavailable cloud content by itself.
No broad storage permission is a substitute for the original document grant.

After this native change eventually ships through a separately authorized,
same-package/same-signature update, reopen the affected project. Choose
"Select original video" and select the original recording in Android Files.
Confirm it is the same recording. If the file was deleted, restore it through its
provider first. Do not uninstall, clear app storage, delete the project, or create
a replacement project. Cancel leaves the project and recovery drafts intact;
reopen to try again. A grant lost during an already-open editor session is repaired
on the next reopen; this patch does not change the live timeline controller.

Native Android compilation and device execution are intentionally not performed
in this task. The focused host tests exercise recovery state transitions and
preservation, plus static native SAF wiring contracts. They do not prove Android
provider behavior. Device acceptance still requires: same-URI recovery of 7121;
multi-select import; process death and reboot/reopen; canceled picker; provider
without durable grants; moved/missing file; unrelated-file rejection; low-space
save failure; and verification that existing caption and translation drafts remain.

Official contract:
https://developer.android.com/training/data-storage/shared/documents-files
https://developer.android.com/reference/android/content/Intent#ACTION_OPEN_DOCUMENT
https://docs.expo.dev/versions/v57.0.0/sdk/document-picker/
