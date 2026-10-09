import { Image } from 'expo-image';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { chrome } from '@/lib/ui-theme';
import type { ProjectVideoSource } from '@/types/project';

export function ExtractAudioSourceSheet(props: {
  visible: boolean;
  sources: ProjectVideoSource[];
  busy: boolean;
  onChoose: (sourceId: string) => void;
  onChooseAnother: () => void;
  onClose: () => void;
}) {
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [rootHeight, setRootHeight] = useState(window.height);
  const compact = rootHeight < 480 || window.fontScale > 1.3;
  const intro = <Text style={{ marginTop: 3, color: chrome.muted, fontSize: 12 }}>Choose by first frame, name, and duration.</Text>;
  const actions = <View style={{ gap: 14 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Choose another video from phone"
            disabled={props.busy}
            onPress={props.onChooseAnother}
            style={{ minHeight: 50, alignItems: 'center', justifyContent: 'center', borderRadius: chrome.radius.lg, backgroundColor: chrome.accent }}>
            <Text style={{ color: chrome.accentInk, fontSize: 14, fontWeight: '700' }}>Choose another video from phone</Text>
          </Pressable>
          {props.busy ? <Text style={{ color: chrome.accent, textAlign: 'center', fontWeight: '700' }}>Extracting audio on this phone…</Text> : null}
  </View>;
  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.busy ? () => {} : props.onClose}>
      <View testID="extract-audio-source-sheet-root" onLayout={(event) => setRootHeight(event.nativeEvent.layout.height)}
        style={{ flex: 1, minHeight: 0, justifyContent: 'flex-end', backgroundColor: chrome.overlay, paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }}>
        <View testID="extract-audio-source-sheet-card" style={{ maxHeight: compact ? '100%' : '78%', minHeight: 0, flexShrink: 1, gap: compact ? 8 : 14, padding: compact ? 12 : 18, paddingBottom: compact ? 12 : 28, borderTopLeftRadius: chrome.radius.xl, borderTopRightRadius: chrome.radius.xl, backgroundColor: chrome.surface }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={compact ? 1 : undefined} style={{ color: chrome.text, fontSize: 20, fontWeight: '700' }}>Extract audio</Text>
              {!compact ? intro : null}
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close audio source picker" disabled={props.busy} onPress={props.onClose} hitSlop={10} style={{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: chrome.text, fontSize: 28 }}>×</Text>
            </Pressable>
          </View>
          <ScrollView style={{ flexShrink: 1, minHeight: 0 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 10 }}>
            {compact ? intro : null}
            {props.sources.map((source) => (
              <Pressable
                key={source.id}
                accessibilityRole="button"
                accessibilityLabel={`Extract audio from ${source.displayName}`}
                disabled={props.busy}
                onPress={() => props.onChoose(source.id)}
                style={{ minHeight: 86, flexDirection: 'row', gap: 12, alignItems: 'center', padding: 10, borderRadius: chrome.radius.lg, backgroundColor: chrome.surfaceRaised }}>
                <View style={{ width: 112, aspectRatio: 16 / 9, overflow: 'hidden', borderRadius: chrome.radius.sm, backgroundColor: chrome.background }}>
                  {source.thumbnailUri ? <Image source={{ uri: source.thumbnailUri }} contentFit="cover" style={{ flex: 1 }} /> : null}
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text numberOfLines={2} style={{ color: chrome.text, fontSize: 14, fontWeight: '700' }}>{source.displayName}</Text>
                  <Text style={{ color: chrome.muted, fontSize: 12 }}>{formatDuration(source.durationMs)}</Text>
                </View>
              </Pressable>
            ))}
            {compact ? actions : null}
          </ScrollView>
          {!compact ? actions : null}
        </View>
      </View>
    </Modal>
  );
}

function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
