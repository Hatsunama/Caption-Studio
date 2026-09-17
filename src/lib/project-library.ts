import { projectTimelineDuration } from '@/lib/project-timeline';
import type { CaptionProject } from '@/types/project';
import type { ProjectLibraryProject } from '@/types/project-library';

export function projectLibraryProject(project: CaptionProject): ProjectLibraryProject {
  const source = project.sources[0];
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    lifecycleStatus: project.lifecycle.status,
    sourceId: source?.id,
    sourceUri: source?.uri,
    thumbnailUri: source?.thumbnailUri,
    durationMs: projectTimelineDuration(project),
    clipCount: project.clips.length,
    captionCount: project.captions.length,
  };
}

export function applyProjectSourceThumbnail(
  project: CaptionProject,
  sourceId: string,
  sourceUri: string,
  thumbnailUri: string,
): CaptionProject | null {
  const source = project.sources.find((candidate) => candidate.id === sourceId);
  if (!source || source.uri !== sourceUri) return null;
  return {
    ...project,
    sources: project.sources.map((candidate) => candidate.id === sourceId
      ? { ...candidate, thumbnailUri }
      : candidate),
  };
}
