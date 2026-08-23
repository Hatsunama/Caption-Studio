import type { BackgroundReplacement, PersonTransformKeyframe } from '@/types/project';

export type PersonTransform = BackgroundReplacement['personTransform'];

export function resolvePersonTransform(background: BackgroundReplacement, timeMs: number): PersonTransform {
  const frames = normalizedPersonKeyframes(background.keyframes);
  if (frames.length === 0) return background.personTransform;
  if (timeMs <= frames[0].timeMs) return transformFromFrame(frames[0]);
  if (timeMs >= frames[frames.length - 1].timeMs) return transformFromFrame(frames[frames.length - 1]);
  const rightIndex = frames.findIndex((frame) => frame.timeMs >= timeMs);
  const right = frames[rightIndex];
  const left = frames[rightIndex - 1];
  const progress = (timeMs - left.timeMs) / Math.max(1, right.timeMs - left.timeMs);
  const eased = progress * progress * (3 - 2 * progress);
  return {
    position: {
      x: interpolate(left.position.x, right.position.x, eased),
      y: interpolate(left.position.y, right.position.y, eased),
    },
    scale: interpolate(left.scale, right.scale, eased),
    rotation: interpolateAngle(left.rotation, right.rotation, eased),
  };
}

export function upsertPersonKeyframe(
  keyframes: PersonTransformKeyframe[],
  frame: PersonTransformKeyframe,
  snapWindowMs = 80,
) {
  const retained = keyframes.filter((candidate) => Math.abs(candidate.timeMs - frame.timeMs) > snapWindowMs);
  return normalizedPersonKeyframes([...retained, sanitizedFrame(frame)]);
}

export function deletePersonKeyframe(keyframes: PersonTransformKeyframe[], id: string) {
  return normalizedPersonKeyframes(keyframes.filter((frame) => frame.id !== id));
}

export function normalizedPersonKeyframes(keyframes: PersonTransformKeyframe[]) {
  return keyframes.map(sanitizedFrame).sort((left, right) => left.timeMs - right.timeMs);
}

function sanitizedFrame(frame: PersonTransformKeyframe): PersonTransformKeyframe {
  return {
    ...frame,
    timeMs: Math.max(0, finite(frame.timeMs, 0)),
    position: {
      x: clamp(finite(frame.position.x, 0.5), -1, 2),
      y: clamp(finite(frame.position.y, 0.5), -1, 2),
    },
    scale: clamp(finite(frame.scale, 1), 0.05, 8),
    rotation: normalizeAngle(finite(frame.rotation, 0)),
  };
}

function transformFromFrame(frame: PersonTransformKeyframe): PersonTransform {
  return { position: frame.position, scale: frame.scale, rotation: frame.rotation };
}

function interpolate(left: number, right: number, progress: number) {
  return left + (right - left) * progress;
}

function interpolateAngle(left: number, right: number, progress: number) {
  const delta = ((right - left + 540) % 360) - 180;
  return normalizeAngle(left + delta * progress);
}

function normalizeAngle(value: number) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function finite(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
