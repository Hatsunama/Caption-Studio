import { createCaptionProject, createVideoClip } from '@/lib/project-factory';
import { addAudioSourceToProject } from '@/lib/audio-timeline';
import {
  abandonedLedgerAssets,
  abandonedLinkedMediaPermissions,
  abandonedProjectOwnedUris,
  collectProjectOwnedUris,
  type LinkedMediaPermissionLedger,
  type ProjectOwnedAssetLedger,
} from '@/lib/media-lifecycle';
import { totalClipDuration } from '@/lib/video-timeline';
import type { TranscriptionModel } from '@/lib/model-catalog';
import { humanVideoName } from '@/lib/project-presentation';
import {
  deleteProjectRecord,
  deleteUnreadableProjectRecord,
  getProject,
  listProjectRecordIds,
  listProjectRecords,
  saveProject,
} from '@/services/database';
import {
  pickAndStoreAudio,
  pickLinkedVideos,
  pickVideoAndExtractAudio,
  extractAudioFromProjectVideo,
  type MediaImportProgress,
} from '@/services/media-import';
import {
  deleteProjectFiles,
  deleteProjectOwnedFiles,
  ensureProjectThumbnail,
  reconcileOrphanedProjectDirectories,
  reconcileProjectOwnedFiles,
} from '@/services/project-media';
import { generateProjectCaptions } from '@/services/project-transcription';
import { persistProjectCheckpoint } from '@/services/project-persistence';
import { cleanupStaleProjectRecoveryCache } from '@/services/project-recovery';
import CaptionMedia from 'caption-media';
import { createCaptionGenerationSession } from '@/services/caption-generation-session';
import {
  linkedMediaUris,
  releaseReadPermissions,
  releaseUnreferencedReadPermissions,
  retryPendingReadPermissionReleases,
} from '@/services/media-permissions';
import type { TranscriptionProgress } from '@/services/transcription';
import type { CaptionProject } from '@/types/project';
import type { ProjectRecordSummary } from '@/types/project-library';

const captionGenerationSession = createCaptionGenerationSession(() => CaptionMedia.cancelAudioExtraction());

export async function importVideoProject(
  onProgress?: (progress: MediaImportProgress) => void,
): Promise<CaptionProject | null> {
  const importedAt = Date.now();
  const projectId = `project-${importedAt}`;
  const sources = await pickLinkedVideos(projectId, onProgress);
  if (!sources) return null;
  const projectName = humanVideoName(sources[0].displayName, importedAt);
  const project = createCaptionProject({
    id: projectId,
    name: projectName,
    sources,
  });
  onProgress?.({ stage: 'saving', completed: sources.length, total: sources.length, detail: 'Saving your draft' });
  try {
    await saveProject(project);
  } catch (error) {
    await runBestEffortCleanup('failed project import', [
      deleteProjectFiles(project.id),
      releaseReadPermissions(sources.map((source) => source.uri)),
    ]);
    throw error;
  }
  return project;
}

export type EditorMediaLedger = {
  owned: ProjectOwnedAssetLedger;
  linked: LinkedMediaPermissionLedger;
};

export async function loadProjectForEditing(projectId: string) {
  let project = await getProject(projectId);
  if (project) {
    const loadedProject = project;
    await runBestEffortCleanup('project media reconciliation', [
      reconcileProjectOwnedFiles(loadedProject.id, collectProjectOwnedUris(loadedProject)),
    ]);
    const sources = [];
    for (const source of loadedProject.sources) {
      const thumbnailUri = await ensureProjectThumbnail({
        projectId: loadedProject.id,
        sourceId: source.id,
        videoUri: source.uri,
        thumbnailUri: source.thumbnailUri,
      });
      sources.push({ ...source, thumbnailUri: thumbnailUri ?? source.thumbnailUri });
    }
    if (sources.some((source, index) => source.thumbnailUri !== loadedProject.sources[index].thumbnailUri)) {
      project = { ...loadedProject, sources };
      await saveProject(project);
    }
  }
  return project;
}

export async function checkpointEditorProject(project: CaptionProject) {
  return persistProjectCheckpoint(project);
}

