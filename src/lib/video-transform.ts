import { resolveLayerGeometry, type LayerGeometry } from '@/lib/layer-geometry';
import {
  DEFAULT_VIDEO_TRANSFORM,
  type CaptionProject,
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
    scaleX: boundedFinite(patch.scaleX, current.scaleX ?? 1, 0.001, 200),
    scaleY: boundedFinite(patch.scaleY, current.scaleY ?? 1, 0.001, 200),
    rotation: normalizeDegrees(finiteOr(patch.rotation, current.rotation)),
  };
}

export function sameVideoTransform(left: VideoTransform, right: VideoTransform) {
  return left.fit === right.fit
    && left.position.x === right.position.x
    && left.position.y === right.position.y
    && left.scale === right.scale
    && (left.scaleX ?? 1) === (right.scaleX ?? 1)
    && (left.scaleY ?? 1) === (right.scaleY ?? 1)
    && left.rotation === right.rotation;
}

export function videoClipPreviewGeometry(project: CaptionProject, clipId: string): LayerGeometry | undefined {
  const clip = project.clips.find((candidate) => candidate.id === clipId);
  if (!clip) return undefined;
  const source = project.sources.find((candidate) => candidate.id === clip.sourceId);
  if (!source) return undefined;
  const transform = resolveVideoTransform(clip.transform, project.videoTransform);
  const turned = Math.abs(source.rotation) % 180 === 90;
  const sourceAspect = Math.max(1, turned ? source.height : source.width)
    / Math.max(1, turned ? source.width : source.height);
  const canvasAspect = Math.max(1, project.canvas.aspectWidth) / Math.max(1, project.canvas.aspectHeight);
  const box = transform.fit === 'fill' ? { width: 1, height: 1 }
    : sourceAspect >= canvasAspect
      ? { width: 1, height: canvasAspect / sourceAspect }
      : { width: sourceAspect / canvasAspect, height: 1 };
  return resolveLayerGeometry({
    position: transform.position, box, scale: transform.scale,
    scaleX: transform.scaleX ?? 1, scaleY: transform.scaleY ?? 1,
    rotation: transform.rotation,
  });
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
