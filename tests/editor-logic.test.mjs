import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ANIMATION_PRESETS, reactionEmojis } from '../src/lib/animation-presets.ts';
import { VIDEO_TRANSITION_PRESETS } from '../src/lib/transition-presets.ts';
import { resolvePersonTransform, upsertPersonKeyframe } from '../src/lib/person-motion.ts';
import { PERSON_MATTE_PRESETS } from '../src/lib/person-matte-presets.ts';
import { groupTimelineWordsByClip, groupWordsIntoCaptions } from '../src/lib/caption-grouping.ts';
import { alignWordsToSpeech } from '../src/lib/speech-alignment.ts';
import { coalesceWhisperWords } from '../src/lib/whisper-words.ts';
import { packTimelineLanes } from '../src/lib/timeline-layout.ts';
import { minimumTimelineScale, timelineScrollOffset, timelineTickInterval, timelineTimeAtScroll, timelineWidth } from '../src/lib/timeline-scale.ts';
import { PREPARING_AUDIO_CUES } from '../src/lib/transcription-progress.ts';
import { humanVideoName, isMachineVideoName } from '../src/lib/project-presentation.ts';
import { applyCaptionTextChanges } from '../src/lib/caption-text-edits.ts';
import { serializeAss, serializeSrt } from '../src/lib/subtitle-export.ts';
import { mergeCaptionScriptBlock, splitCaptionScriptBlock, splitCaptionScriptBlockAtTime } from '../src/lib/caption-script.ts';
import { deleteVideoClip, previewVideoClipTrim, setCaptionTiming, setVideoClipGap, setVideoTransition, splitVideoClip, trimVideoClip } from '../src/lib/project-editor.ts';
import { addAudioSourceToProject, audioClipEnd, audioClipVolume, deleteAudioClip, moveAudioClip, trimAudioClip, updateAudioClip } from '../src/lib/audio-timeline.ts';
import {
  buildClipTimeline,
  clipPlaybackVolume,
  mapSourceWordsToTimeline,
  recoverCanonicalSourceWords,
  timelineSegmentAt,
  totalClipDuration,
  visibleTimelineCaptions,
  videoTransitionOverlay,
} from '../src/lib/video-timeline.ts';

test('inserted audio is persistent, trimmable, movable, and independently mutable', () => {
  const project = { audioSources: [], audioClips: [], updatedAt: 'before' };
  const source = { id: 'audio-source', uri: 'file:///audio.m4a', storageMode: 'copied', displayName: 'Interview audio', durationMs: 8_000, origin: 'audio-file' };
  const inserted = addAudioSourceToProject(project, source, 'audio-clip', 2_000, 12_000);
  assert.ok(inserted);
  assert.equal(audioClipEnd(inserted.clip), 10_000);
  const trimmed = trimAudioClip(inserted.project, 'audio-clip', 'start', 3_000, 12_000);
  assert.equal(trimmed.audioClips[0].sourceStartMs, 1_000);
  const restored = trimAudioClip(trimmed, 'audio-clip', 'start', 2_000, 12_000);
  assert.equal(restored.audioClips[0].sourceStartMs, 0);
  const moved = moveAudioClip(restored, 'audio-clip', 4_000, 12_000);
  assert.equal(moved.audioClips[0].startMs, 4_000);
  const muted = updateAudioClip(moved, 'audio-clip', { muted: true, volume: 0.4, fadeInMs: 500 });
  assert.equal(audioClipVolume(muted.audioClips[0], 4_250), 0);
  assert.equal(deleteAudioClip(muted, 'audio-clip').audioClips.length, 0);
});

test('video transitions are boundary-owned and deterministic', () => {
  const clip = (id, sourceId) => ({ id, sourceId, sourceStartMs: 0, sourceEndMs: 4_000, availableSourceStartMs: 0, availableSourceEndMs: 4_000, playbackRate: 1, volume: 1, muted: false, fadeInMs: 0, fadeOutMs: 0, gapBeforeMs: 0, gapAfterMs: 0, transitionAfter: { type: 'none', durationMs: 0 } });
  const project = { clips: [clip('a', 'one'), clip('b', 'two')], updatedAt: 'before' };
  const transitioned = setVideoTransition(project, 'a', 'dip-white', 500);
  const overlay = videoTransitionOverlay(buildClipTimeline(transitioned.clips), 4_000);
  assert.deepEqual(overlay, { type: 'dip-white', color: '#FFFFFF', opacity: 1, phase: 0.5, peak: 1 });
  assert.equal(setVideoTransition(transitioned, 'b', 'flash', 500), transitioned);
});

