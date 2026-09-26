# Caption Studio Privacy Policy

Effective September 22, 2026

Caption Studio is provided by Hatsunama. It is a local-first Android video and caption editor and does not require an account.

## Local media processing

Videos, audio, images, imported fonts, transcripts, projects, and exports are processed and stored locally on the user's Android device. Caption Studio does not upload this content to Hatsunama. The app does not include advertising, first-party analytics, tracking, or cloud-transcription SDKs.

## Optional model downloads

When a user first generates captions, Caption Studio downloads one multilingual Whisper tiny model and a Silero VAD speech-detection model from Hugging Face. The network request necessarily exposes ordinary connection information, such as the user's IP address, to Hugging Face under its own policies. The user's media and transcript are not sent with the request. Caption Studio verifies each model's exact file size and SHA-256 digest before using it.

Dual-language subtitles are off by default. If the user requests natural translation for a supported caption-language pair, Caption Studio downloads one optional Qwen language model of approximately 1.6 GB from Hugging Face. The same model handles supported multilingual pairs. Caption text is processed locally after the download and is not sent to Hugging Face or Hatsunama. AI translation can be inaccurate and remains editable; the app identifies translations that need refresh or human review. Removing the model does not remove saved projects or translated text.

## Media access and sharing

Caption Studio receives only media that the user selects through Android system pickers. Finished video exports are written to the device media library. Sharing or uploading an exported file is a separate user-controlled action outside Caption Studio.

## Retention and deletion

Project data remains on the device until the user deletes the project, clears Caption Studio's app storage, or uninstalls the app. Downloaded transcription and translation models can also be removed from the in-app Privacy screen. Deleting a project removes Caption Studio-managed project files but does not delete original media selected by the user. A recovery copy requested by the user is staged in private cache only while Android's share sheet is open and is deleted when that sheet closes; interrupted stale staging files are removed after 24 hours when the project library next opens. Exported videos remain in the device media library until the user deletes them there.

## Security

Caption Studio restricts generated files to app-controlled storage, verifies downloaded model files before use, relies on Android system media selection instead of broad storage access, and disables Android cloud backup for its private app data. On Android 12 and newer, some device manufacturers can still include app data in a direct device-to-device migration even when cloud backup is disabled.

## Children

Caption Studio is a general-purpose creator tool and is not designed for children under 13.

## Changes and contact

Material changes will be published with a revised effective date. For privacy questions, security reports, copyright or DMCA notices, legal takedown requests, or reports about generated output, contact xmilo_at_your_side@proton.me. Do not include private media, transcripts, project files, device logs, or passwords in your first message.
