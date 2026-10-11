import { ActivityIndicator, Text } from 'react-native';

import { AdaptiveDialog } from '@/components/editor/adaptive-dialog';
import { OperationOverlay } from '@/components/operation-overlay';

import type { MediaImportProgress } from '@/services/media-import';
import { chrome } from '@/lib/ui-theme';

export function MediaLoadingOverlay({ progress }: { progress?: MediaImportProgress }) {
  return (
    <OperationOverlay visible={Boolean(progress)}>
      <AdaptiveDialog maxWidth={360} padding={24}>
          <ActivityIndicator size="large" color={chrome.accent} />
          <Text style={{ color: chrome.text, fontSize: 20, fontWeight: '700', textAlign: 'center' }}>
            Loading your video{progress && progress.total > 1 ? 's' : ''}
          </Text>
          <Text style={{ color: chrome.muted, fontSize: 15, lineHeight: 21, textAlign: 'center' }}>
            {progress?.detail ?? 'Preparing your editor'}
          </Text>
          <Text style={{ color: chrome.accent, fontSize: 13, fontWeight: '600' }}>
            Keep Caption Studio open
          </Text>
      </AdaptiveDialog>
    </OperationOverlay>
  );
}