test('creative catalogs stay broad, unique, and data-driven', () => {
  const unique = (values) => new Set(values).size === values.length;
  assert.ok(ANIMATION_PRESETS.length >= 30);
  assert.ok(VIDEO_TRANSITION_PRESETS.length >= 15);
  const fontCatalog = readFileSync(new URL('../src/lib/font-catalog.ts', import.meta.url), 'utf8');
  const fontFamilies = [...fontCatalog.matchAll(/choice\('[^']+',\s*'([^']+)'/g)].map((match) => match[1]);
  assert.ok(fontFamilies.length >= 40);
  assert.ok(unique(ANIMATION_PRESETS.map((preset) => preset.id)));
  assert.ok(unique(VIDEO_TRANSITION_PRESETS.map((preset) => preset.id)));
  assert.ok(unique(fontFamilies));
  assert.equal((fontCatalog.match(/require\('\.\.\/\.\.\/assets\/fonts\//g) ?? []).length, fontFamilies.length);
});

test('person motion paths interpolate deterministically and rotate by the shortest arc', () => {
  const base = {
    enabled: true,
    mask: { threshold: 0.5, softness: 0.18 },
    personTransform: { position: { x: 0.5, y: 0.5 }, scale: 1, rotation: 0 },
    keyframes: [],
  };
  const first = { id: 'a', timeMs: 0, position: { x: 0.2, y: 0.3 }, scale: 0.8, rotation: 170 };
  const second = { id: 'b', timeMs: 1_000, position: { x: 0.8, y: 0.7 }, scale: 1.4, rotation: -170 };
  const keyframes = upsertPersonKeyframe(upsertPersonKeyframe([], second), first);
  const middle = resolvePersonTransform({ ...base, keyframes }, 500);
  assert.deepEqual(middle.position, { x: 0.5, y: 0.5 });
  assert.equal(middle.scale, 1.1);
  assert.equal(middle.rotation, -180);
});

test('person matte quality presets are distinct and shared by preview and export', () => {
  assert.deepEqual(Object.keys(PERSON_MATTE_PRESETS), ['stable', 'balanced', 'detailed']);
  assert.ok(PERSON_MATTE_PRESETS.stable.temporalStability > PERSON_MATTE_PRESETS.balanced.temporalStability);
  assert.ok(PERSON_MATTE_PRESETS.balanced.temporalStability > PERSON_MATTE_PRESETS.detailed.temporalStability);
  const preview = readFileSync(new URL('../src/services/person-compositor.ts', import.meta.url), 'utf8');
  const exporter = readFileSync(new URL('../src/lib/export-render-plan.ts', import.meta.url), 'utf8');
  const nativeMatte = readFileSync(new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/PersonMatteProcessor.kt', import.meta.url), 'utf8');
  assert.match(preview, /qualityPreset: options\.background\.mask\.qualityPreset/);
  assert.match(exporter, /qualityPreset: project\.backgroundReplacement\.mask\.qualityPreset/);
  assert.match(nativeMatte, /protectFaces/);
  assert.match(nativeMatte, /maximumHoldFrames/);
  assert.match(nativeMatte, /cleanupMask/);
});

test('audio and transition ownership stays out of the editor screen', () => {
  const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
  const audioDomain = readFileSync(new URL('../src/lib/audio-timeline.ts', import.meta.url), 'utf8');
  const nativeMedia = readFileSync(new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/CaptionMediaModule.kt', import.meta.url), 'utf8');
  assert.match(editor, /appendAudioToProject/);
  assert.match(audioDomain, /export function trimAudioClip/);
  assert.match(nativeMedia, /MediaMuxer/);
  assert.doesNotMatch(editor, /MediaExtractor|DocumentPicker/);
});

test('Caption Studio has an isolated Android identity', () => {
  const appConfig = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
  assert.equal(appConfig.expo.android.package, 'com.hatsunama.captionstudio');
  assert.doesNotMatch(JSON.stringify(appConfig), /cuecam/i);
});

test('video acquisition links the selected source without a hidden picker copy', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const appConfig = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
  const mediaStorage = readFileSync(new URL('../src/services/media-import.ts', import.meta.url), 'utf8');
  assert.equal(packageJson.dependencies['expo-image-picker'], undefined);
  assert.equal(packageJson.dependencies['expo-media-library'], undefined);
  assert.doesNotMatch(JSON.stringify(appConfig.expo.plugins), /image-picker|media-library/);
  assert.match(mediaStorage, /type: 'video\/\*'[\s\S]*copyToCacheDirectory: false/);
  assert.match(mediaStorage, /multiple: true/);
  assert.match(mediaStorage, /persistReadPermission\(asset\.uri\)/);
});

test('timeline export is native, local, multi-track, and version-aligned', () => {
  const nativeGradle = readFileSync(new URL('../modules/caption-media/android/build.gradle', import.meta.url), 'utf8');
  const exporter = readFileSync(new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/TimelineVideoExporter.kt', import.meta.url), 'utf8');
  const transitionTimeline = readFileSync(new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/TimelineTransitionTimeline.kt', import.meta.url), 'utf8');
  const renderPlan = readFileSync(new URL('../src/lib/export-render-plan.ts', import.meta.url), 'utf8');
  const segmenter = readFileSync(new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/MediaPipePersonSegmenter.kt', import.meta.url), 'utf8');
  const nativeModule = readFileSync(new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/CaptionMediaModule.kt', import.meta.url), 'utf8');
  const motionPath = readFileSync(new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/PersonMotionPath.kt', import.meta.url), 'utf8');
  const bitmapMatte = readFileSync(new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/BitmapMatte.kt', import.meta.url), 'utf8');
  const exportService = readFileSync(new URL('../src/services/project-export.ts', import.meta.url), 'utf8');
  const previewService = readFileSync(new URL('../src/services/person-compositor.ts', import.meta.url), 'utf8');
  assert.match(nativeGradle, /media3-transformer:1\.10\.1/);
  assert.match(nativeGradle, /media3-effect:1\.10\.1/);
  assert.match(nativeGradle, /tasks-vision:0\.10\.32/);
  assert.doesNotMatch(nativeGradle, /segmentation-selfie|beta/);
  assert.match(exporter, /OverlayEffect/);
  assert.match(exporter, /MediaStore\.Video\.Media\.EXTERNAL_CONTENT_URI/);
  assert.match(exporter, /Environment\.getExternalStoragePublicDirectory/);
  assert.match(exporter, /builder\.addGap/);
  assert.match(exporter, /setSpeed\(ConstantSpeedProvider/);
  assert.match(exporter, /buildNativeVideoSequence/);
  assert.match(exporter, /TimelineVideoCompositorSettings/);
  assert.match(exporter, /Presentation\.createForWidthAndHeight/);
  assert.match(exporter, /GainProcessor/);
  assert.match(exporter, /filter \{ timeMs >= it\.startMs && timeMs < it\.endMs \}/);
  assert.match(transitionTimeline, /incoming\.timelineStartMs == outgoing\.timelineEndMs/);
  assert.match(transitionTimeline, /outgoingSourceTimeMs/);
  assert.match(transitionTimeline, /incomingSourceTimeMs/);
  assert.match(transitionTimeline, /transitionAudioGain/);
  assert.match(exporter, /availableDurationMs/);
  assert.match(exportService, /buildTimelineRenderPlan/);
  assert.doesNotMatch(exportService, /clips\.length !== 1|playbackRate !== 1/);
  assert.match(renderPlan, /resolveCaptionStyle/);
  assert.match(renderPlan, /audioClips/);
  assert.match(segmenter, /selfie_multiclass_256x256\.tflite/);
  assert.match(segmenter, /1f - buffer\.float/);
  assert.match(exporter, /personMotion.*resolve/);
  assert.match(motionPath, /shortestAngle/);
  assert.match(bitmapMatte, /PorterDuff\.Mode\.DST_IN/);
  assert.match(exporter, /override fun configure\(videoSize: Size\)/);
  assert.match(exporter, /drawImageLayer/);
  assert.match(exporter, /drawTransition/);
  assert.match(exporter, /TimelineTextPainter/);
  assert.match(previewService, /queue\.running/);
  assert.match(previewService, /queue\.pending = job/);
  assert.match(previewService, /superseded by a newer frame/);
  assert.ok((nativeModule.match(/METADATA_KEY_VIDEO_ROTATION/g) ?? []).length >= 2);
  assert.match(nativeModule, /foreground = decoded/);
  assert.match(exporter, /orientBitmapAndRecycle\(decoded, orientation\)/);
});

test('subtitle serializers emit standards-compliant timing and escaped styling', () => {
  const style = {
    font: { id: 'test', family: 'Caption-Anton', source: 'built-in', postScriptName: 'Anton' },
    fontSize: 48, fontWeight: '800', italic: false, textColor: '#112233', secondaryTextColor: '#FFFFFF', textTreatment: 'solid', activeWordColor: '#FFFF00',
    stroke: { color: '#000000', width: 3 }, shadow: { color: '#000000', opacity: 0.5, blur: 4, offsetX: 1, offsetY: 2 },
    background: { color: '#000000', opacity: 0, radius: 0, paddingX: 0, paddingY: 0 }, alignment: 'center', letterSpacing: 0,
    lineHeight: 1, textTransform: 'none', position: { x: 0.5, y: 0.8 }, box: { width: 0.8, height: 0.2 }, rotation: 0, maxLines: 2,
    animation: { id: 'none', intensity: 0, durationMs: 1 },
  };
  const project = {
    captions: [{ id: 'c1', text: 'Hello, {world}', startMs: 1_234, endMs: 4_567, wordIds: [] }],
    projectStyle: style,
    canvas: { aspectWidth: 9, aspectHeight: 16 },
  };
  assert.match(serializeSrt(project), /00:00:01,234 --> 00:00:04,567/);
  const ass = serializeAss(project);
  assert.match(ass, /Dialogue: 0,0:00:01\.23,0:00:04\.57/);
  assert.match(ass, /\\fnAnton/);
  assert.match(ass, /Hello, \\{world\\}/);
  assert.doesNotMatch(ass, /Hello\\,/);

  const wordStyled = {
    ...project,
    captions: [{ id: 'c1', text: 'Hello world', startMs: 1_234, endMs: 4_567, wordIds: ['w1', 'w2'] }],
    transcription: {
      words: [
        { id: 'w1', text: 'Hello', startMs: 1_234, endMs: 2_000 },
        { id: 'w2', text: 'world', startMs: 2_001, endMs: 4_567, styleOverride: { textColor: '#00FF00', fontSize: 72 } },
      ],
    },
  };
  const styledAss = serializeAss(wordStyled);
  assert.match(styledAss, /\{\\fnAnton\\fs216[^}]*\\c&H0000FF00&/);
});

test('native person mattes preserve the generated alpha channel during composition', () => {
  const matte = readFileSync(new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/BitmapMatte.kt', import.meta.url), 'utf8');
  const processor = readFileSync(new URL('../modules/caption-media/android/src/main/java/app/captionstudio/media/PersonMatteProcessor.kt', import.meta.url), 'utf8');
  assert.match(matte, /Bitmap\.createBitmap\(source\.width, source\.height, Bitmap\.Config\.ARGB_8888\)/);
  assert.match(matte, /setHasAlpha\(true\)/);
  assert.match(matte, /eraseColor\(Color\.TRANSPARENT\)/);
  assert.match(matte, /Bitmap\.createBitmap\(maskPixels, maskWidth, maskHeight, Bitmap\.Config\.ARGB_8888\)/);
  assert.doesNotMatch(matte, /Bitmap\.Config\.ALPHA_8/);
  assert.doesNotMatch(matte, /source\.copy\(Bitmap\.Config\.ARGB_8888/);
  assert.match(processor, /val evidence = max\(confidence\[index\], prior\?\.get\(index\) \?: 0f\)/);
  assert.match(processor, /face\.width\(\) \* 0\.42f/);
  assert.match(processor, /face\.height\(\) \* 0\.52f/);
  assert.match(processor, /evidence >= 0\.24f/);
  assert.match(processor, /prior\[index\]\.toInt\(\) and 0xff\) >= 128/);
  assert.doesNotMatch(processor, /centerWeight > 0\.42f/);
  assert.doesNotMatch(processor, /face\.width\(\) \* 0\.72f|face\.height\(\) \* 0\.92f/);
});

test('provider URIs stay in persistence and never cross the navigation URL', () => {
  const projectsScreen = readFileSync(new URL('../src/app/index.tsx', import.meta.url), 'utf8');
  const editorScreen = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(projectsScreen, /params:\s*\{[^}]*uri:/);
  assert.doesNotMatch(editorScreen, /CaptionMedia|expo-document-picker|expo-image-picker/);
  assert.match(projectsScreen, /params: \{ projectId: project\.id \}/);
});

test('caption trim grips remain available on both edges without covering adjacent blocks', () => {
  const timeline = readFileSync(new URL('../src/components/editor/layer-timeline.tsx', import.meta.url), 'utf8');
  assert.match(timeline, /<TimingGrip side="start" \{\.\.\.props\} \/>/);
  assert.match(timeline, /<TimingGrip side="end" \{\.\.\.props\} \/>/);
  const grip = timeline.slice(timeline.indexOf('function TimingGrip'));
  assert.match(grip, /\[props\.side === 'start' \? 'left' : 'right'\]: 0/);
  assert.doesNotMatch(grip, /\[props\.side === 'start' \? 'left' : 'right'\]: -/);
});

test('downloaded transcription models are pinned by SHA-256', () => {
  const modelCatalog = readFileSync(new URL('../src/lib/model-catalog.ts', import.meta.url), 'utf8');
  const transcription = readFileSync(new URL('../src/services/transcription.ts', import.meta.url), 'utf8');
  assert.equal((modelCatalog.match(/sha256:/g) ?? []).length, 4);
  assert.match(transcription, /CaptionMedia\.sha256/);
  assert.match(transcription, /\.download/);
  assert.doesNotMatch(transcription, /huggingface\.co\/[^'"`]+\/resolve\/main\//);
});

test('Whisper token pieces become human words without losing their timing', () => {
  const words = coalesceWhisperWords([
    { text: ' melan', t0: 100, t1: 120 },
    { text: 'oma', t0: 120, t1: 145 },
    { text: ',', t0: 145, t1: 150 },
    { text: ' Key', t0: 160, t1: 180 },
    { text: 'tr', t0: 180, t1: 195 },
    { text: 'uda', t0: 195, t1: 220 },
    { text: ' can', t0: 230, t1: 245 },
    { text: "'t", t0: 245, t1: 255 },
    { text: ' H', t0: 260, t1: 270 },
    { text: 'LA', t0: 270, t1: 285 },
    { text: ' [MUSIC]', t0: 290, t1: 400 },
  ]);

  assert.deepEqual(words.map((word) => word.text), ['melanoma,', 'Keytruda', "can't", 'HLA']);
  assert.deepEqual(
    words.map(({ startMs, endMs }) => [startMs, endMs]),
    [[1_000, 1_500], [1_600, 2_200], [2_300, 2_550], [2_600, 2_850]],
  );
});

test('caption quality is chosen explicitly and the requested model owns generation', () => {
  const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
  const pipeline = readFileSync(new URL('../src/services/project-transcription.ts', import.meta.url), 'utf8');
  assert.match(editor, /TRANSCRIPTION_MODELS\.map/);
  assert.match(editor, /model\.id === 'balanced'[\s\S]*recommended/);
  assert.match(pipeline, /modelId: TranscriptionModel\['id'\]/);
  assert.doesNotMatch(pipeline, /modelId: 'fast'/);
  assert.match(pipeline, /canReuseSourceTranscription\(sourceResults\[sourceId\], modelId, sourceFingerprint\)/);
  assert.match(pipeline, /CaptionMedia\.sha256\(source\.uri\)/);
});

test('Expo owns video-player release and editor teardown never commands a released player', () => {
  const controller = readFileSync(new URL('../src/hooks/use-timeline-video-controller.ts', import.meta.url), 'utf8');
  const teardownStart = controller.indexOf('return () => {');
  const teardown = controller.slice(teardownStart, controller.indexOf('}, [player]);', teardownStart));
  assert.match(teardown, /mountedRef\.current = false/);
  assert.match(teardown, /desiredRef\.current = undefined/);
  assert.doesNotMatch(teardown, /player\.(?:pause|play|replace|release)/);

  const transitionPreview = readFileSync(new URL('../src/hooks/use-video-transition-preview.ts', import.meta.url), 'utf8');
  const transitionTeardownStart = transitionPreview.lastIndexOf('useEffect(() => () => {');
  const transitionTeardown = transitionPreview.slice(
    transitionTeardownStart,
    transitionPreview.indexOf('}, []);', transitionTeardownStart),
  );
  assert.match(transitionTeardown, /mountedRef\.current = false/);
  assert.match(transitionTeardown, /desiredRef\.current = undefined/);
  assert.doesNotMatch(transitionTeardown, /(?:outgoingPlayer|incomingPlayer)\.(?:pause|play|replace|release)/);
});

test('production builds cannot use the debug signing config', () => {
  const appConfig = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
  const packageConfig = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const patchScript = readFileSync(new URL('../scripts/patch-react-native-gradle.js', import.meta.url), 'utf8');
  const releaseScript = readFileSync(new URL('../scripts/configure-android-release.js', import.meta.url), 'utf8');
  const signingScript = readFileSync(new URL('../scripts/sign-android-release.js', import.meta.url), 'utf8');
  const mediaManifest = readFileSync(new URL('../modules/caption-media/android/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  const legacyPermissionPlugin = readFileSync(new URL('../plugins/with-legacy-export-permission.js', import.meta.url), 'utf8');
  const soLoaderPlugin = readFileSync(new URL('../plugins/with-soloader-metadata.js', import.meta.url), 'utf8');
  assert.match(patchScript, /configureAndroidRelease/);
  assert.match(releaseScript, /hasCaptionStudioReleaseSigning/);
  assert.match(releaseScript, /signingConfig = signingConfigs\.release/);
  assert.match(releaseScript, /com\.android\.tools:r8:8\.13\.19/);
  assert.match(signingScript, /CAPTION_STUDIO_RELEASE_STORE_FILE/);
  assert.match(signingScript, /only for the one-time debug-to-production migration APK/);
  assert.match(signingScript, /'--lineage', lineage/);
  assert.doesNotMatch(packageConfig.scripts['release:android'], /sign-android-release/);
  assert.match(packageConfig.scripts['release:android:migration'], /sign-android-release\.js --migration/);
  assert.deepEqual(appConfig.expo.android.blockedPermissions.sort(), [
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.RECORD_AUDIO',
    'android.permission.SYSTEM_ALERT_WINDOW',
  ]);
  assert.match(mediaManifest, /WRITE_EXTERNAL_STORAGE/);
  assert.match(mediaManifest, /maxSdkVersion="28"/);
  assert.match(legacyPermissionPlugin, /'android:maxSdkVersion': '28'/);
  assert.doesNotMatch(legacyPermissionPlugin, /com\.facebook\.soloader\.enabled/);
  assert.doesNotMatch(soLoaderPlugin, /WRITE_EXTERNAL_STORAGE/);
  assert.match(soLoaderPlugin, /com\.facebook\.soloader\.enabled/);
  assert.match(soLoaderPlugin, /'tools:replace': 'android:value'/);
});

test('Play releases use a signed app bundle and expose an in-app privacy policy', () => {
  const appConfig = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
  const packageConfig = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const homeScreen = readFileSync(new URL('../src/app/index.tsx', import.meta.url), 'utf8');
  const privacyScreen = readFileSync(new URL('../src/app/privacy.tsx', import.meta.url), 'utf8');
  const privacyPolicy = readFileSync(new URL('../PRIVACY.md', import.meta.url), 'utf8');
  assert.match(packageConfig.scripts['release:play'], /bundleRelease/);
  assert.equal(appConfig.expo.android.allowBackup, false);
  assert.match(homeScreen, /router\.push\('\/privacy'\)/);
  assert.match(privacyScreen, /Caption Studio privacy policy/);
  assert.match(privacyPolicy, /does not include advertising, first-party analytics, tracking, or cloud-transcription SDKs/);
  assert.match(privacyPolicy, /MediaPipe Tasks SDK and bundled multiclass segmentation model/);
  assert.match(privacyPolicy, /ML Kit collects device and app information, a per-installation identifier/);
  assert.match(privacyPolicy, /Video frames, masks, and other feature inputs and outputs stay on the device/);
  assert.match(privacyPolicy, /MediaPipe terms state that its APIs contact Google/);
});

test('clips magnetically pack by default while intentional gaps remain explicit and removable', () => {
  const timeline = buildClipTimeline([
    clip({ id: 'one', sourceStartMs: 5_000, sourceEndMs: 8_000 }),
    clip({ id: 'two', sourceStartMs: 20_000, sourceEndMs: 22_500, gapBeforeMs: 750 }),
  ]);
  assert.deepEqual(timeline.map(({ gapStartMs, startMs, endMs }) => [gapStartMs, startMs, endMs]), [
    [0, 0, 3_000],
    [3_000, 3_750, 6_250],
  ]);
  assert.deepEqual(timelineSegmentAt(timeline, 3_200), {
    kind: 'gap',
    startMs: 3_000,
    endMs: 3_750,
    next: timeline[1],
  });

  const project = projectFixture({ clips: timeline.map(({ clip: item }) => item) });
  const removed = setVideoClipGap(project, 'two', 0);
  assert.ok(removed);
  assert.deepEqual(buildClipTimeline(removed.project.clips).map(({ startMs, endMs }) => [startMs, endMs]), [
    [0, 3_000],
    [3_000, 5_500],
  ]);
});

test('video clip body owns Android drag arbitration instead of competing with a parent pressable', () => {
  const timeline = readFileSync(new URL('../src/components/editor/layer-timeline.tsx', import.meta.url), 'utf8');
  const clipBlock = timeline.slice(timeline.indexOf('function VideoClipBlock'), timeline.indexOf('function VideoTrimGrip'));
  const moveGrip = timeline.slice(timeline.indexOf('function VideoMoveGrip'), timeline.indexOf('function VideoGapBlock'));
  assert.match(clipBlock, /<View[\s\S]*<VideoMoveGrip/);
  assert.doesNotMatch(clipBlock, /<Pressable/);
  assert.match(moveGrip, /onStartShouldSetPanResponder: \(\) => true/);
  assert.match(moveGrip, /draggedRef/);
});

test('both clip handles can restore trimmed media without losing edited captions', () => {
  const sourceWords = [
    { id: 'early', text: 'restored', startMs: 200, endMs: 700 },
    { id: 'middle', text: 'manual', startMs: 1_500, endMs: 2_000 },
    { id: 'late', text: 'ending', startMs: 3_200, endMs: 3_700 },
  ];
  const project = projectFixture({
    clips: [clip({ id: 'main', sourceEndMs: 4_000, availableSourceEndMs: 4_000 })],
    transcription: {
      language: 'en',
      modelId: 'fast',
      words: sourceWords.map((word) => ({ ...word, id: `main-${word.id}` })),
      sourceResults: {
        source: { language: 'en', modelId: 'fast', generatedAt: '2026-01-01T00:00:00.000Z', words: sourceWords },
      },
    },
    captions: [{
      id: 'caption-early',
      text: 'My edited opening',
      textMode: 'manual',
      startMs: 200,
      endMs: 700,
      wordIds: ['main-early'],
      timelineVisible: true,
      sourceAnchor: { clipId: 'main', sourceStartMs: 200, sourceEndMs: 700, wordIds: ['main-early'] },
      styleOverride: { textColor: '#19D98B' },
    }],
  });

  const headTrimmed = trimVideoClip(project, 'main', 'start', 1_000);
  assert.ok(headTrimmed);
  assert.equal(headTrimmed.project.clips[0].gapBeforeMs, 1_000);
  assert.equal(totalClipDuration(headTrimmed.project.clips), 4_000);
  assert.equal(visibleTimelineCaptions(headTrimmed.project.captions).length, 0);
  const headRestored = trimVideoClip(headTrimmed.project, 'main', 'start', 0);
  assert.ok(headRestored);
  assert.deepEqual(headRestored.project.clips.map(({ sourceStartMs, sourceEndMs }) => [sourceStartMs, sourceEndMs]), [[0, 4_000]]);
  assert.equal(headRestored.project.clips[0].gapBeforeMs, 0);
  assert.deepEqual(visibleTimelineCaptions(headRestored.project.captions).map(({ id, text, styleOverride }) => ({ id, text, styleOverride })), [{
    id: 'caption-early',
    text: 'My edited opening',
    styleOverride: { textColor: '#19D98B' },
  }]);

  const tailTrimmed = trimVideoClip(headRestored.project, 'main', 'end', 2_500);
  assert.ok(tailTrimmed);
  assert.equal(tailTrimmed.project.clips[0].sourceEndMs, 2_500);
  assert.equal(tailTrimmed.project.clips[0].gapAfterMs, 1_500);
  assert.equal(totalClipDuration(tailTrimmed.project.clips), 4_000);
  assert.deepEqual(timelineSegmentAt(buildClipTimeline(tailTrimmed.project.clips), 3_000), {
    kind: 'gap',
    startMs: 2_500,
    endMs: 4_000,
    next: undefined,
  });
  const tailRestored = trimVideoClip(tailTrimmed.project, 'main', 'end', 4_000);
  assert.ok(tailRestored);
  assert.equal(tailRestored.project.clips[0].sourceEndMs, 4_000);
  assert.equal(tailRestored.project.clips[0].gapAfterMs, 0);
  assert.equal(tailRestored.project.transcription.words.at(-1).text, 'ending');
});

test('trim previews keep a fixed timeline duration and do not move neighboring clips', () => {
  const first = clip({ id: 'first', sourceEndMs: 5_000, availableSourceEndMs: 5_000 });
  const second = clip({
    id: 'second',
    sourceStartMs: 5_000,
    sourceEndMs: 10_000,
    availableSourceStartMs: 5_000,
    availableSourceEndMs: 10_000,
  });
  const before = buildClipTimeline([first, second]);
  const headPreview = previewVideoClipTrim(first, 'start', 2_000);
  const headTimeline = buildClipTimeline([headPreview, second]);
  assert.equal(headPreview.gapBeforeMs, 2_000);
  assert.equal(headTimeline.at(-1).afterGapEndMs, before.at(-1).afterGapEndMs);
  assert.equal(headTimeline[1].startMs, before[1].startMs);

  const tailPreview = previewVideoClipTrim(first, 'end', 3_000);
  const tailTimeline = buildClipTimeline([tailPreview, second]);
  assert.equal(tailPreview.gapAfterMs, 2_000);
  assert.equal(tailTimeline.at(-1).afterGapEndMs, before.at(-1).afterGapEndMs);
  assert.equal(tailTimeline[1].startMs, before[1].startMs);
});

test('text and image overlays hidden by a trim return with their transforms intact', () => {
  const project = projectFixture({
    layers: [
      { id: 'captions', kind: 'captions', name: 'Captions', visible: true },
      {
        id: 'title',
        kind: 'text',
        name: 'Title',
        visible: true,
        text: 'Keep me',
        startMs: 200,
        endMs: 700,
        style: { marker: 'unchanged' },
      },
      {
        id: 'sticker',
        kind: 'image',
        name: 'Sticker',
        visible: true,
        uri: 'content://sticker',
        startMs: 250,
        endMs: 650,
        position: { x: 0.2, y: 0.3 },
        box: { width: 0.4, height: 0.5 },
        rotation: 17,
        opacity: 0.8,
      },
    ],
  });
  const hidden = trimVideoClip(project, 'main', 'start', 1_000);
  assert.ok(hidden);
  assert.deepEqual(hidden.project.layers.slice(1).map((layer) => [layer.id, layer.timelineVisible]), [
    ['title', false],
    ['sticker', false],
  ]);
  const restored = trimVideoClip(hidden.project, 'main', 'start', 0);
  assert.ok(restored);
  assert.deepEqual(restored.project.layers.slice(1).map((layer) => ({
    id: layer.id,
    visible: layer.timelineVisible,
    startMs: layer.startMs,
    endMs: layer.endMs,
    rotation: layer.rotation,
    style: layer.style,
  })), [
    { id: 'title', visible: true, startMs: 200, endMs: 700, rotation: undefined, style: { marker: 'unchanged' } },
    { id: 'sticker', visible: true, startMs: 250, endMs: 650, rotation: 17, style: undefined },
  ]);
});

test('splitting preserves each clip source handles so trimmed media remains recoverable', () => {
  const project = projectFixture({ clips: [clip({ id: 'whole', sourceEndMs: 4_000, availableSourceEndMs: 4_000 })] });
  const result = splitVideoClip(project, 'whole', 1_500, 'left', 'right');
  assert.ok(result);
  assert.deepEqual(
    result.project.clips.map(({ availableSourceStartMs, availableSourceEndMs }) => [availableSourceStartMs, availableSourceEndMs]),
    [[0, 4_000], [0, 4_000]],
  );
  assert.equal(result.project.clips[1].gapBeforeMs, 0);

  const shortenedLeft = trimVideoClip(result.project, 'left', 'end', 1_000);
  assert.ok(shortenedLeft);
  assert.equal(shortenedLeft.project.clips[0].gapAfterMs, 500);
  const restoredLeft = trimVideoClip(shortenedLeft.project, 'left', 'end', 1_500);
  assert.ok(restoredLeft);
  assert.equal(restoredLeft.project.clips[0].gapAfterMs, 0);

  const shortenedRight = trimVideoClip(result.project, 'right', 'start', 2_000);
  assert.ok(shortenedRight);
  assert.equal(shortenedRight.project.clips[1].gapBeforeMs, 500);
  const restoredRight = trimVideoClip(shortenedRight.project, 'right', 'start', 1_500);
  assert.ok(restoredRight);
  assert.equal(restoredRight.project.clips[1].gapBeforeMs, 0);
});

test('caption grouping always breaks at hard video cuts', () => {
  const captions = groupTimelineWordsByClip([
    { id: 'clip-a-last', text: 'hello', startMs: 900, endMs: 1_000 },
    { id: 'clip-b-first', text: 'world', startMs: 1_000, endMs: 1_100 },
  ], ['clip-a', 'clip-b']);
  assert.deepEqual(captions.map((caption) => [caption.id, caption.text]), [
    ['caption-clip-a-1', 'hello'],
    ['caption-clip-b-1', 'world'],
  ]);
});

test('splitting through an automatic caption preserves both owned halves', () => {
  const sourceWords = [
    { id: 'hello', text: 'hello', startMs: 500, endMs: 900 },
    { id: 'world', text: 'world', startMs: 2_100, endMs: 2_500 },
  ];
  const project = projectFixture({
    clips: [clip({ id: 'whole', sourceEndMs: 4_000, availableSourceEndMs: 4_000 })],
    transcription: {
      language: 'en',
      modelId: 'fast',
      words: sourceWords.map((word) => ({ ...word, id: `whole-${word.id}` })),
      sourceResults: {
        source: { language: 'en', modelId: 'fast', generatedAt: '2026-01-01T00:00:00.000Z', words: sourceWords },
      },
    },
    captions: [{
      id: 'sentence',
      text: 'hello world',
      textMode: 'automatic',
      timelineVisible: true,
      startMs: 500,
      endMs: 2_500,
      wordIds: ['whole-hello', 'whole-world'],
    }],
    layers: [
      { id: 'captions', kind: 'captions', name: 'Captions', visible: true },
      {
        id: 'crossing-title',
        kind: 'text',
        name: 'Crossing title',
        visible: true,
        text: 'Across the cut',
        startMs: 500,
        endMs: 2_500,
        style: { marker: 'preserved' },
      },
    ],
  });
  const result = splitVideoClip(project, 'whole', 1_500, 'left', 'right');
  assert.ok(result);
  assert.deepEqual(visibleTimelineCaptions(result.project.captions).map((caption) => [
    caption.text,
    caption.sourceAnchor.clipId,
  ]), [['hello', 'left'], ['world', 'right']]);
  assert.deepEqual(result.project.layers[1].sourceAnchors.map((anchor) => anchor.clipId), ['left', 'right']);
  assert.deepEqual([result.project.layers[1].startMs, result.project.layers[1].endMs], [500, 2_500]);
  const gapped = setVideoClipGap(result.project, 'right', 500);
  assert.ok(gapped);
  assert.deepEqual(visibleTimelineCaptions(gapped.project.captions).map((caption) => caption.text), ['hello', 'world']);
});

test('deleting an earlier clip preserves manual downstream caption text, identity, and style', () => {
  const sourceWords = [{ id: 'spoken', text: 'automatic', startMs: 2_500, endMs: 3_000 }];
  const project = projectFixture({
    clips: [
      clip({ id: 'first', sourceEndMs: 2_000, availableSourceEndMs: 2_000 }),
      clip({ id: 'second', sourceStartMs: 2_000, sourceEndMs: 4_000, availableSourceStartMs: 2_000, availableSourceEndMs: 4_000 }),
    ],
    transcription: {
      language: 'en',
      modelId: 'fast',
      words: [{ ...sourceWords[0], id: 'second-spoken' }],
      sourceResults: {
        source: { language: 'en', modelId: 'fast', generatedAt: '2026-01-01T00:00:00.000Z', words: sourceWords },
      },
    },
    captions: [{
      id: 'manual-second',
      text: 'My exact edit',
      textMode: 'manual',
      timelineVisible: true,
      startMs: 2_500,
      endMs: 3_000,
      wordIds: ['second-spoken'],
      sourceAnchor: { clipId: 'second', sourceStartMs: 2_500, sourceEndMs: 3_000, wordIds: ['second-spoken'] },
      styleOverride: { textColor: '#FF2FA9' },
    }],
  });
  const result = deleteVideoClip(project, 'first');
  assert.ok(result);
  assert.deepEqual(result.project.captions.map(({ id, text, startMs, styleOverride }) => ({ id, text, startMs, styleOverride })), [{
    id: 'manual-second',
    text: 'My exact edit',
    startMs: 500,
    styleOverride: { textColor: '#FF2FA9' },
  }]);
});

test('legacy timeline words recover canonical source time and survive trim restoration', () => {
  const legacyClip = clip({ id: 'legacy', sourceStartMs: 1_000, sourceEndMs: 4_000, availableSourceStartMs: 0, availableSourceEndMs: 4_000 });
  const legacyWords = [{ id: 'spoken', text: 'recoverable', startMs: 300, endMs: 800 }];
  const recovered = recoverCanonicalSourceWords([legacyClip], legacyWords);
  assert.deepEqual(recovered.source.map(({ id, startMs, endMs }) => [id, startMs, endMs]), [['spoken', 1_300, 1_800]]);
  const project = projectFixture({
    clips: [legacyClip],
    transcription: {
      language: 'en',
      modelId: 'fast',
      words: legacyWords,
      sourceResults: {
        source: { language: 'en', modelId: 'fast', generatedAt: '2026-01-01T00:00:00.000Z', words: recovered.source },
      },
    },
    captions: [{ id: 'legacy-caption', text: 'recoverable', startMs: 300, endMs: 800, wordIds: ['spoken'] }],
  });
  const hidden = trimVideoClip(project, 'legacy', 'start', 2_000);
  assert.ok(hidden);
  assert.equal(visibleTimelineCaptions(hidden.project.captions).length, 0);
  const restored = trimVideoClip(hidden.project, 'legacy', 'start', 1_000);
  assert.ok(restored);
  assert.equal(restored.project.transcription.words[0].text, 'recoverable');
  assert.equal(visibleTimelineCaptions(restored.project.captions)[0].text, 'recoverable');
});

test('minimum clip duration is invariant across slow and fast playback rates', () => {
  const slow = projectFixture({ clips: [clip({ id: 'slow', sourceEndMs: 1_000, availableSourceEndMs: 1_000, playbackRate: 0.25 })] });
  assert.ok(trimVideoClip(slow, 'slow', 'end', 30));
  assert.equal(trimVideoClip(slow, 'slow', 'end', 29).project.clips[0].sourceEndMs, 30);
  const fast = projectFixture({ clips: [clip({ id: 'fast', sourceEndMs: 4_000, availableSourceEndMs: 4_000, playbackRate: 4 })] });
  assert.ok(splitVideoClip(fast, 'fast', 120, 'left-fast', 'right-fast'));
  assert.equal(splitVideoClip(fast, 'fast', 119, 'bad-left', 'bad-right'), null);
});

test('numeric camera filenames become human-readable project names', () => {
  assert.equal(isMachineVideoName('6306.mp4'), true);
  assert.equal(isMachineVideoName('VID_20260820_055214.mp4'), true);
  assert.equal(isMachineVideoName('Snapchat-1207096082.mp4'), true);
  assert.match(humanVideoName('6306.mp4', '2026-08-20T05:52:14-04:00'), /^Video · /);
  assert.equal(humanVideoName('Birthday at the beach.mp4', '2026-08-20T05:52:14-04:00'), 'Birthday at the beach');
});

test('leading and interior silence never produce caption words', () => {
  const words = [
    { id: 'hallucinated-opening', text: 'hello', startMs: 0, endMs: 400 },
    { id: 'spoken-one', text: 'actual', startMs: 10_100, endMs: 10_500 },
    { id: 'hallucinated-gap', text: 'ghost', startMs: 12_000, endMs: 12_300 },
    { id: 'spoken-two', text: 'speech', startMs: 15_100, endMs: 15_600 },
  ];
  const aligned = alignWordsToSpeech(words, [{ t0: 1_000, t1: 1_100 }, { t0: 1_500, t1: 1_600 }]);
  assert.deepEqual(aligned.map((word) => word.text), ['actual', 'speech']);
  assert.equal(aligned[0].startMs, 10_100);
});

test('VAD centiseconds preserve four seconds of leading silence', () => {
  const words = [
    { id: 'early', text: 'hallucination', startMs: 100, endMs: 500 },
    { id: 'spoken', text: 'testing', startMs: 4_120, endMs: 4_650 },
  ];
  const [spoken] = alignWordsToSpeech(words, [{ t0: 400, t1: 900 }]);
  assert.equal(spoken.text, 'testing');
  assert.equal(spoken.startMs, 4_120);
  assert.ok(spoken.startMs >= 4_000);
});

test('end-to-end captions share a lane and real overlaps get another lane', () => {
  const layout = packTimelineLanes([
    { id: 'a', startMs: 0, endMs: 1000 },
    { id: 'b', startMs: 1000, endMs: 2000 },
    { id: 'overlap', startMs: 900, endMs: 1200 },
  ]);
  assert.equal(layout.laneById.get('a'), 0);
  assert.equal(layout.laneById.get('b'), 0);
  assert.equal(layout.laneById.get('overlap'), 1);
  assert.equal(layout.laneCount, 2);
});

test('generated caption blocks remain chronological and never overlap', () => {
  const captions = groupWordsIntoCaptions([
    { id: 'w1', text: 'first', startMs: 4_000, endMs: 4_400 },
    { id: 'w2', text: 'caption', startMs: 4_450, endMs: 4_900 },
    { id: 'w3', text: 'second', startMs: 5_700, endMs: 6_100 },
    { id: 'w4', text: 'caption', startMs: 6_150, endMs: 6_600 },
  ]);
  assert.equal(captions.length, 2);
  assert.ok(captions[0].endMs <= captions[1].startMs);
  assert.equal(captions[0].startMs, 4_000);
});

test('preparing progress advances one percent every 22 seconds from 5% through 10%', () => {
  assert.deepEqual(PREPARING_AUDIO_CUES.map((cue) => cue.progress), [0.05, 0.06, 0.07, 0.08, 0.09, 0.1]);
  assert.deepEqual(PREPARING_AUDIO_CUES.slice(1).map((cue, index) => cue.afterMs - PREPARING_AUDIO_CUES[index].afterMs), [22_000, 22_000, 22_000, 22_000, 22_000]);
});

test('multi-source words are projected into the speed-aware ripple timeline', () => {
  const words = mapSourceWordsToTimeline([
    clip({ id: 'a', sourceId: 'first', sourceStartMs: 1_000, sourceEndMs: 3_000, playbackRate: 2 }),
    clip({ id: 'b', sourceId: 'second', sourceStartMs: 0, sourceEndMs: 2_000 }),
  ], {
    first: [{ id: 'one', text: 'fast', startMs: 1_500, endMs: 2_000 }],
    second: [{ id: 'two', text: 'next', startMs: 500, endMs: 1_000 }],
  });
  assert.deepEqual(words.map((word) => [word.text, word.startMs, word.endMs]), [
    ['fast', 250, 500],
    ['next', 1_500, 2_000],
  ]);
});

test('timeline zoom reaches a whole-project view and exposes fractional ruler ticks', () => {
  const minimum = minimumTimelineScale(10 * 60_000, 300);
  assert.equal(minimum, 0.5);
  assert.equal(timelineWidth(10 * 60_000, minimum, 300), 300);
  assert.equal(timelineTickInterval(240), 250);
});

test('clip audio fades are resolved by timeline position', () => {
  const fading = clip({ sourceEndMs: 4_000, volume: 0.8, fadeInMs: 1_000, fadeOutMs: 1_000 });
  assert.equal(clipPlaybackVolume(fading, 0), 0);
  assert.equal(clipPlaybackVolume(fading, 500), 0.4);
  assert.equal(clipPlaybackVolume(fading, 2_000), 0.8);
  assert.equal(clipPlaybackVolume(fading, 4_000), 0);
});

test('editor back navigation is an explicit save-or-discard transaction', () => {
  const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
  assert.match(editor, /addListener\('beforeRemove'/);
  assert.match(editor, /saveEditorDraft\(projectRef\.current,\s*\{/);
  assert.match(editor, /discardEditorSession\(initialProject, projectRef\.current,\s*\{/);
});

test('screens delegate project mutations to domain and workflow layers', () => {
  const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
  const projects = readFileSync(new URL('../src/app/index.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(editor, /updatedAt:\s*new Date/);
  assert.doesNotMatch(editor, /DocumentPicker|CaptionMedia|SQLite|FileSystem|services\/database/);
  assert.doesNotMatch(projects, /DocumentPicker|CaptionMedia|SQLite|FileSystem|services\/database/);
  assert.match(editor, /from '@\/lib\/project-editor'/);
  assert.match(projects, /deleteProjectCompletely/);
});

test('fixed-center timeline scrolling maps exactly to the video playhead', () => {
  assert.equal(timelineScrollOffset(0, 200_000, 1_000), 0);
  assert.equal(timelineScrollOffset(100_000, 200_000, 1_000), 500);
  assert.equal(timelineTimeAtScroll(750, 200_000, 1_000), 150_000);
  assert.equal(timelineTimeAtScroll(2_000, 200_000, 1_000), 200_000);
});

test('script caption edits commit atomically and preserve caption invariants', () => {
  const captions = [
    { id: 'first', text: 'Original first' },
    { id: 'second', text: 'Original second' },
  ];
  const next = applyCaptionTextChanges(captions, {
    first: '  Revised first  ',
    second: 'Revised second',
    missing: 'Ignored',
  });
  assert.notEqual(next, captions);
  assert.deepEqual(next.map((caption) => caption.text), ['Revised first', 'Revised second']);
  assert.equal(applyCaptionTextChanges(next, { first: 'Revised first' }), next);
  assert.equal(applyCaptionTextChanges(next, { first: '   ' }), next);
});

test('Enter splits a script caption at a spoken-word boundary and Backspace merges it again', () => {
  const words = [
    { id: 'clip-one', text: 'one', startMs: 0, endMs: 400 },
    { id: 'clip-two', text: 'two', startMs: 500, endMs: 900 },
    { id: 'clip-three', text: 'three', startMs: 1_000, endMs: 1_400 },
    { id: 'clip-four', text: 'four', startMs: 1_500, endMs: 1_900 },
  ];
  const captions = [{
    id: 'sentence',
    text: 'one two three four',
    textMode: 'automatic',
    startMs: 0,
    endMs: 2_000,
    wordIds: words.map((word) => word.id),
    timelineVisible: true,
    sourceAnchor: { clipId: 'clip', sourceStartMs: 0, sourceEndMs: 2_000, wordIds: words.map((word) => word.id) },
    styleOverride: { textColor: '#19D98B' },
  }];
  const split = splitCaptionScriptBlock(captions, 'sentence', 'one two'.length, words, 'sentence-right');
  assert.ok(split);
  assert.deepEqual(split.captions.map(({ id, text, startMs, endMs, wordIds }) => ({ id, text, startMs, endMs, wordIds })), [
    { id: 'sentence', text: 'one two', startMs: 0, endMs: 950, wordIds: ['clip-one', 'clip-two'] },
    { id: 'sentence-right', text: 'three four', startMs: 950, endMs: 2_000, wordIds: ['clip-three', 'clip-four'] },
  ]);
  assert.equal(split.captions[1].styleOverride.textColor, '#19D98B');
  const merged = mergeCaptionScriptBlock(split.captions, 'sentence-right');
  assert.ok(merged && !('blockedByVideoCut' in merged));
  assert.deepEqual(merged.captions.map(({ id, text, startMs, endMs }) => ({ id, text, startMs, endMs })), [
    { id: 'sentence', text: 'one two three four', startMs: 0, endMs: 2_000 },
  ]);
});

test('timeline split and join are explicit, word-aware, and reversible', () => {
  const words = [
    { id: 'clip-one', text: 'one', startMs: 0, endMs: 400 },
    { id: 'clip-two', text: 'two', startMs: 500, endMs: 900 },
    { id: 'clip-three', text: 'three', startMs: 1_000, endMs: 1_400 },
    { id: 'clip-four', text: 'four', startMs: 1_500, endMs: 1_900 },
  ];
  const captions = [{
    id: 'sentence',
    text: 'one two three four',
    textMode: 'automatic',
    startMs: 0,
    endMs: 2_000,
    wordIds: words.map((word) => word.id),
    timelineVisible: true,
    sourceAnchor: { clipId: 'clip', sourceStartMs: 0, sourceEndMs: 2_000, wordIds: words.map((word) => word.id) },
  }];

  const split = splitCaptionScriptBlockAtTime(captions, 'sentence', 1_100, words, 'right');
  assert.ok(split);
  assert.deepEqual(split.captions.map(({ id, text, startMs, endMs, wordIds }) => ({ id, text, startMs, endMs, wordIds })), [
    { id: 'sentence', text: 'one two', startMs: 0, endMs: 950, wordIds: ['clip-one', 'clip-two'] },
    { id: 'right', text: 'three four', startMs: 950, endMs: 2_000, wordIds: ['clip-three', 'clip-four'] },
  ]);
  const joined = mergeCaptionScriptBlock(split.captions, 'sentence', 'next');
  assert.ok(joined && !('blockedByVideoCut' in joined));
  assert.deepEqual(joined.captions.map(({ id, text, startMs, endMs }) => ({ id, text, startMs, endMs })), [
    { id: 'sentence', text: 'one two three four', startMs: 0, endMs: 2_000 },
  ]);
});

test('dragging a shared subtitle boundary keeps adjacent blocks end to end', () => {
  const project = projectFixture({
    clips: [clip({ id: 'clip', sourceEndMs: 3_000, availableSourceEndMs: 3_000 })],
    captions: [
      { id: 'left', text: 'left', startMs: 0, endMs: 1_000, wordIds: [], timelineVisible: true, sourceAnchor: { clipId: 'clip', sourceStartMs: 0, sourceEndMs: 1_000, wordIds: [] } },
      { id: 'right', text: 'right', startMs: 1_000, endMs: 2_000, wordIds: [], timelineVisible: true, sourceAnchor: { clipId: 'clip', sourceStartMs: 1_000, sourceEndMs: 2_000, wordIds: [] } },
    ],
  });
  const movedRight = setCaptionTiming(project, 'left', 'end', 0, 1_250);
  assert.deepEqual(movedRight.captions.map(({ startMs, endMs }) => [startMs, endMs]), [[0, 1_250], [1_250, 2_000]]);
  const movedLeft = setCaptionTiming(movedRight, 'right', 'start', 900, 2_000);
  assert.deepEqual(movedLeft.captions.map(({ startMs, endMs }) => [startMs, endMs]), [[0, 900], [900, 2_000]]);
  assert.equal(packTimelineLanes(movedLeft.captions).laneCount, 1);
});

test('script captions never merge across a hard video cut', () => {
  const captions = [
    { id: 'left', text: 'left', startMs: 0, endMs: 500, wordIds: [], sourceAnchor: { clipId: 'a', sourceStartMs: 0, sourceEndMs: 500, wordIds: [] } },
    { id: 'right', text: 'right', startMs: 500, endMs: 1_000, wordIds: [], sourceAnchor: { clipId: 'b', sourceStartMs: 0, sourceEndMs: 500, wordIds: [] } },
  ];
  assert.deepEqual(mergeCaptionScriptBlock(captions, 'right'), { blockedByVideoCut: true });
});

test('caption editing opens the full timestamped script and keeps text-layer editing isolated', () => {
  const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
  const scriptEditor = readFileSync(new URL('../src/components/editor/script-editor.tsx', import.meta.url), 'utf8');
  assert.match(editor, /<ScriptEditor/);
  assert.match(editor, /replaceVisibleCaptionScript\(before, captions\)/);
  assert.match(editor, /<EditTextLayerModal/);
  assert.match(scriptEditor, /<FlatList/);
  assert.match(scriptEditor, /formatTimestamp\(item\.startMs\)/);
  assert.match(scriptEditor, /Enter and Backspace/);
  assert.match(scriptEditor, /Backspace/);
  assert.match(scriptEditor, /Split here/);
  assert.match(scriptEditor, /Join previous/);
  assert.match(scriptEditor, /Join next/);
  assert.match(scriptEditor, /onSave\(draftCaptions\)/);
});

test('selected captions expose direct timeline split and join commands', () => {
  const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
  assert.match(editor, /splitCaptionScriptBlockAtTime/);
  assert.match(editor, /Split at playhead/);
  assert.match(editor, /Join previous/);
  assert.match(editor, /Join next/);
});

test('timeline keeps a fixed playhead, scrubs its content, renders a ruler, and offers an append-video control', () => {
  const timeline = readFileSync(new URL('../src/components/editor/layer-timeline.tsx', import.meta.url), 'utf8');
  assert.match(timeline, /timelineTimeAtScroll\(offset, duration, trackWidth\)/);
  assert.match(timeline, /left: '50%'/);
  assert.match(timeline, /onScrollBeginDrag/);
  assert.match(timeline, /TimelineRuler/);
  assert.match(timeline, /onAddVideos/);
});

test('video transport has one source of runtime truth and advances across native end events', () => {
  const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
  const controller = readFileSync(new URL('../src/hooks/use-timeline-video-controller.ts', import.meta.url), 'utf8');
  assert.equal((editor.match(/<VideoView/g) ?? []).length, 1);
  assert.doesNotMatch(editor, /currentMs\s*<=\s*50|activeSourceIdRef|sourceLoadVersionRef/);
  assert.match(editor, /surfaceType="textureView"/);
  assert.match(editor, /useExoShutter/);
  assert.match(controller, /playIntentRef/);
  assert.match(controller, /desiredRef/);
  assert.match(controller, /processingRef/);
  assert.match(controller, /initialSourceRef/);
  assert.match(controller, /generation !== generationRef\.current/);
  assert.match(controller, /if \(!mountedRef\.current\) return/);
  assert.match(controller, /synchronizeProject[\s\S]*desiredRef\.current/);
  assert.match(controller, /'playToEnd'/);
  assert.doesNotMatch(controller, /player\.playing/);
});

test('the editor tool panel scrolls independently above a fixed mode bar', () => {
  const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
  assert.match(editor, /nestedScrollEnabled[\s\S]*contentContainerStyle=\{\{ gap: 12/);
  assert.match(editor, /<VideoTools[\s\S]*<\/ScrollView>[\s\S]*<ToolbarItem label="Captions"/);
});

test('emoji reactions change with the spoken word', () => {
  assert.deepEqual(reactionEmojis('money'), ['💸', '🤑', '💰', '🪙', '💵', '💳']);
  assert.deepEqual(reactionEmojis('camera'), ['🎥', '📸', '🎬', '📹', '🍿', '📺']);
  assert.notDeepEqual(reactionEmojis('money'), reactionEmojis('sad'));
  assert.deepEqual(reactionEmojis('the', 'Turn on the camera'), []);
  assert.deepEqual(reactionEmojis('钱'), reactionEmojis('money'));
  assert.deepEqual(reactionEmojis('recording'), reactionEmojis('camera'));
  assert.deepEqual(reactionEmojis('unmapped-one'), []);
  assert.deepEqual(reactionEmojis('unmapped-two'), []);
  assert.equal(new Set(reactionEmojis('camera')).size, 6);
});

test('an unexpected native pause while playback is intended resumes instead of killing the timeline', () => {
  const controller = readFileSync(new URL('../src/hooks/use-timeline-video-controller.ts', import.meta.url), 'utf8');
  const playingChange = controller.slice(
    controller.indexOf("useEventListener(player, 'playingChange'"),
    controller.indexOf("useEventListener(player, 'statusChange'"),
  );
  assert.match(playingChange, /if \(!playIntentRef\.current/);
  assert.match(playingChange, /player\.play\(\)/);
  assert.doesNotMatch(playingChange, /stopTransport\(\);\s*$/);
});

test('extract audio offers project videos by first frame before the system picker', () => {
  const editor = readFileSync(new URL('../src/app/editor.tsx', import.meta.url), 'utf8');
  const sheet = readFileSync(new URL('../src/components/editor/extract-audio-source-sheet.tsx', import.meta.url), 'utf8');
  const workflows = readFileSync(new URL('../src/services/project-workflows.ts', import.meta.url), 'utf8');
  const media = readFileSync(new URL('../src/services/project-media.ts', import.meta.url), 'utf8');
  assert.match(editor, /<ExtractAudioSourceSheet/);
  assert.match(sheet, /source\.thumbnailUri/);
  assert.match(sheet, /source\.displayName/);
  assert.match(sheet, /formatDuration\(source\.durationMs\)/);
  assert.match(workflows, /appendProjectVideoAudioToProject/);
  assert.match(workflows, /for \(const source of loadedProject\.sources\)/);
  assert.match(media, /PROJECT_POSTER_VERSION = 3/);
  assert.match(media, /-poster-v\$\{PROJECT_POSTER_VERSION\}\.jpg/);
});

function clip(overrides = {}) {
  const sourceStartMs = overrides.sourceStartMs ?? 0;
  const sourceEndMs = overrides.sourceEndMs ?? 1_000;
  return {
    id: 'clip',
    sourceId: 'source',
    availableSourceStartMs: overrides.availableSourceStartMs ?? sourceStartMs,
    availableSourceEndMs: overrides.availableSourceEndMs ?? sourceEndMs,
    sourceStartMs,
    sourceEndMs,
    gapBeforeMs: 0,
    gapAfterMs: 0,
    playbackRate: 1,
    volume: 1,
    muted: false,
    fadeInMs: 0,
    fadeOutMs: 0,
    ...overrides,
  };
}

function projectFixture(overrides = {}) {
  const base = {
    schemaVersion: 2,
    id: 'project',
    name: 'Project',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lifecycle: { status: 'draft' },
    sources: [{
      id: 'source',
      uri: 'content://video',
      storageMode: 'linked',
      displayName: 'Video',
      durationMs: 4_000,
      width: 1080,
      height: 1920,
      rotation: 0,
    }],
    transcription: { language: 'en', modelId: 'fast', words: [], sourceResults: {} },
    captions: [],
    projectStyle: {},
    layers: [{ id: 'captions', kind: 'captions', name: 'Captions', visible: true }],
    clips: [clip({ id: 'main', sourceEndMs: 4_000, availableSourceEndMs: 4_000 })],
    canvas: { preset: 'source', aspectWidth: 9, aspectHeight: 16, backgroundColor: '#000000' },
    videoTransform: { fit: 'fit', position: { x: 0.5, y: 0.5 }, scale: 1, rotation: 0 },
    export: { resolution: '1080p', format: 'mp4', burnCaptions: true },
  };
  return { ...base, ...overrides };
}
