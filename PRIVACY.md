# Caption Studio Privacy Policy

Effective August 24, 2026

Caption Studio is provided by Hatsunama. It is a local-first Android video and caption editor and does not require an account.

## Local media processing

Videos, audio, images, imported fonts, transcripts, person masks, projects, and exports are processed and stored locally on the user's Android device. Caption Studio does not upload this content to Hatsunama. The app does not include advertising, first-party analytics, tracking, or cloud-transcription SDKs.

Caption Studio uses Google's bundled ML Kit SDK for on-device person segmentation and face detection. Google states that ML Kit does not send feature inputs or outputs, such as video frames or masks, to its servers. ML Kit may send encrypted operational metrics to Google for diagnostics and usage analytics, including device and app information, a per-installation identifier, performance measurements, API configuration and input/output sizes, feature versions, event types, and error codes. Google states that it does not transfer this collected data to third parties.

## Transcription model downloads

When a user first chooses a transcription model, Caption Studio downloads that model and a speech-detection model from Hugging Face. The network request necessarily exposes ordinary connection information, such as the user's IP address, to Hugging Face under its own policies. The user's media and transcript are not sent with the request. Caption Studio verifies each model's exact file size and SHA-256 digest before using it.

## Media access and sharing

Caption Studio receives only media that the user selects through Android system pickers. Finished exports are written to the device media library when the Android version supports that workflow. Sharing or uploading an exported file is a separate user-controlled action outside Caption Studio.

## Retention and deletion

Project data and downloaded models remain on the device until the user deletes the project, clears Caption Studio's app storage, or uninstalls the app. Deleting a project removes Caption Studio-managed project files but does not delete original media selected by the user. Exported videos remain in the device media library until the user deletes them there.

## Security

Caption Studio restricts generated files to app-controlled storage, verifies downloaded model files before use, relies on Android system media selection instead of broad storage access, and disables Android cloud backup for its private app data.

## Children

Caption Studio is a general-purpose creator tool and is not designed for children under 13.

## Changes and contact

Material changes will be published at this URL with a revised effective date. Questions or privacy concerns can be submitted through the [Caption Studio issue tracker](https://github.com/Hatsunama/Caption-Studio/issues/new).
