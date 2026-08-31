import { ActivityIndicator, Modal, Text, View } from 'react-native';

import type { MediaImportProgress } from '@/services/media-import';
import { chrome } from '@/lib/ui-theme';

export function MediaLoadingOverlay({ progress }: { progress?: MediaImportProgress }) {
  return (
    <Modal visible={Boolean(progress)} transparent animationType="fade">
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, backgroundColor: chrome.overlay }}>
        <View style={{ width: '100%', maxWidth: 360, alignItems: 'center', gap: 14, padding: 24, borderRadius: chrome.radius.xl, backgroundColor: chrome.surface }}>
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
        </View>
      </View>
    </Modal>
  );
}
