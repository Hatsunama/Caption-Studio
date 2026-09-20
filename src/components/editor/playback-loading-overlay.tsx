import { ActivityIndicator, Modal, Text, View } from 'react-native';

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
      <View
        accessibilityLiveRegion="polite"
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 28,
          backgroundColor: 'rgba(0,0,0,0.72)',
        }}>
        <View
          style={{
            width: '100%',
            maxWidth: 340,
            alignItems: 'center',
            gap: 12,
            padding: 22,
            borderRadius: chrome.radius.xl,
            backgroundColor: chrome.surface,
          }}>
          <ActivityIndicator color={chrome.accent} size="large" />
          <Text style={{ color: chrome.text, fontSize: 18, fontWeight: '900' }}>Loading video</Text>
          <Text style={{ color: chrome.muted, textAlign: 'center', lineHeight: 20 }}>
            Preparing the next playable frame.
          </Text>
        </View>
      </View>
    </Modal>
  );
}
