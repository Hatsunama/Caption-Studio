import { Alert } from 'react-native';
import { exportTranslationSummary } from '@/lib/export-caption-pairs';
import type { CaptionProject } from '@/types/project';

/** Consent applies to the caller's immutable export snapshot, never future edits. */
export function confirmOptionalTranslationExport(project: CaptionProject, video: boolean): Promise<boolean> {
  if (video && (!project.export.burnCaptions || !project.layers.some((layer) => layer.kind === 'captions' && layer.visible))) {
    return Promise.resolve(true);
  }
  const { missing, needsReview } = exportTranslationSummary(project);
  if (!missing && !needsReview) return Promise.resolve(true);
  return new Promise((resolve) => Alert.alert(
    'Export with unfinished translations?',
    `${missing} second-language lines are missing. ${needsReview} existing translations may need review.\n\nExport anyway keeps available text and omits empty second-language lines. Original captions and saved projects are unchanged. You can refresh or skip lines later.`,
    [
      { text: 'Back to editing', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Export anyway', onPress: () => resolve(true) },
    ],
    { cancelable: true, onDismiss: () => resolve(false) },
  ));
}
