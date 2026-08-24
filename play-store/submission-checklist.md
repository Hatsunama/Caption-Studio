# Caption Studio Google Play submission checklist

Verified against Google Play requirements on August 24, 2026.

## Build and release

- Upload `android/app/build/outputs/bundle/release/app-release.aab`, not the universal APK.
- Enroll in Play App Signing, let Play create the app-signing key, and protect the separate Caption Studio upload keystore and passwords.
- Keep package name `com.hatsunama.captionstudio` and use a new monotonically increasing version code for every upload.
- The audited bundle targets API 36 and its 64-bit native libraries satisfy the 16 KB page-size requirement.
- Review Play Console's automated pre-launch, native-library, permission, and device-compatibility reports before rollout.

## Store listing assets

- App title: `Caption Studio`.
- Short description: `Create accurate local captions and style every word on your phone`.
- Prepare a 512 × 512 32-bit PNG Play icon, a 1024 × 500 JPEG or 24-bit PNG feature graphic, and at least two current phone screenshots.
- Write a truthful full description that does not promise unfinished export features.
- Declare each Play listing image or video as AI-created or AI-edited when the Play asset flow asks and the asset qualifies.

## App content declarations

- Privacy policy URL: `https://github.com/Hatsunama/Caption-Studio/blob/v1.3.1/PRIVACY.md` after the v1.3.1 release tag is published.
- Data Safety: media and transcripts are processed on-device; there are no ads, accounts, tracking, or first-party analytics. Disclose the user-initiated Hugging Face model download and Google's ML Kit diagnostic/usage-metric collection described in `data-safety-notes.md`, then verify every answer against the current disclosures for every shipped SDK.
- Ads: No.
- App access: every feature is available without an account; no reviewer credentials are needed.
- Target audience: not designed for children under 13. Select only the age groups actually intended.
- Complete the content-rating questionnaire accurately as a video-editing/productivity app.
- Declare any other Play Console questionnaires shown for the selected countries and category.
- Foreground-service declaration is not expected: the release manifest removes unused foreground-media-playback permissions.
- Caption Studio uses on-device AI to transcribe and improve an existing editing workflow; it does not accept prompts to generate open-ended text, images, voice, or video. Google's current guidance treats this as limited-scope productivity AI, so an offensive-content reporting flow is not expected. Reassess this before release if prompt-driven generation is added.

## Account and rollout

- Complete developer identity, address, phone, email, payment-profile, and organization/D-U-N-S verification when applicable.
- Provide a public support contact and monitor it during review.
- For a personal developer account created after November 13, 2023, complete a closed test with at least 12 continuously opted-in testers for 14 days before production access can be requested.
- An internal test can start before the Data Safety form is complete; closed, open, and production tracks require the form and public privacy-policy link.
- Start with internal testing, then closed testing, then a staged production rollout after production access is granted.