export async function appendVideosToProject(
  project: CaptionProject,
  onProgress?: (progress: MediaImportProgress) => void,
) {
  const sources = await pickLinkedVideos(project.id, onProgress);
  if (!sources) return null;
  const next: CaptionProject = {
    ...project,
    updatedAt: new Date().toISOString(),
    sources: [...project.sources, ...sources],
    clips: [
      ...project.clips,
      ...sources.map((source, index) => createVideoClip(
        source,
        project.clips.length + index,
        project.videoTransform,
      )),
    ],
  };
  onProgress?.({ stage: 'saving', completed: sources.length, total: sources.length, detail: 'Adding videos to the timeline' });
  try {
    await saveProject(next);
  } catch (error) {
    await runBestEffortCleanup('failed video append', [
      deleteProjectOwnedFiles(project.id, sources.map((source) => source.thumbnailUri).filter((uri): uri is string => Boolean(uri))),
      releaseReadPermissions(sources.map((source) => source.uri)),
    ]);
    throw error;
  }
  return next;
}

export async function appendAudioToProject(
  project: CaptionProject,
  currentMs: number,
  origin: 'audio-file' | 'video-audio',
) {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const sourceId = `audio-source-${nonce}`;
  const source = origin === 'audio-file'
    ? await pickAndStoreAudio(project.id, sourceId)
    : await pickVideoAndExtractAudio(project.id, sourceId);
  if (!source) return null;
  const result = addAudioSourceToProject(
    project,
    source,
    `audio-clip-${nonce}`,
    currentMs,
    totalClipDuration(project.clips),
  );
  if (!result) {
    await runBestEffortCleanup('unused audio import', [deleteProjectOwnedFiles(project.id, [source.uri])]);
    throw new Error('Move the playhead earlier so the audio has room on the video timeline.');
  }
  try {
    await saveProject(result.project);
  } catch (error) {
    await runBestEffortCleanup('failed audio append', [deleteProjectOwnedFiles(project.id, [source.uri])]);
    throw error;
  }
  return result;
}

export async function generateAndSaveProjectCaptions(
  project: CaptionProject,
  modelId: TranscriptionModel['id'],
  onProgress?: (progress: TranscriptionProgress) => void,
) {
  return captionGenerationSession.run(async (session) => {
    const guardedProgress = (progress: TranscriptionProgress) => {
      if (!session.isCancelled()) onProgress?.(progress);
    };
    const generated = await generateProjectCaptions(project, modelId, guardedProgress, saveProject, session);
    session.throwIfCancelled();
    await saveProject(generated);
    session.throwIfCancelled();
    return generated;
  });
}

export async function appendProjectVideoAudioToProject(
  project: CaptionProject,
  currentMs: number,
  videoSourceId: string,
) {
  const videoSource = project.sources.find((source) => source.id === videoSourceId);
  if (!videoSource) throw new Error('That project video is no longer available.');
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const source = await extractAudioFromProjectVideo(project.id, `audio-source-${nonce}`, videoSource);
  const result = addAudioSourceToProject(
    project,
    source,
    `audio-clip-${nonce}`,
    currentMs,
    totalClipDuration(project.clips),
  );
  if (!result) {
    await runBestEffortCleanup('unused extracted audio', [deleteProjectOwnedFiles(project.id, [source.uri])]);
    throw new Error('Move the playhead earlier so the audio has room on the video timeline.');
  }
  try {
    await saveProject(result.project);
  } catch (error) {
    await runBestEffortCleanup('failed extracted audio append', [deleteProjectOwnedFiles(project.id, [source.uri])]);
    throw error;
  }
  return result;
}

export function cancelProjectCaptionGeneration() {
  return captionGenerationSession.cancel();
}

