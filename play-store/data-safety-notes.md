# Caption Studio Data Safety notes

These notes describe the audited version 1.4.0 codebase and are not a substitute for answering the live Play Console form.

- No user account or account identifiers.
- No advertising or Advertising ID use.
- No first-party analytics, advertising, tracking, crash-reporting, or remote-configuration service.
- No cloud transcription or media-processing backend.
- User-selected video, audio, images, fonts, captions, masks, and projects stay on-device.
- The first transcription-model selection downloads immutable, hash-pinned multilingual Whisper and speech-detection model files from Hugging Face. Optional dual-language translation downloads one immutable, hash-pinned Qwen model of approximately 1.6 GB from Hugging Face. Media, transcripts, and translations are not included in those requests; ordinary connection information such as IP address is necessarily exposed to Hugging Face.
- English–Chinese translation runs entirely on-device after the optional model download. The same model handles English to Simplified Chinese, English to Traditional Chinese, and Chinese to English. No Google Translation SDK or translation backend is used.
- Users initiate exports to their Android media library and control any later sharing.
- Project deletion removes app-managed project files but never the user's selected originals. A user-requested recovery copy is deleted from private cache when the Android share sheet closes; interrupted staging files are removed after 24 hours when the project library next opens. Clearing app data or uninstalling removes private app data; exported media remains user-managed.
- Android cloud backup is disabled for Caption Studio's private app data. Do not claim that this universally disables device-to-device migration: on Android 12 and newer, some manufacturers can still migrate app data directly between devices.
