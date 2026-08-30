import { Image } from 'expo-image';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';

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
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: '#00000099' }}>
        <View style={{ maxHeight: '78%', gap: 14, padding: 18, paddingBottom: 28, borderTopLeftRadius: 24, borderTopRightRadius: 24, backgroundColor: '#171C22' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#F7F8FA', fontSize: 20, fontWeight: '900' }}>Extract audio</Text>
              <Text style={{ marginTop: 3, color: '#909BA8', fontSize: 12 }}>Choose by first frame, name, and duration.</Text>
            </View>
            <Pressable disabled={props.busy} onPress={props.onClose} hitSlop={10}>
              <Text style={{ color: '#F7F8FA', fontSize: 28 }}>×</Text>
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
                style={{ minHeight: 86, flexDirection: 'row', gap: 12, alignItems: 'center', padding: 10, borderRadius: 14, backgroundColor: '#242B34' }}>
                <View style={{ width: 112, aspectRatio: 16 / 9, overflow: 'hidden', borderRadius: 9, backgroundColor: '#090B0E' }}>
                  {source.thumbnailUri ? <Image source={{ uri: source.thumbnailUri }} contentFit="cover" style={{ flex: 1 }} /> : null}
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text numberOfLines={2} style={{ color: '#F7F8FA', fontSize: 14, fontWeight: '800' }}>{source.displayName}</Text>
                  <Text style={{ color: '#9EA8B4', fontSize: 12 }}>{formatDuration(source.durationMs)}</Text>
                </View>
              </Pressable>
            ))}
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            disabled={props.busy}
            onPress={props.onChooseAnother}
            style={{ minHeight: 50, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: '#DFFF35' }}>
            <Text style={{ color: '#11140C', fontSize: 14, fontWeight: '900' }}>Choose another video from phone</Text>
          </Pressable>
          {props.busy ? <Text style={{ color: '#DFFF35', textAlign: 'center', fontWeight: '800' }}>Extracting audio on this phone…</Text> : null}
        </View>
      </View>
    </Modal>
  );
}

function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