export async function saveEditorDraft(project: CaptionProject, ledger?: EditorMediaLedger) {
  const previous = await getProject(project.id);
  const referencedSourceIds = new Set(project.clips.map((clip) => clip.sourceId));
  const sources = project.sources.filter((source) => referencedSourceIds.has(source.id));
  const removedThumbnailUris = project.sources
    .filter((source) => !referencedSourceIds.has(source.id))
    .map((source) => source.thumbnailUri)
    .filter((uri): uri is string => Boolean(uri));
  const sourceResults = Object.fromEntries(
    Object.entries(project.transcription.sourceResults).filter(([sourceId]) => referencedSourceIds.has(sourceId)),
  );
  const referencedAudioSourceIds = new Set(project.audioClips.map((clip) => clip.sourceId));
  const audioSources = project.audioSources.filter((source) => referencedAudioSourceIds.has(source.id));
  const removedAudioUris = project.audioSources
    .filter((source) => !referencedAudioSourceIds.has(source.id))
    .map((source) => source.uri);
  const saved: CaptionProject = {
    ...project,
    updatedAt: new Date().toISOString(),
    lifecycle: { status: 'saved' },
    sources,
    audioSources,
    transcription: { ...project.transcription, sourceResults },
  };
  await saveProject(saved);
  const replacedUris = previous ? abandonedProjectOwnedUris(previous, saved) : [];
  const abandonedSessionUris = ledger ? abandonedLedgerAssets(ledger.owned, saved) : [];
  await runBestEffortCleanup('saved draft media reconciliation', [
    deleteProjectOwnedFiles(project.id, [...removedThumbnailUris, ...removedAudioUris, ...replacedUris, ...abandonedSessionUris]),
  ]);
  const removedLinked = previous
    ? linkedMediaUris(previous).filter((uri) => !linkedMediaUris(saved).includes(uri))
    : [];
  await releaseUnreferencedReadPermissions([
    ...removedLinked,
    ...(ledger ? abandonedLinkedMediaPermissions(ledger.linked, saved) : []),
  ]);
  return saved;
}

export async function discardEditorSession(
  initialProject: CaptionProject,
  currentProject: CaptionProject,
  ledger?: EditorMediaLedger,
) {
  if (initialProject.lifecycle.status === 'draft') {
    await deleteProjectCompletely(initialProject.id);
    if (ledger) await releaseUnreferencedReadPermissions(ledger.linked.uris);
    return;
  }
  await saveProject(initialProject);
  const discardedUris = abandonedProjectOwnedUris(currentProject, initialProject);
  const abandonedSessionUris = ledger ? abandonedLedgerAssets(ledger.owned, initialProject) : [];
  await runBestEffortCleanup('discarded editor media reconciliation', [
    deleteProjectOwnedFiles(initialProject.id, [...discardedUris, ...abandonedSessionUris]),
  ]);
  await releaseUnreferencedReadPermissions([
    ...linkedMediaUris(currentProject).filter((uri) => !linkedMediaUris(initialProject).includes(uri)),
    ...(ledger ? abandonedLinkedMediaPermissions(ledger.linked, initialProject) : []),
  ]);
}

export async function deleteProjectCompletely(projectId: string) {
  const deletedProject = await deleteProjectRecord(projectId);
  await runBestEffortCleanup('deleted project cleanup', [
    deleteProjectFiles(projectId),
    deletedProject
      ? releaseUnreferencedReadPermissions(linkedMediaUris(deletedProject))
      : Promise.resolve(),
  ]);
}

export async function deleteUnreadableProjectCompletely(projectId: string) {
  const linkedUris = await deleteUnreadableProjectRecord(projectId);
  await runBestEffortCleanup('deleted unreadable project cleanup', [
    deleteProjectFiles(projectId),
    releaseUnreferencedReadPermissions(linkedUris),
  ]);
}

export async function loadProjectLibrary(): Promise<ProjectRecordSummary[]> {
  const [storedRecords, projectRecordIds] = await Promise.all([listProjectRecords(), listProjectRecordIds()]);
  await runBestEffortCleanup('orphaned project media reconciliation', [
    reconcileOrphanedProjectDirectories(projectRecordIds),
    retryPendingReadPermissionReleases(),
    cleanupStaleProjectRecoveryCache(),
  ]);
  return storedRecords.map((record) => record.kind === 'unreadable'
    ? record
    : {
        kind: 'project' as const,
        project: {
          ...record.project,
          name: humanVideoName(record.project.name, record.project.createdAt),
        },
      });
}

export async function ensureLibraryProjectThumbnail(project: CaptionProject) {
  const source = project.sources[0];
  if (!source) return project;
  const thumbnailUri = await ensureProjectThumbnail({
    projectId: project.id,
    sourceId: source.id,
    videoUri: source.uri,
    thumbnailUri: source.thumbnailUri,
  });
  if (!thumbnailUri || thumbnailUri === source.thumbnailUri) return project;
  const sources = project.sources.map((candidate) => candidate.id === source.id
    ? { ...candidate, thumbnailUri }
    : candidate);
  const prepared = { ...project, sources };
  await saveProject(prepared);
  return prepared;
}

async function runBestEffortCleanup(label: string, operations: Promise<unknown>[]) {
  const results = await Promise.allSettled(operations);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    console.warn(`Caption Studio retained ${failures.length} item(s) during ${label}; cleanup will be retried.`);
  }
}
