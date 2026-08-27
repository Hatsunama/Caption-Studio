# Caption Studio

Caption Studio is an Android-only, local-first automatic subtitle editor. Import a video, generate word-timed captions on the phone, then edit and style them without transcription credits, font limits, a watermark, or an API key.

## Install it on an Android phone

### Easiest: download on the phone

1. Open the [latest Caption Studio release](https://github.com/Hatsunama/Caption-Studio/releases/latest) on the phone.
2. Tap **caption-studio-android.apk**.
3. Open the finished download.
4. If Android asks, allow **Install unknown apps** for the browser or file manager you used.
5. Tap **Install**, then open **Caption Studio**.

Android may show a Play Protect warning because this independent APK is not installed through Google Play. Check that the address is this repository before continuing. Never download the APK from a mirror or reposting site.

The current universal APK supports Android 7 or newer and includes 64-bit ARM, 32-bit ARM, x86, and x86_64 native builds. That includes the Solana Seeker and nearly all current physical Android phones.

### From Termux on the phone

This downloads the same release APK; it does not compile the app on the phone.

```bash
pkg update
pkg install curl
termux-setup-storage
curl -L -o ~/storage/downloads/caption-studio-android.apk \
  https://github.com/Hatsunama/Caption-Studio/releases/latest/download/caption-studio-android.apk
termux-open ~/storage/downloads/caption-studio-android.apk
```

When `termux-setup-storage` runs, tap **Allow**. If `termux-open` shows a chooser, select Android's package installer. Then allow **Install unknown apps** for Termux when Android asks.

### From a Windows PC with the phone plugged in

1. Install Google's [Android SDK Platform Tools](https://developer.android.com/tools/releases/platform-tools).
2. On the phone, open **Settings → About phone** and tap **Build number** seven times.
3. Open **Settings → System → Developer options** and enable **USB debugging**.
4. Plug in the phone and choose **File transfer** if Android shows a USB-mode prompt.
5. Download **caption-studio-android.apk** from the [latest release](https://github.com/Hatsunama/Caption-Studio/releases/latest) to the PC.
6. Open PowerShell in the folder containing the APK and run:

```powershell
adb devices
adb install -r .\caption-studio-android.apk
```

The first time `adb devices` runs, unlock the phone. Tap **Allow** on **Allow USB debugging?** and optionally check **Always allow from this computer**. Run the two commands again if the device initially says `unauthorized`.

## What the current Android build includes

- Multi-select Android video import that accepts any number of clips while keeping durable source links instead of duplicating full videos into app cache
- A visible loading dialog immediately after the system picker accepts the videos
- Source-orientation-aware preview
- Persistent first-frame thumbnails on project cards, with readable date/time names replacing UUIDs and camera-number filenames
- A dedicated `com.hatsunama.captionstudio` Android identity so Caption Studio installs as its own app
- On-device Whisper transcription through `whisper.rn`
- Native Android audio decoding to PCM WAV without a cloud API
- Presentation-timestamp-aware audio extraction plus on-device Silero voice-activity detection, so Whisper tokens inside opening or interior silence are rejected instead of becoming early captions
- Responsive preparation feedback that reaches 5% after 3 seconds, advances from 6% through 10% in 22-second steps, then follows real decoding progress
- Safe **Generate again** control for replacing caption text/timing while preserving the project style and added layers
- Downloadable Fast, Balanced, and Accurate Whisper model tiers
- Optional English + Simplified Chinese or English + Traditional Chinese subtitle tracks, generated entirely on-device after one approximately 1.6 GB Qwen model download
- The same optional translation model handles English-to-Chinese and Chinese-to-English; editing either language marks its linked partner stale and can refresh the affected lines without replacing the rest of the script
- Caption grouping from word timestamps
- A fixed-scale layered timeline: trimming either video edge visibly replaces removed source time with playable black space instead of rescaling the ruler or snapping the clip back to zero
- Magnetic clip packing by default, explicit removable gaps when wanted, and reorderable caption, added-text, and image/sticker tracks
- Automatic playhead-follow scrolling, fractional-second ruler markings, pinch/buttons for much wider zoom ranges, and a visible zoom percentage
- A floating timeline add button for appending one or many videos to the end
- Neon pink/blue/green subtitle blocks that stay end-to-end on one lane; genuine overlaps automatically move to additional visible lanes so no subtitle can hide underneath another
- TikTok-style script boundaries: press Enter between words to split one subtitle at its spoken-word timing, or Backspace at the beginning to merge with the block above
- Always-visible left and right timing grips: drag either edge directly, even before selecting the subtitle, while the block body remains available for timeline scrolling
- Clear **Undo** and **Redo** controls directly below the video for timeline, transform, style, layer, and video-edit changes
- TikTok-style caption manipulation: drag to move, pinch to resize text, twist to rotate, resize from four large edge bars, or use the corner resize/rotate control
- Project default → caption override → word override style inheritance
- An explicit **This subtitle / All subtitles** styling decision
- One searchable font browser with 44 deliberately varied, license-documented fonts, favorites, recents, two-color treatments, and unlimited `.ttf`/`.otf` imports
- 33 data-driven caption animations whose motion restarts from each spoken word's timestamps, including three visibly different emoji-reaction modes
- Word-aware English and Chinese emoji reactions across 39 semantic categories; meaningful spoken words select their own reaction family and filler words stay clean instead of recycling a random or repeated set
- Added text and phone images with their own timing, layer order, movement, resizing, rotation, and deletion controls
- Source, 9:16, 16:9, 1:1, and 4:5 canvases
- Fit and Fill framing for making a wide clip fill a TikTok canvas
- Direct video drag, pinch-to-resize, two-finger rotation, size buttons, 90-degree rotation, and a precise free-angle scrubber
- Nondestructive video split, reversible two-sided edge trimming with caption restoration, speed, volume, mute, and audio fades; cropped ranges and their captions hide inside explicit removable black gaps
- A dedicated audio timeline: import audio from the phone or extract the audio track from a selected video, then trim, restore, move, duplicate, mute, fade, and adjust each audio clip independently
- 43 data-driven transition treatments with adjustable timing, including dissolves, directional and diagonal wipes, slides, pushes, irises, splits, blinds, tile reveals, folds, color washes, shutter, spin, flash, ripple, and glitch
- On-device person-background removal preview and native MP4 render using the Apache-licensed MediaPipe multiclass person model; video frames and masks stay on the phone, while the optional Google SDKs send the operational metrics described in the privacy policy when the feature is enabled
- Stable, Balanced, and Detailed person-edge modes shared by preview and export, with motion-aware temporal smoothing, face protection, bad-frame rejection, hole/speck cleanup, hysteresis, and edge-aware feathering
- Exported person motion paths use the same eased position, scale, and shortest-arc rotation behavior shown in preview
- Continuous playback across same-source splits and different video files, with an explicit decoder handoff that prevents fast clips from bleeding into the following clip
- An explicit Save draft / Discard / Keep editing decision whenever the user backs out of the editor
- Confirmed project deletion from a trash control on every project card; linked source videos are never deleted
- Local SQLite project snapshots

The native timeline renderer exports multiple trimmed clips, deliberate black gaps, per-clip speed and gain, inserted audio, background replacement, person motion, ordered text/image layers, caption styling and speech-timed animations, and all transition families into an H.264/AAC MP4. It publishes finished videos to `Movies/Caption Studio` on Android 7 and newer; Android 7–9 ask for legacy write access only when an export needs to enter the public media library. SRT and styled ASS subtitle files are available from the same Export menu. Production APKs use the dedicated Caption Studio release identity described below. Editing and exporting never rewrite the source videos.

## Architecture

- Expo SDK 57 / React Native 0.86
- Custom Android native build; this project does not run in Expo Go
- `expo-video` for hardware-backed preview
- `whisper.rn` for local inference
- Local Expo Kotlin module for Android media metadata, audio decoding, lossless audio-track extraction, MediaPipe multiclass person segmentation, timeline audio mixing, and frame compositing
- Isolated Expo Android translation module using LiteRT-LM and one pinned Qwen model for all supported English–Chinese directions
- Expo SQLite for nondestructive project state

Caption appearance resolves in this order:

```text
project default style
  → caption override
    → word override
```

Video and text transforms use normalized coordinates so projects remain portable between source, preview, and export resolutions.

## Build from source on Windows

Requirements: Node.js 22.13 or newer, Android SDK 36, JDK 17, and an Android device with USB debugging enabled.

Clone to a short path such as `C:\Caption-Studio`. Android's native CMake build can exceed Windows' object-file path limit when the repository is nested deeply under Documents.

```powershell
git clone https://github.com/Hatsunama/Caption-Studio.git C:\Caption-Studio
cd C:\Caption-Studio
npm install
npm run android
```

`npm run android` generates the native Android project, applies the repository's Windows/Gradle compatibility patch, builds the app, installs it on the connected device, and launches it.

Official release builds use a dedicated Caption Studio signing key, never Expo's checked-in debug key. The private keystore and `CAPTION_STUDIO_RELEASE_*` Gradle properties stay outside the repository. Maintainers build the production-key APK with `npm run release:android`, then verify the resulting package and signing-certificate SHA-256 with Android SDK `aapt2` and `apksigner` before publishing it. The checked-in certificate lineage exists only for `npm run release:android:migration`, which creates a one-time local migration APK for devices that previously received the old beta; it is never applied to public production APKs.

The release keystore and its private Gradle properties are the permanent Android update identity. Maintainers must keep an encrypted backup outside the repository; losing that key prevents future APK updates under the same package identity.

Expo SDK 57 currently supplies Android Gradle Plugin 8.12. The repository uses Gradle 9.4 and has removed deprecated syntax from project-owned Gradle files. Remaining Gradle 10 deprecation notices originate inside that upstream Android Gradle Plugin and must be resolved by a future Expo-supported AGP upgrade; forcing AGP 9 onto this Expo release is unsupported and breaks its native plugins.

For an already-installed development build:

```powershell
adb reverse tcp:8081 tcp:8081
npx expo start --localhost
```

The first transcription downloads the selected model once. Later transcription can run offline while that verified model remains installed. Optional background removal has a separate Google operational-metrics disclosure even though its media processing stays on-device.
After installing an update that improves transcription timing, open an existing project and tap **Generate again** once to replace its previously saved word timings; project styling and added layers are preserved.

Dual-language subtitles are optional and disabled by default. Caption Studio uses one multilingual translation model for every supported English–Chinese direction, not a separate model per language. A project whose clips mix English and Chinese source languages must be split into language-consistent projects before automatic dual-language refresh; code-switching and machine translation should always be reviewed before publishing.

## Privacy and product principles

- Caption Studio's [privacy policy](PRIVACY.md) is also available from the Projects screen inside the app.
- Ordinary caption generation does not require an OpenAI API key.
- Source videos and transcription stay on the device during the normal workflow.
- No watermark, transcription credits, font packs, export quota, or per-style paywall is part of the product design.
- Imported fonts remain the user's responsibility to license for their intended use.

For a production submission, use `npm run release:play` to produce the signed Android App Bundle required by Google Play. The prepared [Play submission checklist](play-store/submission-checklist.md) and [Data Safety notes](play-store/data-safety-notes.md) record the audited release assumptions.

## License

MIT. Third-party libraries and downloaded models retain their own licenses. Runtime attribution and distributable copyright notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); model revisions, provenance, sizes, and hashes are in [MODEL_NOTICES.md](MODEL_NOTICES.md). Forty-two bundled typefaces use the SIL Open Font License 1.1; Fontdiner Swanky and Permanent Marker use Apache License 2.0. The individual font license files are preserved in [`assets/fonts/licenses`](assets/fonts/licenses), and the app includes an offline notices screen with MIT, Apache 2.0, and OFL terms.
