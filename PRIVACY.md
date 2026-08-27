# Caption Studio Privacy Policy

Effective August 27, 2026

Caption Studio is provided by Hatsunama. It is a local-first Android video and caption editor and does not require an account.

## Local media processing

Videos, audio, images, imported fonts, transcripts, person masks, projects, and exports are processed and stored locally on the user's Android device. Caption Studio does not upload this content to Hatsunama. The app does not include advertising, first-party analytics, tracking, or cloud-transcription SDKs.

Caption Studio uses Google's MediaPipe Tasks SDK and bundled multiclass segmentation model for on-device person segmentation, and ML Kit for on-device face detection that stabilizes difficult facial edges. Before first use, Caption Studio presents a disclosure and asks for consent. Video frames, masks, and other feature inputs and outputs stay on the device. When background removal is enabled and these SDKs are used, Google's ML Kit disclosure states that ML Kit collects device and app information, a per-installation identifier, performance measurements, API configuration and input/output sizes, feature versions, event types, and error codes for diagnostics and usage analytics. Google's MediaPipe terms state that its APIs contact Google for bug fixes, updated models, and hardware-accelerator compatibility and send utilization and performance metrics. Google states that ML Kit encrypts collected data in transit and does not transfer it to third parties. The user can stop future background-removal processing from the in-app Privacy policy screen.

## Optional model downloads

When a user first chooses a transcription model, Caption Studio downloads that model and a speech-detection model from Hugging Face. The network request necessarily exposes ordinary connection information, such as the user's IP address, to Hugging Face under its own policies. The user's media and transcript are not sent with the request. Caption Studio verifies each model's exact file size and SHA-256 digest before using it.

Dual-language subtitles are off by default. If the user requests natural English–Chinese translation, Caption Studio downloads one optional Qwen language model of approximately 1.6 GB from Hugging Face. The same model handles English to Simplified Chinese, English to Traditional Chinese, and Chinese to English. Caption text is processed locally after the download and is not sent to Hugging Face or Hatsunama. AI translation can be inaccurate and remains editable; the app identifies translations that need refresh or human review. Removing the model does not remove saved projects or translated text.

## Media access and sharing

Caption Studio receives only media that the user selects through Android system pickers. Finished video exports are written to the device media library. Sharing or uploading an exported file is a separate user-controlled action outside Caption Studio.

## Retention and deletion

Project data remains on the device until the user deletes the project, clears Caption Studio's app storage, or uninstalls the app. Downloaded transcription and translation models can also be removed from the in-app Privacy screen. Deleting a project removes Caption Studio-managed project files but does not delete original media selected by the user. A recovery copy requested by the user is staged in private cache only while Android's share sheet is open and is deleted when that sheet closes; interrupted stale staging files are removed after 24 hours when the project library next opens. Exported videos remain in the device media library until the user deletes them there.

## Security

Caption Studio restricts generated files to app-controlled storage, verifies downloaded model files before use, relies on Android system media selection instead of broad storage access, and disables Android cloud backup for its private app data. On Android 12 and newer, some device manufacturers can still include app data in a direct device-to-device migration even when cloud backup is disabled.

## Children

Caption Studio is a general-purpose creator tool and is not designed for children under 13.

## Changes and contact

Material changes will be published at this URL with a revised effective date. Submit a confidential privacy or security concern through [GitHub's private security-advisory form](https://github.com/Hatsunama/Caption-Studio/security/advisories/new), which requires a GitHub account. General questions can use the [public Caption Studio issue tracker](https://github.com/Hatsunama/Caption-Studio/issues/new), but users must not post personal information, private media, transcripts, project files, or device logs there.
