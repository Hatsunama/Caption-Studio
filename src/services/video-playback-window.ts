import CaptionMedia from 'caption-media';
import type { VideoPlayer } from 'expo-video';

export function configureVideoPlaybackWindow(
  player: VideoPlayer,
  expectedUri: string,
  requestId: number,
  endMs: number,
  targetMs: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const cancel = () => {
      // Cancel only this ID: a later request can already own the same player.
      try { void CaptionMedia.cancelVideoPlaybackWindow(player, requestId).catch(() => {}); }
      catch { /* A released player must still settle the JS cancellation. */ }
    };
    const abort = () => {
      if (settled) return;
      cancel();
      const error = new Error('Video playback window preparation was superseded.');
      error.name = 'AbortError';
      finish(error);
    };
    if (signal.aborted) {
      const error = new Error('Video playback window preparation was superseded.');
      error.name = 'AbortError';
      reject(error);
      return;
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000
      || !Number.isSafeInteger(requestId) || requestId <= 0
      || !Number.isSafeInteger(endMs) || endMs <= 0
      || typeof targetMs !== 'number' || !Number.isFinite(targetMs) || targetMs < 0 || targetMs >= endMs) {
      reject(new Error('Invalid video playback window request.'));
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => {
      cancel();
      finish(new Error('The video playback window timed out. Try loading it again.'));
    }, timeoutMs);
    try {
      void CaptionMedia.configureVideoPlaybackWindow(player, expectedUri, requestId, endMs, targetMs, timeoutMs)
        .then(() => finish(), error => finish(error));
    } catch (error) { finish(error); }
  });
}
