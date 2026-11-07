// PRIVATE DISPOSABLE. No postinstall hook; CLI is restricted to the private CI dispatch.
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const branchRef = 'refs/heads/diagnostic/paused-frame-pts-20261107';
const nativeBase = 'android/src/main/java/expo/modules/video';
const playerAnchor = '  internal val firstFrameEventGenerator: FirstFrameEventGenerator';
const setterAnchor = `        .set { ref: VideoPlayer, currentTime: Double ->
          appContext.mainQueue.launch {
            ref.player.seekTo((currentTime * 1000).toLong())
          }
        }`;
const setterPatch = setterAnchor.replace('            ref.player.seekTo', `            try {
              ref.privateFramePtsDiagnostic(currentTime)
            } catch (_: Throwable) {
              // Observational diagnostics must never fail the seek.
            }
            ref.player.seekTo`);
const playerPatch = `  // PRIVATE DISPOSABLE: about-to-render PTS, NOT proof of displayed pixels.
  private val privateFramePtsCount = java.util.concurrent.atomic.AtomicInteger(0)
  private val privateFramePtsPlayerId = System.identityHashCode(player)
  private data class PrivateFramePtsRequest(val requestedMs: Double, val isPlayingAtSeek: Int)
  @Volatile private var privateFramePtsRequest: PrivateFramePtsRequest? = null
  private var privateFramePtsInstalled = false

  // One shared, saturating budget for entry, installation/error and callback events.
  private fun privateFramePtsLog(message: String) {
    val count = privateFramePtsCount.getAndUpdate { if (it < 64) it + 1 else it }
    if (count < 64) {
      try {
        android.util.Log.w("CS_FRAME_PTS", message)
      } catch (_: Throwable) {
        // Logging itself must never interrupt a seek or renderer callback.
      }
    }
  }

  // Called only on the existing currentTime setter's main queue, before seekTo.
  internal fun privateFramePtsDiagnostic(seconds: Double) {
    // Every seek invalidates the previous request, including out-of-window seeks.
    privateFramePtsRequest = null
    if (!(seconds == 6.375 || seconds in 6.380..6.390)) return
    if (privateFramePtsCount.get() >= 64) return
    val requestedMs = seconds * 1000.0
    try {
      val durationMs = player.duration
      val format = player.videoFormat
      val isPlayingAtSeek = if (player.isPlaying) 1 else 0
      // Metadata is observed, never a readiness gate or a format fallback.
      // JS already gates the exact synthetic fixtures. Stage 1 precedes installation.
      privateFramePtsLog("stage=1 requestedMs=" + requestedMs + " durationMs=" + durationMs +
        " width=" + (format?.width ?: -1) + " height=" + (format?.height ?: -1) +
        " isPlayingAtSeek=" + isPlayingAtSeek + " playerId=" + privateFramePtsPlayerId)
      privateFramePtsRequest = PrivateFramePtsRequest(requestedMs, isPlayingAtSeek)
    } catch (_: Throwable) {
      // Stage 4: metadata inspection failed; no exception messages or media text.
      privateFramePtsLog("stage=4 requestedMs=" + requestedMs + " playerId=" + privateFramePtsPlayerId)
      return
    }
    if (privateFramePtsInstalled) {
      privateFramePtsLog("stage=3 requestedMs=" + requestedMs + " playerId=" + privateFramePtsPlayerId)
      return
    }
    try {
      player.setVideoFrameMetadataListener(
        androidx.media3.exoplayer.video.VideoFrameMetadataListener { presentationTimeUs, _, frameFormat, _ ->
          try {
            val request = privateFramePtsRequest
            if (request != null && privateFramePtsCount.get() < 64) {
              // Only the logging budget changes here. No player access or request mutation.
              privateFramePtsLog("stage=7 requestedMs=" + request.requestedMs +
                " actualPresentationTimeUs=" + presentationTimeUs + " width=" + frameFormat.width +
                " height=" + frameFormat.height + " isPlayingAtSeek=" + request.isPlayingAtSeek +
                " playerId=" + privateFramePtsPlayerId)
            }
          } catch (_: Throwable) {
            // Stage 6: renderer observation failed, without affecting playback.
            privateFramePtsLog("stage=6 playerId=" + privateFramePtsPlayerId)
          }
        }
      )
      privateFramePtsInstalled = true
      privateFramePtsLog("stage=2 requestedMs=" + requestedMs + " playerId=" + privateFramePtsPlayerId)
    } catch (_: Throwable) {
      privateFramePtsRequest = null
      // Stage 5: listener installation failed, distinct from metadata inspection.
      privateFramePtsLog("stage=5 requestedMs=" + requestedMs + " playerId=" + privateFramePtsPlayerId)
    }
  }

` + playerAnchor;

