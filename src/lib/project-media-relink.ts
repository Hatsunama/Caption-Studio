import { assertSupportedVideo, type ProbedVideoInfo } from '@/lib/media-validation';
import type { CaptionProject, ProjectVideoSource } from '@/types/project';
import type { DocumentReadStatus, VideoDocument } from '../../modules/caption-media/src/CaptionMedia.types';

export function relinkProjectVideo(
  project: CaptionProject,
  source: ProjectVideoSource,
  document: VideoDocument,
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
  // Keep source IDs, timestamps (draft base revisions), metadata, thumbnails and every edit.
  // Metadata compatibility is not proof of identity: the UI must also ask for confirmation.
  const background = project.backgroundReplacement.source;
  return {
    ...project,
    sources: project.sources.map((candidate) => candidate.uri === source.uri
      ? { ...candidate, uri: document.uri, storageMode: 'linked' as const }
      : candidate),
    ...(background?.uri === source.uri ? {
      backgroundReplacement: {
        ...project.backgroundReplacement,
        source: { ...background, uri: document.uri, storageMode: 'linked' as const },
      },
    } : {}),
  };
}

export type MediaRecoveryPorts = {
  check(uri: string): Promise<{ status: DocumentReadStatus }>;
  choose(source: ProjectVideoSource, status: DocumentReadStatus): Promise<VideoDocument | null>;
  probe(uri: string): Promise<ProbedVideoInfo>;
  confirm(source: ProjectVideoSource, document: VideoDocument): Promise<boolean>;
  persist(project: CaptionProject): Promise<void>;
};

/** Run before mounting playback; publish only after a successful durable write. */
export async function recoverProjectVideoAccess(project: CaptionProject, ports: MediaRecoveryPorts) {
  let recovered = project;
  const checked = new Set<string>();
  for (const original of project.sources) {
    const source = recovered.sources.find((candidate) => candidate.id === original.id)!;
    if (checked.has(source.uri)) continue;
    const { status } = await ports.check(source.uri);
    if (status === 'ready') {
      checked.add(source.uri);
      continue;
    }
    const document = await ports.choose(source, status);
    if (!document) throw new Error(`Video access is still needed for ${source.displayName}. Reopen this project and select the original video to restore preview. Your project and recovery drafts are preserved.`);
    if ((await ports.check(document.uri)).status !== 'ready') {
      throw new Error('Android could not retain readable access to the selected video. Your project is unchanged.');
    }
    const next = relinkProjectVideo(recovered, source, document, await ports.probe(document.uri));
    if (!await ports.confirm(source, document)) throw new Error('Re-link cancelled. Your project and recovery drafts are preserved.');
    recovered = next;
    checked.add(document.uri);
  }
  if (recovered !== project) await ports.persist(recovered);
  return recovered;
}
