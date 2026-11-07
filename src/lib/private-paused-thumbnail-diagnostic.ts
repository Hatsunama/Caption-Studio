import type { VideoPlayer, VideoThumbnail } from 'expo-video';

// PRIVATE DIAGNOSTIC — DO NOT SHIP. App-wide cap survives controller remounts.
let requests = 0;
type Fixture = { durationMs: number; width: number; height: number; frameRate?: number };
export function isPausedThumbnailFixture(source: Fixture, targetMs: number, paused: boolean) {
  return paused && source.durationMs === 8000 && source.width === 360 && source.height === 640
    && source.frameRate === 24 && targetMs >= 6380 && targetMs <= 6390;
}

export type PausedDiagnosticThumbnail = { image: VideoThumbnail; timelineMs: number; prepareToken: number };

// Own every returned SharedRef, including results that arrive after cancellation.
// Retired published images live until a commit no longer references them.
export function createPausedThumbnailDiagnostic() {
  const retired = new Set<VideoThumbnail>();
  let cancelCurrent: (() => void) | undefined;
  return {
    request(player: VideoPlayer, source: Fixture, targetMs: number, timelineMs: number, prepareToken: number,
      resolvedPreview: boolean, current: () => boolean,
      publish: (thumbnail?: PausedDiagnosticThumbnail) => void) {
      cancelCurrent?.();
      if (!isPausedThumbnailFixture(source, targetMs, current()) || requests >= 4) return () => {};
      requests += 1;
      let active = true;
      let image: VideoThumbnail | undefined;
      const cancel = () => {
        if (!active) return;
        active = false;
        if (image) { retired.add(image); publish(); }
      };
      cancelCurrent = cancel;
      const numeric = (value: number | null | undefined) => Number.isFinite(value) ? value as number : -1;
      const trace = (stage: number, thumbnail?: VideoThumbnail) => {
        try {
          const track = player.videoTrack;
          console.info('CS_PAUSED_THUMB', JSON.stringify({
            stage, resolvedPreview: Number(resolvedPreview),
            sourceDurationMs: source.durationMs, sourceWidth: source.width,
            sourceHeight: source.height, sourceFrameRate: numeric(source.frameRate),
            requestedTimeSeconds: targetMs / 1000,
            thumbnailRequestedTimeSeconds: numeric(thumbnail?.requestedTime),
            // Android actualTime is metadata-derived, NOT decoded PTS.
            thumbnailEstimatedActualTimeSeconds: numeric(thumbnail?.actualTime),
            thumbnailWidth: numeric(thumbnail?.width), thumbnailHeight: numeric(thumbnail?.height),
            playerCurrentTimeSeconds: numeric(player.currentTime), playerDurationSeconds: numeric(player.duration),
            playerWidth: numeric(track?.size.width), playerHeight: numeric(track?.size.height),
            playerFrameRate: numeric(track?.frameRate),
          }));
        } catch { /* Observation cannot interrupt the native preparation under test. */ }
      };
      trace(0);
      // Installed Android implementation uses OPTION_CLOSEST, without a seek.
      void (async () => {
        try {
          const results = await player.generateThumbnailsAsync(targetMs / 1000);
          const [first, ...extras] = results;
          extras.forEach(result => result.release());
          if (!active || !current()) { first?.release(); return; }
          trace(first ? 1 : 2, first);
          if (first) { image = first; publish({ image, timelineMs, prepareToken }); }
        } catch {
          if (active && current()) trace(2);
        }
      })();
      return cancel;
    },
    collect(retained: readonly (VideoThumbnail | undefined)[]) {
      for (const image of retired) if (!retained.includes(image)) {
        retired.delete(image);
        image.release();
      }
    },
    retire() { cancelCurrent?.(); },
  };
}
