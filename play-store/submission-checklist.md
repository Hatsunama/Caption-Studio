# Caption Studio Google Play submission checklist

Verified against Google Play requirements on August 27, 2026.

## Build and release

- Upload `android/app/build/outputs/bundle/release/app-release.aab`, not the universal APK.
- Enroll in Play App Signing. To keep Play and GitHub APK installs update-compatible, securely provide the existing Caption Studio production key as the Play app-signing key, then create and protect a separate upload key. If Play creates a different app-signing key instead, distribute Play-signed off-store APKs thereafter.
- Keep package name `com.hatsunama.captionstudio` and use a new monotonically increasing version code for every upload.
- A successful current `Android commercial release gate` workflow proves the generated APK targets API 36, passes 16 KB ZIP alignment, and has no 64-bit ELF `LOAD` segment aligned below `2**14`. Do not claim a local or uploaded bundle is 16 KB compatible unless that exact source revision passes this workflow and Play Console's native-library report.
- Review Play Console's automated pre-launch, native-library, permission, and device-compatibility reports before rollout.

## Store listing assets

- App title: `Caption Studio`.
- Short description: `Create accurate local captions and style every word on your phone`.
- Prepare a 512 × 512 32-bit PNG Play icon, a 1024 × 500 JPEG or 24-bit PNG feature graphic, and at least two current phone screenshots.
- Write a truthful full description that does not promise unfinished export features.
- Declare each qualifying Play listing image or video separately in Play Console's AI-generated-content asset flow. The current Caption Studio icon artwork was AI-assisted, so declare it when used as a submitted listing asset.

## App content declarations

- Privacy policy URL: `https://hatsunama.github.io/Caption-Studio/privacy/`. Confirm that the public static page is live before completing App content.
- Data Safety: media and transcripts are processed on-device; there are no ads, accounts, tracking, or first-party analytics. Disclose the user-initiated Hugging Face model download and Google MediaPipe/ML Kit diagnostic and usage-metric collection described in `data-safety-notes.md`, then verify every answer against the current disclosures for every shipped SDK.
- Ads: No.
- App access: every feature is available without an account; no reviewer credentials are needed.
- Target audience: not designed for children under 13. Select only the age groups actually intended.
- Complete the content-rating questionnaire accurately as a video-editing/productivity app.
- Declare any other Play Console questionnaires shown for the selected countries and category.
- Foreground-service declaration is not expected: the release manifest removes unused foreground-media-playback permissions.
- Caption Studio uses on-device AI to transcribe and translate user-selected media inside an editing workflow; it does not accept prompts to generate open-ended text, images, voice, or video. Google's current guidance excludes limited-scope productivity AI that improves an existing feature, so an offensive-content reporting flow is not expected for this release. Reassess this before every release and add an in-app reporting flow before adding prompt-driven generative output.
- Background removal must remain gated by the in-app MediaPipe/ML Kit metrics disclosure. Confirm acceptance enables the feature, Not now leaves it off, and Privacy can revoke future processing.

## Account and rollout

- Complete developer identity, address, phone, email, payment-profile, and organization/D-U-N-S verification when applicable.
- Provide a public support contact and monitor it during review.
- For a personal developer account created after November 13, 2023, complete a closed test with at least 12 continuously opted-in testers for 14 days before production access can be requested.
- An internal test can start before the Data Safety form is complete; closed, open, and production tracks require the form and public privacy-policy link.
- Start with internal testing, then closed testing, then a staged production rollout after production access is granted.

## Current official references

- [Target API level requirements](https://support.google.com/googleplay/android-developer/answer/11926878)
- [Android 16 KB page-size build and ELF verification](https://developer.android.com/guide/practices/page-sizes)
- [ML Kit Android data disclosure](https://developers.google.com/ml-kit/android-data-disclosure)
- [MediaPipe terms and operational metrics](https://developers.google.com/edge/mediapipe/legal/tos)
- [Android 12 backup and device-transfer behavior](https://developer.android.com/about/versions/12/behavior-changes-12#backup-restore)
- [AI-generated content policy scope](https://support.google.com/googleplay/android-developer/answer/14094294)
- [AI-generated listing-asset declarations](https://support.google.com/googleplay/android-developer/answer/17262077)
- [Testing requirements for new personal accounts](https://support.google.com/googleplay/android-developer/answer/14151465)
