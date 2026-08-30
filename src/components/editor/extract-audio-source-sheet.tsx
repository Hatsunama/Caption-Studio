import { Image } from 'expo-image';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';

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
  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.busy ? undefined : props.onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: chrome.overlay }}>
        <View style={{ maxHeight: '78%', gap: 14, padding: 18, paddingBottom: 28, borderTopLeftRadius: chrome.radius.xl, borderTopRightRadius: chrome.radius.xl, backgroundColor: chrome.surface }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: chrome.text, fontSize: 20, fontWeight: '700' }}>Extract audio</Text>
              <Text style={{ marginTop: 3, color: chrome.muted, fontSize: 12 }}>Choose by first frame, name, and duration.</Text>
            </View>
            <Pressable disabled={props.busy} onPress={props.onClose} hitSlop={10}>
              <Text style={{ color: chrome.text, fontSize: 28 }}>×</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ gap: 10 }}>
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
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            disabled={props.busy}
            onPress={props.onChooseAnother}
            style={{ minHeight: 50, alignItems: 'center', justifyContent: 'center', borderRadius: chrome.radius.lg, backgroundColor: chrome.accent }}>
            <Text style={{ color: chrome.accentInk, fontSize: 14, fontWeight: '700' }}>Choose another video from phone</Text>
          </Pressable>
          {props.busy ? <Text style={{ color: chrome.accent, textAlign: 'center', fontWeight: '700' }}>Extracting audio on this phone…</Text> : null}
        </View>
      </View>
    </Modal>
  );
}

function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
