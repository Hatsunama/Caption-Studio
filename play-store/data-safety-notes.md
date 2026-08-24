# Caption Studio Data Safety notes

These notes describe the audited version 1.3.1 codebase and are not a substitute for answering the live Play Console form.

- No user account or account identifiers.
- No advertising or Advertising ID use.
- No first-party analytics, advertising, tracking, crash-reporting, or remote-configuration service.
- Google's bundled ML Kit SDK processes video frames and masks on-device but automatically collects encrypted operational metrics for diagnostics and usage analytics. Based on Google's current SDK disclosure, evaluate and disclose Device or other identifiers and App info and performance data, including device/app information, a per-installation identifier, performance measurements, API configuration and input/output sizes, feature versions, event types, and error codes. Google states that this data is not shared with third parties.
- No cloud transcription or media-processing backend.
- User-selected video, audio, images, fonts, captions, masks, and projects stay on-device.
- The first transcription-model selection downloads immutable, hash-pinned model files from Hugging Face. Media and transcripts are not included in those requests.
- Users initiate exports to their Android media library and control any later sharing.
- Project deletion removes app-managed project files but never the user's selected originals. Clearing app data or uninstalling removes private app data; exported media remains user-managed.
- Android cloud backup is disabled for Caption Studio's private app data.
- Recheck [Google's current ML Kit Android data-disclosure page](https://developers.google.com/ml-kit/android-data-disclosure) whenever the dependency changes and answer the live Play Console form according to its then-current categories.
