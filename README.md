# Caption Studio

Caption Studio is an Android-only, local-first automatic subtitle editor. Import a video, generate word-timed captions on the phone, then edit and style them without transcription credits, font limits, a watermark, or an API key.

## Install it on an Android phone

### Easiest: download on the phone

1. Open the [latest Caption Studio release](https://github.com/Hatsunama/Caption-Studio/releases/tag/v1.4.41) on the phone.
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
  https://github.com/Hatsunama/Caption-Studio/releases/download/v1.4.41/caption-studio-android.apk
termux-open ~/storage/downloads/caption-studio-android.apk
```

When `termux-setup-storage` runs, tap **Allow**. If `termux-open` shows a chooser, select Android's package installer. Then allow **Install unknown apps** for Termux when Android asks.

### Recommended: install from a Windows PC with the phone plugged in

1. Install Google's [Android SDK Platform Tools](https://developer.android.com/tools/releases/platform-tools).
2. On the phone, open **Settings → About phone** and tap **Build number** seven times.
3. Open **Settings → System → Developer options** and enable **USB debugging**.
4. Plug in the phone.
5. Run this PowerShell script. It downloads the maintained installer for **Caption Studio 1.4.41 or newer**, accepts exactly one authorized Android device, and never uninstalls an app or clears its data. An existing installation under the data-preserving update package is updated in place; the original production app has separate storage and is left untouched.

```powershell
$ErrorActionPreference = 'Stop'

$Installer = Join-Path $env:TEMP ("install-caption-studio-" + [Guid]::NewGuid().ToString('N') + '.ps1')

try {
    Invoke-WebRequest -UseBasicParsing `
        -Uri 'https://raw.githubusercontent.com/Hatsunama/Caption-Studio/main/scripts/install-caption-studio.ps1' `
        -OutFile $Installer
    & $Installer
}
finally {
    if (Test-Path -LiteralPath $Installer) {
        try {
            Remove-Item -LiteralPath $Installer -Force -ErrorAction Stop
            Write-Host 'Temporary installer script removed.'
        }
        catch {
            Write-Warning "Could not remove temporary installer ${Installer}: $($_.Exception.Message)"
        }
    }
}
```

The first time `adb devices` runs, unlock the phone. Tap **Allow** on **Allow USB debugging?** and optionally check **Always allow from this computer**. Run the script again if the device initially says `unauthorized`.

If Android reports `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, stop. The installed app uses a different signing identity. Do not uninstall it if its local projects or drafts matter; an uninstall can make that data unrecoverable.

The original production app and Caption Studio Fixed have different package identities. The installer updates only Caption Studio Fixed. Android verifies the signing identity and rejects mismatches without uninstalling or clearing either app.

Never uninstall or clear either app to bypass an installation failure. Keep the error output for diagnosis; uninstalling deletes local drafts and projects.

### Data-preserving side-by-side build when the production signing key is unavailable

Current Android build: **1.4.41** (`v1.4.41`, Android version code 53).

Version 1.4.41 gives every timeline object a semantic bottom-menu target. Video and audio open their own controls; original and translated captions open Captions; text and images open Stickers. A repeated selection leaves the currently correct menu mounted, preserving its current state and scroll. Caption controls now live under Captions, with caption animation visibly separated from the rest; text animation remains under Stickers.

Version 1.4.39 repairs the transcription identity failure reported on Seeker without discarding project media, captions, or edits. Mixed-clip transcription words are now explicitly timeline-owned, synthetic source caches are restored only when the mapping is lossless, project snapshots are validated before database writes, and an existing project containing the affected duplicate derived cache is recovered at the database boundary. Local translation retries now accept only one exact, ordered JSON result for every requested cue; malformed, duplicated, reordered, or cross-cue output cannot enter checkpoints. Translation ownership keys are collision-free even when track or cue identifiers contain delimiters.

Version 1.4.38 names the captions toolbar **Stickers**, keeps the active tool panel mounted when timeline objects are selected, and restores horizontal tool-menu scroll. Animations require a timeline caption or text layer unless scope is All (`Choose Text From The Timeline First`). Local translation now fail-closes on cue bleed and incomplete batch replies: exact IDs, one result per cue, no source fallback, source-relative correspondence instead of a 500-character cap, token-budget batching against the native 3600-token limit, and atomic checkpoints only after every cue in a batch validates.

Version 1.4.37 restores direct two-finger twist rotation for text and subtitle overlays. Multi-touch transforms now retain responder ownership when the second finger lands, while blank-preview taps remain isolated to deselection. Transition timing is presented on its own row before the horizontally scrolling transition presets so it is immediately accessible.

Version 1.4.36 keeps transition playback inside a truthful four-player 48 MiB buffer budget, loads composite-transition media only inside a bounded lead window, and releases it after the window. Contiguous cuts from the same source retain one active decoder and audio clock instead of pausing and seeking at every split. The fake RGB-bar transition is retired in preview and native export; existing projects migrate it to a cinematic dip. New audio is not exposed until extraction, validation, waveform decoding, and durable save finish. Tapping empty preview or timeline space clears every selected item before normal timeline seeking or scrubbing. The SDK 57 native package set is aligned to Expo's current verified patch revisions, including its explicit worklets runtime. It also includes the enlarged layer controls and topology-preserving subtitle reorder behavior from 1.4.32.

Version 1.4.29 prevents transition preview decoders from appearing as animated black panels. Composite previews stay transparent until both auxiliary players have rendered their first sought frame, disable ExoPlayer's black shutter, and reset the render gate whenever the transition sources change. Native export geometry remains unchanged because it decodes exact bitmap frames before composition. Background removal and person motion paths have been retired across the editor, preview, export planner, native compositor, privacy controls, and Android dependencies. Existing projects remain readable; legacy background metadata is retained only for safe media cleanup and is always loaded inactive.

Version 1.4.28 makes every caption-quality choice immediately enter a visible generation state before composed timeline audio is prepared. Fast, Balanced, and Accurate all use the same operation contract, and any preparation, model-download, or transcription failure now opens a plain-English failure dialog at the point of action instead of appearing only in an editor message below the fold.

Version 1.4.27 makes a video split a topology-only operation. Splitting a clip no longer divides, duplicates, retimes, rewrites, or regenerates primary or translated subtitles. Captions wholly on one side keep source ownership under the corresponding new clip ID; a caption crossing the new cut keeps its exact identity, text, timing, style, and translation while becoming explicitly timeline-owned. Timing ownership is persisted independently from automatic/manual text ownership, so later clip edits cannot silently reattach or split subtitles that a user intentionally moved or combined across clips. The project screen heading is now **Captions Locally**. Video topology and layout operations now respect the independent `timeline` ownership of added audio: splitting or reordering video preserves audio exactly, and duration-changing ripple edits can shift later audio without inferring a video owner, trimming source content, or deleting an audio block.

Version 1.4.25 keeps prepared video sources resident in a bounded two-player set, so selecting, seeking, pausing, and revisiting timeline clips do not destroy the standby decoder or return the editor to a loading screen. Caption generation now transcribes one native audible-timeline composition instead of aborting on the first original container that does not expose an embedded audio track; attached audio clips, muted state, trims, playback rate, gaps, and clip ownership remain aligned with the project timeline. Native bridge failures are translated into actionable English, cancellation stops both extraction and timeline preparation, and temporary audio is removed without changing projects, drafts, videos, app data, or signing identity.

Version 1.4.19 keeps strict multi-cue JSON and ID validation while giving a failed single-cue retry its own deterministic plain-text provider contract. The only requested cue supplies the identity; malformed JSON, Markdown wrappers, runtime tokens, source echoes, and wrong-script output still fail closed. This makes the existing untuned production model's common bare-translation response usable without weakening batch cardinality or moving provider policy into UI/project state. Translation checkpoints are invalidated for the changed retry profile. The production LiteRT-LM URL, bytes, and SHA-256 remain unchanged while the Natural multilingual v2 candidate completes its strict model and two-phone gates.

Version 1.4.18 preserves integrity-bound caption and translation model downloads across Android foreground interruptions, reserves storage only for remaining resumable bytes, and provides a real Retry action that continues the exact interrupted translation request. The controller owns recoverable operation state, the modal owns user-facing actions, transfer and storage policy remain in services, and release identity remains outside presentation code.

Version 1.4.15 keeps hold-drag reorder filmstrip tiles on-screen: reorder mode shrinks the scrollable track to filmstrip width (not the full duration timeline), scrolls the active tile into view when the gesture starts, and auto-scrolls as the drop index nears the edges, then restores playhead-synced proportional scrolling on commit/cancel.

Version 1.4.14 keeps positional CLIP # labels and adds a tiny first-frame thumbnail beside each CLIP # so clips stay identifiable after reorder. Hold-then-drag reorder now switches the video track into equal-sized filmstrip tiles (not duration-proportional bars) for the gesture, then restores the normal timeline on commit/cancel. Extracting audio always shows a local busy overlay from source choice through remux/encode. Timeline audio clips render cached amplitude waveforms. Opening the Audio tool no longer clears a selected video clip, so that clip’s embedded volume/mute/fade controls stay available alongside add/extract and separate audio-clip editors.

Version 1.4.13 repairs clip-to-clip preview handoff with a dual primed player (no black frames or audio gaps when crossing screen-recording ↔ camera clips), replaces the vertical REORDER strip with hold-then-drag filmstrip reordering that cannot leave the timeline blank or unscrollable, and remaps source-anchored captions plus related timeline audio when a video clip moves.

Version 1.4.12 fixes ripping/extracting audio from another on-device video so the resulting timeline clip plays real sound instead of silent or broken audio. Lossless AAC remux now skips duplicate codec-config samples (which previously produced unplayable m4a for expo-audio), uses the track duration after remux instead of the last sample timestamp, and falls back to on-device AAC re-encode when the source codec cannot remux into a playable MPEG-4.

Version 1.4.11 improves timeline editing: either trim edge can extend a packed (gapless) clip back out to unused source media while auto-sliding following clips. Shortening still inserts removable black gaps; extending past a gap grows the timeline instead of stopping at the gap boundary.

Version 1.4.10 makes translation quality a choice, not an export lock. The dual editor shows missing, review and skipped counts. Refresh unfinished, Refresh all, individual Refresh, and checkbox-based Refresh selected are available. Skip second line is reversible and preserves saved text. MP4, SRT and ASS exports warn about missing or unreviewed lines and offer **Export anyway**, keeping available text and omitting blank or skipped second-language lines. Original captions and projects are not deleted or rewritten by export.

Editing one language never silently refreshes another. A reminder offers Keep current text, Review lines, or Refresh these lines. Opening an existing dual editor no longer restarts translation automatically. A second-language field may remain blank while primary-text edits are saved. Reviewed text can become stale and still save/reload correctly.

Translation uses batches of at most four cues with surrounding context. Unusable outputs receive one individual retry within the same native model session, without a second model load. Completed repairs are checkpointed before cancellation; missing responses cannot masquerade as valid "OK" results. Short acknowledgements, invariant numbers/URLs and full Unicode writing systems are handled without accepting arbitrary English echoes. The prompt requests natural colloquial subtitles matching the speaker's register, without inventing slang or dialect. The model weights, CPU backend, thread limit and sampling settings have not changed; smaller batches can add prompt overhead, so a speed or translation-quality improvement is not guaranteed without phone evaluation. See [audit scope and remaining device checks](docs/audit-1.4.10.md).

Version 1.4.9 checkpoints completed translation batches in private, backup-excluded phone storage. If the app closes, return and tap Refresh: unchanged completed batches are restored, and only unfinished work needs inference. The interrupted batch may restart. Checkpoints expire after 30 days and are capped at 512 entries / 32 MiB. Changed source text, surrounding context, language, prompt or model invalidates reuse. Quality-repair passes deliberately bypass cached output so rejected translations can improve. The model, context, sampler, token limits, and CPU thread limit are unchanged. Fully cached requests skip model initialization, and progress no longer carries model-verification completion into translation progress.

Version 1.4.8 preserves individual subtitle identities through AI translation. Unusable results are marked FAILED - RETRY, successful translations and existing text are saved, and incomplete runs show a summary. Open Edit both languages and tap Refresh to repair an incomplete track. Export errors appear in a dialog; disabled and off-timeline captions no longer block MP4 export. Independent translations remain in subtitle-file output, and draft recovery operations are serialized.

The installer requires release 1.4.41 or newer and refuses older APKs while the release is building. Both download routes use Hatsunama/Caption-Studio. See [audit coverage](docs/audit-1.4.8.md).

Version 1.4.7 replaces the translation model's false transient-memory rejection with hardware-based capability checks. Eligible 64-bit devices with at least 4 GiB physical RAM now attempt the memory-mapped model load even when Android temporarily reports memory pressure. If the runtime genuinely cannot allocate enough memory, the app keeps captions unchanged and tells the user to close other apps, keep Caption Studio open, and retry.

Version 1.4.6 fixes second-language creation for existing projects with long caption identifiers. Cue creation and project loading share an identifier contract that accounts for the language-track prefix, without renaming source captions or discarding saved translations.

The data-preserving update installs as **Caption Studio** with package `com.hatsunama.captionstudio.fixed`. It does not replace, uninstall, clear, or migrate `com.hatsunama.captionstudio`, so projects and drafts in the existing app remain untouched. The two packages have separate private storage.

Use the recommended Windows PowerShell installer above to exercise integrated fixes while preserving an older production-signed installation.

The installer accepts exactly one authorized Android device, requires the current release version, verifies GitHub's APK SHA-256 digest, updates only the data-preserving package with `adb install -r`, verifies the installed version, launches it, and removes its temporary download. It never issues `adb uninstall` or `pm clear`, so existing projects remain in place during an update. If Android rejects the update because the signing certificate differs, the installer stops without uninstalling either app.

The release must also contain the 1.4.5 language-picker repair. ADB output is captured with Windows PowerShell 5.1-compatible handling: normal stderr transfer progress is not treated as installation failure; the native exit code and install success response are checked. Cleanup runs on success or failure and removes only this run's APK, empty temporary download directory, and downloaded installer script. Cleanup failures are reported, not presented as successful deletion. It does not clean phone storage or unrelated files on C:.

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
- Optional second-language subtitle tracks for every language in the in-app language picker, generated entirely on-device after one approximately 1.6 GB Qwen model download
- A centered model-download and translation dialog that clearly tells users to keep Caption Studio visible and the phone unlocked; leaving the app cancels safely and produces a plain-English retry message instead of exposing a native error
- Independently owned language tracks: editing, moving, or trimming one translated cue does not rewrite or reposition its primary cue or neighboring translated cues; explicit AI Refresh replaces only the requested translated lines
- Caption grouping from word timestamps
- A fixed-scale layered timeline: trimming either video edge visibly replaces removed source time with playable black space instead of rescaling the ruler or snapping the clip back to zero
- Magnetic clip packing by default, explicit removable gaps when wanted, hold-then-drag filmstrip tile reorder for video clips, CLIP # plus first-frame thumbs, audio waveforms, and reorderable caption, added-text, and image/sticker tracks
- Automatic playhead-follow scrolling, fractional-second ruler markings, pinch/buttons for much wider zoom ranges, and a visible zoom percentage
- A floating timeline add button for appending one or many videos to the end
- Neon pink/blue/green subtitle blocks that stay end-to-end on one lane; genuine overlaps automatically move to additional visible lanes so no subtitle can hide underneath another
- TikTok-style script boundaries: press Enter between words to split one subtitle at its spoken-word timing, or Backspace at the beginning to merge with the block above
- Always-visible left and right timing grips: drag either edge directly, even before selecting the subtitle, while the block body remains available for timeline scrolling
- Clear **Undo** and **Redo** controls directly below the video for timeline, transform, style, layer, and video-edit changes
- TikTok-style caption manipulation: drag to move, pinch to resize text, twist to rotate, resize from four large edge bars, or use the corner resize/rotate control
- Project default → caption override → word override style inheritance
- An explicit **This subtitle / All subtitles** styling decision
- One searchable font browser with 68 deliberately varied bundled fonts plus System Sans, favorites, recents, 11 optional two-color treatments, and unlimited `.ttf`/`.otf` imports
- 60 data-driven caption styles: 59 motion effects plus Classic, with word timing derived from spoken timestamps and accent color limited to Spotlight, Karaoke, and Word Flash
- Word-aware English and Chinese emoji reactions across 39 semantic categories; meaningful spoken words select their own reaction family and filler words stay clean instead of recycling a random or repeated set
- Added text and phone images with independent body-drag positioning, two-sided timing trim, playhead split, layer order, canvas movement, resizing, rotation, and deletion controls
- Source, 9:16, 16:9, 1:1, and 4:5 canvases
- Fit and Fill framing for making a wide clip fill a TikTok canvas
- Direct video drag, pinch-to-resize, two-finger rotation, size buttons, 90-degree rotation, and a precise free-angle scrubber
- Nondestructive video split, reversible two-sided edge trimming with caption restoration, speed, volume, mute, and audio fades; cropped ranges and their captions hide inside explicit removable black gaps; after a gap is removed, either edge can still extend a packed clip back out to unused source media and auto-slide following clips
- A dedicated audio timeline: import audio from the phone or extract the audio track from a selected video, then body-drag, trim or restore either source edge, split at the playhead, duplicate, mute, fade, and adjust each audio clip independently
- 30 real-footage transition effects plus Clean cut, with adjustable timing across dips, dissolves, directional wipes, slides, pushes, zooms, folds, irises, splits, color washes, shutter, spin, flash, and glitch
- Continuous playback across same-source splits and different video files, with an explicit decoder handoff that prevents fast clips from bleeding into the following clip
- An explicit Save draft / Discard / Keep editing decision whenever the user backs out of the editor
- Confirmed project deletion from a trash control on every project card; linked source videos are never deleted
- Local SQLite project snapshots

The native timeline renderer exports multiple trimmed clips, deliberate black gaps, per-clip speed and gain, inserted audio, ordered text/image layers, caption styling and speech-timed animations, and all transition families into an H.264/AAC MP4. Real footage is registered above the opaque canvas in Media3's compositor; the canvas appears only where a project intentionally has no visible video. The exporter validates the MP4 before publishing it to `Movies/Caption Studio` on Android 7 and newer, then opens Android's share sheet. Android 7–9 ask for legacy write access only when an export needs to enter the public media library. SRT and styled ASS subtitle files are available from the same Export menu. Production APKs use the dedicated Caption Studio release identity described below. Editing and exporting never rewrite the source videos.

## Architecture

- Expo SDK 57 / React Native 0.86
- Custom Android native build; this project does not run in Expo Go
- `expo-video` for hardware-backed preview
- `whisper.rn` for local inference
- Local Expo Kotlin module for Android media metadata, audio decoding, lossless audio-track extraction, timeline audio mixing, and frame compositing
- Isolated Expo Android translation module using LiteRT-LM and one pinned Qwen model for every supported source-target language pair
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

The first transcription downloads the selected model once. Later transcription can run offline while that verified model remains installed.
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

MIT. Third-party libraries and downloaded models retain their own licenses. Runtime attribution and distributable copyright notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); model revisions, provenance, sizes, and hashes are in [MODEL_NOTICES.md](MODEL_NOTICES.md). Sixty-two bundled typefaces use the SIL Open Font License 1.1. Fontdiner Swanky, Permanent Marker, Chewy, Luckiest Guy, Rock Salt, and Special Elite use Apache License 2.0. The individual font license files are preserved in [`assets/fonts/licenses`](assets/fonts/licenses), and the app includes an offline notices screen with MIT, Apache 2.0, and OFL terms.
