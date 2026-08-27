import {
  DEFAULT_VIDEO_TRANSFORM,
  type VideoTransform,
  type VideoTransformPatch,
} from '@/types/project';

export function cloneVideoTransform(transform: VideoTransform): VideoTransform {
  return {
    ...transform,
    position: { ...transform.position },
  };
}

export function resolveVideoTransform(
  transform?: VideoTransform,
  fallback: VideoTransform = DEFAULT_VIDEO_TRANSFORM,
): VideoTransform {
  return mergeVideoTransform(fallback, transform ?? {});
}

export function mergeVideoTransform(
  current: VideoTransform,
  patch: VideoTransformPatch,
): VideoTransform {
  const position = patch.position;
  return {
    fit: patch.fit === 'fit' || patch.fit === 'fill' ? patch.fit : current.fit,
    position: {
      x: boundedFinite(position?.x, current.position.x, -4, 4),
      y: boundedFinite(position?.y, current.position.y, -4, 4),
    },
    scale: boundedFinite(patch.scale, current.scale, 0.05, 20),
    rotation: normalizeDegrees(finiteOr(patch.rotation, current.rotation)),
  };
}

export function sameVideoTransform(left: VideoTransform, right: VideoTransform) {
  return left.fit === right.fit
    && left.position.x === right.position.x
    && left.position.y === right.position.y
    && left.scale === right.scale
    && left.rotation === right.rotation;
}

function boundedFinite(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, finiteOr(value, fallback)));
}

function finiteOr(value: number | undefined, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeDegrees(value: number) {
  let result = value % 360;
  if (result > 180) result -= 360;
  if (result < -180) result += 360;
  return result;
}