const specs = [
  ['player/VideoPlayer.kt', playerAnchor, playerPatch, '9566638fc2d638843bbfae7d4b3a7cd1826578d5019491b221cc9c0d3f3d7b8a'],
  ['VideoModule.kt', setterAnchor, setterPatch, '5474c0637f0e18946a5290bdc01ed3d125c540b3c232646613403a3937c0d066'],
];
const occurrences = (text, needle) => text.split(needle).length - 1;
const digest = text => createHash('sha256').update(text).digest('hex');

// CI-only package.json edit, atomic for this ONE file. This is intentionally
// separate from the two-native-file transaction below; no three-file guarantee.
export function configurePrivateFramePts(manifestPath, io = fs) {
  const config = JSON.parse(io.readFileSync(manifestPath, 'utf8'));
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(config)) throw new Error('Invalid private PTS package config');
  let parent = config;
  for (const key of ['expo', 'autolinking', 'android']) {
    if (Object.hasOwn(parent, key) && !object(parent[key])) {
      throw new Error('Invalid private PTS autolinking config');
    }
    parent[key] ??= {};
    parent = parent[key];
  }
  const linking = config.expo.autolinking;
  for (const settings of [linking, parent]) {
    if (Object.hasOwn(settings, 'buildFromSource') && (!Array.isArray(settings.buildFromSource)
      || settings.buildFromSource.some(value => typeof value !== 'string'))) {
      throw new Error('Invalid private PTS buildFromSource config');
    }
  }
  // Android overrides the root list: carry inherited selections forward.
  const selected = parent.buildFromSource ?? linking.buildFromSource ?? [];
  if (selected.includes('expo-video')) return false;
  parent.buildFromSource = [...selected, 'expo-video'];
  const temporary = manifestPath + '.' + randomUUID() + '.tmp';
  try {
    io.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
    io.renameSync(temporary, manifestPath);
  } finally {
    if (io.existsSync(temporary)) io.unlinkSync(temporary);
  }
  return true;
}

// Tests pass a temporary copy of the actual installed package, never node_modules.
export function patchPrivateFramePts(packageRoot, io = fs) {
  if (JSON.parse(io.readFileSync(join(packageRoot, 'package.json'), 'utf8')).version !== '57.0.5') {
    throw new Error('Private PTS diagnostic requires expo-video 57.0.5');
  }
  // Validate BOTH originals (or the exact complete patch) before any write.
  const changes = specs.map(([file, anchor, patched, hash]) => {
    const path = join(packageRoot, nativeBase, file);
    const original = io.readFileSync(path, 'utf8');
    const text = original.replace(/\r\n/g, '\n');
    const already = occurrences(text, patched) === 1;
    const clean = already ? text.replace(patched, anchor) : text;
    if (occurrences(clean, anchor) !== 1 || digest(clean) !== hash
      || /VideoFrameMetadataListener|privateFramePtsDiagnostic/.test(clean)) {
      throw new Error('Private PTS diagnostic source/anchor mismatch');
    }
    const output = clean.replace(anchor, patched);
    if (already && output !== text) throw new Error('Private PTS diagnostic partial patch');
    return { path, original, output, already };
  });
  if (changes.every(change => change.already)) return false;
  if (changes.some(change => change.already)) throw new Error('Private PTS diagnostic partial patch');
  const staged = [], applied = [];
  try {
    for (const change of changes) {
      const temporary = change.path + '.' + randomUUID() + '.tmp';
      staged.push(temporary);
      io.writeFileSync(temporary, change.output, { flag: 'wx' });
    }
    for (let i = 0; i < changes.length; i++) {
      io.renameSync(staged[i], changes[i].path);
      applied.push(changes[i]);
    }
  } catch (error) {
    // Restore originals if committing the second staged source fails.
    for (const change of applied.reverse()) io.writeFileSync(change.path, change.original);
    throw error;
  } finally {
    for (const temporary of staged) if (io.existsSync(temporary)) io.unlinkSync(temporary);
  }
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || process.env.GITHUB_REF !== branchRef) {
    throw new Error('Private PTS diagnostic requires the private branch CI dispatch');
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv.length === 3 && process.argv[2] === '--configure-source') {
    configurePrivateFramePts(join(root, 'package.json'));
  } else if (process.argv.length === 2) {
    patchPrivateFramePts(join(root, 'node_modules/expo-video'));
  } else {
    throw new Error('Unknown private PTS diagnostic arguments');
  }
}
