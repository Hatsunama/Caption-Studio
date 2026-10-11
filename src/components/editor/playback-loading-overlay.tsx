import { ActivityIndicator, Modal, Text, View } from 'react-native';

import { AdaptiveDialog } from './adaptive-dialog';

import { chrome } from '@/lib/ui-theme';

export function PlaybackLoadingOverlay(props: {
  phase: 'loading' | 'buffering' | 'ready' | 'gap' | 'ended' | 'error' | 'suspended';
  hasPresentedFrame: boolean;
  admitted?: boolean;
}) {
  const waiting = props.admitted !== false && (props.phase === 'loading' || props.phase === 'buffering');
  if (!waiting) return null;
  if (props.hasPresentedFrame) {
    return (
      <View pointerEvents="none" accessibilityLiveRegion="polite" style={{ position: 'absolute', top: 12, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: chrome.radius.sm, backgroundColor: chrome.surface }}>
        <ActivityIndicator color={chrome.accent} size="small" />
        <Text style={{ color: chrome.text }}>Preparing video...</Text>
      </View>
    );
  }

  return (
    <Modal visible={waiting} transparent animationType="fade">
      <AdaptiveDialog maxWidth={340} gap={12} backgroundColor="rgba(0,0,0,0.72)">
          <ActivityIndicator color={chrome.accent} size="large" />
          <Text style={{ color: chrome.text, fontSize: 18, fontWeight: '900' }}>Loading video</Text>
          <Text style={{ color: chrome.muted, textAlign: 'center', lineHeight: 20 }}>
            Preparing the next playable frame.
          </Text>
      </AdaptiveDialog>
    </Modal>
  );
}
