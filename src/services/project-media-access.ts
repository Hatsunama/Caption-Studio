import CaptionMedia from 'caption-media';
import { recoverProjectVideoAccess } from '@/services/project-media-recovery';
import { saveProject } from '@/services/database';
import { releaseUnreferencedReadPermissions } from '@/services/media-permissions';
import type { CaptionProject } from '@/types/project';
import type { ProjectMediaRecoveryPrompts } from '@/types/project-media-recovery';

const pending = new Map<string, Promise<CaptionProject>>();

export function ensureProjectVideoAccess(project: CaptionProject, prompts: ProjectMediaRecoveryPrompts): Promise<CaptionProject> {
  const existing = pending.get(project.id);
  if (existing) return existing;
  const operation = recoverProjectVideoAccess(project, {
    check: (uri) => CaptionMedia.checkReadAccess(uri),
    probe: (uri) => CaptionMedia.getMediaInfo(uri),
    choose: async (source, status) => {
      if (!await prompts.requestOriginal(source, status)) return null;
      const result = await CaptionMedia.pickVideoDocuments(false);
      return result.canceled ? null : result.assets[0] ?? null;
    },
    confirm: (source, document) => prompts.confirmOriginal(source, document),
    persist: saveProject,
    releaseUnused: releaseUnreferencedReadPermissions,
  }).finally(() => pending.delete(project.id));
  pending.set(project.id, operation);
  return operation;
}
