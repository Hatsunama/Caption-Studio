import { ActivityIndicator, Modal, Text, View } from 'react-native';

import { chrome } from '@/lib/ui-theme';

export function PlaybackLoadingOverlay(props: {
  phase: 'loading' | 'buffering' | 'ready' | 'gap' | 'ended' | 'error';
  hasPresentedFrame: boolean;
}) {
  const waiting = props.phase === 'loading' || props.phase === 'buffering';

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
