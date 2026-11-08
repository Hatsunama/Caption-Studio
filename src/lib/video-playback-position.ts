// Keep the project clock at the caller's source endpoint while seeking inside
// the loaded item. A native clipped item supplies its enforced end here.
// Android adjustment stays within 250ms; ordinary seeks keep their targets.
export function effectiveNativeSeekTarget(
  requestedSeconds: number, sourceDurationSeconds: number, nativeDurationSeconds: number, platform: string,
) {
  if (platform !== 'android' || !Number.isFinite(requestedSeconds) || requestedSeconds <= 0
    || !Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0
    || !Number.isFinite(nativeDurationSeconds) || nativeDurationSeconds <= 0) return requestedSeconds;
  // Rate/gap arithmetic can return media EOF a few Double ulps away from its
  // stored value. Recognize only that arithmetic noise, not a genuine trim.
  const epsilon = Number.EPSILON * Math.max(1, Math.abs(requestedSeconds), Math.abs(sourceDurationSeconds)) * 4;
  if (Math.abs(requestedSeconds - sourceDurationSeconds) > epsilon) return requestedSeconds;

  // Installed Expo 57 duration = player.duration / 1000f (Long -> Float).
  // Recover the integer milliseconds only if that exact Float conversion
  // explains the reported value; do not round arbitrary durations into range.
  const reportedMs = nativeDurationSeconds * 1000;
  const roundedMs = Math.round(reportedMs);
  const durationMs = Math.fround(Math.fround(roundedMs) / 1000) === nativeDurationSeconds
    ? roundedMs : reportedMs;
  if (!Number.isSafeInteger(Math.ceil(durationMs)) || durationMs / 1000 > sourceDurationSeconds) return requestedSeconds;
  const lastMs = Math.ceil(durationMs) - 1;
  const effectiveSeconds = lastMs / 1000;
  if (lastMs < 0 || requestedSeconds - effectiveSeconds > 0.25) return requestedSeconds;

  // Some decimal seconds multiply to just below their integer millisecond.
  // Preserve the intended Long seekTo value through Double -> Long truncation.
  return Math.trunc(effectiveSeconds * 1000) === lastMs ? effectiveSeconds
    : effectiveSeconds + Number.EPSILON * Math.max(1, Math.abs(effectiveSeconds));
}

// Logical position acknowledgement only; this does not identify decoded frame PTS.
export function acknowledgesPlaybackPosition(
  currentSeconds: number, targetSeconds: number, platform: string,
) {
  if (!Number.isFinite(currentSeconds) || !Number.isFinite(targetSeconds)) return false;

  // Expo Video 57 Android: seekTo((seconds * 1000).toLong()), timeUpdate
  // currentPosition / 1000.0, getter currentPosition / 1000f. Include the
  // rounding introduced by those installed Long/Float conversions on Android.
  const epsilon = Number.EPSILON * Math.max(1, Math.abs(targetSeconds)) * 4;
  // This handshake repair is Android-specific. Preserve the previous position
  // acknowledgement window for iOS/web and other platform clocks.
  if (platform !== 'android') return Math.abs(currentSeconds - targetSeconds) <= 0.25 + epsilon;
  const nativeMs = Math.trunc(targetSeconds * 1000);
  const nativeSeconds = nativeMs / 1000;
  const getterSeconds = Math.fround(Math.fround(nativeMs) / 1000);
  const lower = Math.min(targetSeconds, nativeSeconds, getterSeconds);
  const upper = Math.max(targetSeconds, nativeSeconds, getterSeconds);
  return currentSeconds >= lower - epsilon && currentSeconds <= upper + epsilon;
}
