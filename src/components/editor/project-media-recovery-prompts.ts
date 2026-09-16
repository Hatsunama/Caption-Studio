import { Alert } from 'react-native';
import type { ProjectMediaRecoveryPrompts } from '@/types/project-media-recovery';

function confirm(title: string, message: string, action: string): Promise<boolean> {
  return new Promise((resolve) => Alert.alert(title, message, [
    { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
    { text: action, onPress: () => resolve(true) },
  ], { cancelable: true, onDismiss: () => resolve(false) }));
}

export const projectMediaRecoveryPrompts: ProjectMediaRecoveryPrompts = {
  requestOriginal: (source, status) => {
    const reason = status === 'permission-required'
      ? 'Android no longer provides lasting access to this video.'
      : 'The video is missing or its file provider is unavailable. If it is on removable or cloud storage, reconnect that provider and reopen the project, or select the original file below.';
    return confirm('Restore video access', `${source.displayName}\n\n${reason}\n\nSelect the original video in Android Files. Captions, cuts, translations, and recovery drafts will be kept. No video copy is made.`, 'Select original video');
  },
  confirmOriginal: (source, document) => confirm('Confirm original video',
    `Re-link ${source.displayName} to ${document.name}?\n\nThe video metadata is compatible, but cannot prove this is the same recording. Continue only if you selected the original video. Every existing edit will be kept.`, 'Re-link video'),
};
