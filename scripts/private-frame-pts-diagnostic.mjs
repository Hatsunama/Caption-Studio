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
  @Volatile private var privateFramePtsRequestedMs = Double.NaN
  private var privateFramePtsInstalled = false

  // Called only on the existing currentTime setter's main queue, before seekTo.
  internal fun privateFramePtsDiagnostic(seconds: Double) {
    privateFramePtsRequestedMs = Double.NaN
    val format = player.videoFormat
    if (player.duration != 8000L || format?.width != 360 || format.height != 640 ||
      !(seconds == 6.375 || seconds in 6.380..6.390)) return
    privateFramePtsRequestedMs = seconds * 1000.0
    if (privateFramePtsInstalled) return
    player.setVideoFrameMetadataListener(
      androidx.media3.exoplayer.video.VideoFrameMetadataListener { presentationTimeUs, _, frameFormat, _ ->
        try {
          val requestedMs = privateFramePtsRequestedMs
          if (!requestedMs.isNaN() && frameFormat.width == 360 && frameFormat.height == 640) {
            val count = privateFramePtsCount.getAndUpdate { if (it < 32) it + 1 else it }
            if (count < 32) android.util.Log.i("CS_FRAME_PTS", "requestedMs=" + requestedMs + " actualPresentationTimeUs=" + presentationTimeUs)
          }
        } catch (_: Throwable) {
          // Renderer-thread observations cannot interrupt playback.
        }
      }
    )
    privateFramePtsInstalled = true
  }

` + playerAnchor;

const specs = [
  ['player/VideoPlayer.kt', playerAnchor, playerPatch, '9566638fc2d638843bbfae7d4b3a7cd1826578d5019491b221cc9c0d3f3d7b8a'],
  ['VideoModule.kt', setterAnchor, setterPatch, '5474c0637f0e18946a5290bdc01ed3d125c540b3c232646613403a3937c0d066'],
];
const occurrences = (text, needle) => text.split(needle).length - 1;
const digest = text => createHash('sha256').update(text).digest('hex');

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
  patchPrivateFramePts(join(dirname(fileURLToPath(import.meta.url)), '../node_modules/expo-video'));
}
