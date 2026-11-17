import CaptionMedia from 'caption-media';
import type { VideoPlayer } from 'expo-video';

export function disposeVideoMaskLease(player: VideoPlayer, requestId: number) {
  if (requestId > 0) {
    try { void CaptionMedia.disposeVideoMaskLease(player, requestId).catch(() => {}); } catch { /* released */ }
  }
}

/** The native mask remains owned after a grant, including dirty cancellation. */
export async function acquireVideoMaskLease(
  player: VideoPlayer, peer: VideoPlayer, requestId: number, generation: number,
  requireHiddenAncestor: boolean, signal: AbortSignal,
) {
  let committed = false;
  let cancelled = false;
  const cancel = () => {
    if (committed || cancelled) return;
    cancelled = true;
    try { void CaptionMedia.cancelVideoMaskLease(player, requestId).catch(() => {}); } catch { /* released */ }
  };
  const aborted = () => Object.assign(new Error('Video masking was superseded.'), { name: 'AbortError' });
  if (signal.aborted) throw aborted();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timeout); signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(aborted());
      const timeout = setTimeout(() => { cancel(); finish(new Error('Video masking timed out.')); }, 5000);
      signal.addEventListener('abort', abort, { once: true });
      try {
        void CaptionMedia.acquireVideoMaskLease(player, peer, requestId, generation, requireHiddenAncestor)
          .then(() => finish(signal.aborted ? aborted() : undefined), finish);
      } catch (error) { finish(error); }
    });
    return {
      async commit() {
        try {
          if (signal.aborted) throw aborted();
          await new Promise<void>((resolve, reject) => {
            let settled = false;
            const finish = (error?: unknown) => {
              if (settled) return;
              settled = true; clearTimeout(timeout); signal.removeEventListener('abort', abort);
              if (error) reject(error); else resolve();
            };
            const abort = () => finish(aborted());
            const timeout = setTimeout(() => { cancel(); finish(new Error('Video mask release timed out.')); }, 5000);
            signal.addEventListener('abort', abort, { once: true });
            try { void CaptionMedia.commitVideoMaskLease(player, requestId, generation).then(() => finish(), finish); }
            catch (error) { finish(error); }
          });
          if (signal.aborted) { cancel(); throw aborted(); }
          committed = true;
          signal.removeEventListener('abort', cancel);
        } catch (error) {
          cancel(); signal.removeEventListener('abort', cancel); throw error;
        }
      },
      cancel() { cancel(); signal.removeEventListener('abort', cancel); },
    };
  } catch (error) {
    cancel(); signal.removeEventListener('abort', cancel); throw error;
  }
}

// undefined is a confirmed full source; null is an invalid/unknown JS contract.
export function configureVideoPlaybackWindow(
  player: VideoPlayer,
  expectedUri: string,
  requestId: number,
  endMs: number | undefined,
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
      || (endMs !== undefined && (!Number.isSafeInteger(endMs) || endMs <= 0))
      || typeof targetMs !== 'number' || !Number.isFinite(targetMs) || targetMs < 0
      // Safe JS milliseconds also remain below Long.MAX_VALUE after Media3 converts to microseconds.
      || targetMs > Number.MAX_SAFE_INTEGER || (endMs !== undefined && targetMs >= endMs)) {
      reject(new Error('Invalid video playback window request.'));
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => {
      cancel();
      finish(new Error('The video playback window timed out. Try loading it again.'));
    }, timeoutMs);
    try {
      void CaptionMedia.configureVideoPlaybackWindow(player, expectedUri, requestId, endMs ?? null, targetMs, timeoutMs)
        .then(() => finish(), error => finish(error));
    } catch (error) { finish(error); }
  });
}
