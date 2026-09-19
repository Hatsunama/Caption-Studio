import { assertSupportedVideo, type ProbedVideoInfo } from '@/lib/media-validation';
import type { CaptionProject, ProjectVideoSource } from '@/types/project';
import type { ProjectVideoDocument } from '@/types/project-media-recovery';

export function relinkProjectVideo(
  project: CaptionProject,
  source: ProjectVideoSource,
  document: ProjectVideoDocument,
  info: ProbedVideoInfo,
): CaptionProject {
  assertSupportedVideo(info, document.name);
  if (!document.uri.startsWith('content://')) throw new Error('Choose a video document from Android Files.');
  const matching = project.sources.filter((candidate) => candidate.uri === source.uri);
  if (!matching.some((candidate) => candidate.id === source.id)) throw new Error('The source changed. Reopen the project before re-linking.');
  for (const candidate of matching) {
    const wrongSize = candidate.sizeBytes != null && document.size != null && candidate.sizeBytes !== document.size;
    const clippedEnd = project.clips.filter((clip) => clip.sourceId === candidate.id)
      .reduce((end, clip) => Math.max(end, clip.sourceEndMs, clip.availableSourceEndMs), 0);
    if (wrongSize || !Number.isFinite(info.durationMs) || Math.abs(candidate.durationMs - info.durationMs) > 100
      || info.durationMs < clippedEnd || candidate.width !== info.width || candidate.height !== info.height
      || candidate.rotation !== info.rotation) {
      throw new Error('This video does not match the saved source timing, dimensions, or size. Choose the original file. All edits are unchanged.');
    }
  }
  if (source.uri === document.uri && matching.every((candidate) => candidate.storageMode === 'linked')) return project;
  const background = project.backgroundReplacement.source;
  return {
    ...project,
    sources: project.sources.map((candidate) => {
      if (candidate.uri !== source.uri) return candidate;
      const relinked: ProjectVideoSource = {
        ...candidate,
        uri: document.uri,
        storageMode: 'linked',
      };
      delete relinked.previewUri;
      return relinked;
    }),
    ...(background?.uri === source.uri ? {
      backgroundReplacement: {
        ...project.backgroundReplacement,
        source: { ...background, uri: document.uri, storageMode: 'linked' as const },
      },
    } : {}),
  };
}
