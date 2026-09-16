import { Alert } from 'react-native';
import CaptionMedia from 'caption-media';
import { recoverProjectVideoAccess } from '@/lib/project-media-relink';
import { saveProject } from '@/services/database';
import type { CaptionProject } from '@/types/project';

function confirm(title: string, message: string, action: string): Promise<boolean> {
  return new Promise((resolve) => Alert.alert(title, message, [
    { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
    { text: action, onPress: () => resolve(true) },
  ], { cancelable: true, onDismiss: () => resolve(false) }));
}

const pending = new Map<string, Promise<CaptionProject>>();

export function ensureProjectVideoAccess(project: CaptionProject): Promise<CaptionProject> {
  const existing = pending.get(project.id);
  if (existing) return existing;
  const operation = recoverProjectVideoAccess(project, {
    check: (uri) => CaptionMedia.checkReadAccess(uri),
    probe: (uri) => CaptionMedia.getMediaInfo(uri),
    choose: async (source, status) => {
      const reason = status === 'permission-required'
        ? 'Android no longer provides lasting access to this video.'
        : 'The video is missing or its file provider is unavailable. If it is on removable or cloud storage, reconnect that provider and reopen the project, or select the original file below.';
      if (!await confirm('Restore video access', `${source.displayName}\n\n${reason}\n\nSelect the original video in Android Files. Captions, cuts, translations, and recovery drafts will be kept. No video copy is made.`, 'Select original video')) return null;
      const result = await CaptionMedia.pickVideoDocuments(false);
      return result.canceled ? null : result.assets[0] ?? null;
    },
    confirm: (source, document) => confirm('Confirm original video',
      `Re-link ${source.displayName} to ${document.name}?\n\nThe video metadata is compatible, but cannot prove this is the same recording. Continue only if you selected the original video. Every existing edit will be kept.`, 'Re-link video'),
    persist: saveProject,
  }).finally(() => pending.delete(project.id));
  pending.set(project.id, operation);
  return operation;
}
