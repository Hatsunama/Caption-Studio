import type { CaptionProject, ProjectVideoSource } from '@/types/project';

type VideoSources = Pick<CaptionProject, 'sources' | 'clips'>;

export function orientedVideoSize(source: Pick<ProjectVideoSource, 'width' | 'height' | 'rotation'>) {
  const width = Math.max(1, source.width);
  const height = Math.max(1, source.height);
  return Math.abs(source.rotation) % 180 === 90
    ? { width: height, height: width }
    : { width, height };
}

/** Catalog order is stable across clip reordering and playhead changes. */
export function activeSourceFrame(project: VideoSources) {
  const activeIds = new Set(project.clips.map((clip) => clip.sourceId));
  return project.sources.find((source) => activeIds.has(source.id));
}

export function resolveSourceCanvas(project: VideoSources & Pick<CaptionProject, 'canvas'>): CaptionProject['canvas'] {
  if (project.canvas.preset !== 'source') return project.canvas;
  const source = activeSourceFrame(project);
  if (!source) return project.canvas;
  const { width, height } = orientedVideoSize(source);
  if (project.canvas.aspectWidth === width && project.canvas.aspectHeight === height) return project.canvas;
  return { ...project.canvas, aspectWidth: width, aspectHeight: height };
}

/** Readiness is distinct from retention: undo assets stay owned without blocking playback. */
export function requiredProjectVideoSources(project: VideoSources & Pick<CaptionProject, 'backgroundReplacement'>) {
  const activeIds = new Set(project.clips.map((clip) => clip.sourceId));
  const background = project.backgroundReplacement.enabled ? project.backgroundReplacement.source : undefined;
  return project.sources.filter((source) => activeIds.has(source.id)
    || (background?.kind === 'video' && background.uri === source.uri));
}
