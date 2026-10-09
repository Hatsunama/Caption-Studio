import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { chrome } from '@/lib/ui-theme';
import type { TextVisualLayer } from '@/types/project';

type Props = {
  visible: boolean;
  watermarks: TextVisualLayer[];
  maxWatermarks: number;
  onAdd: (text: string) => void;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
};

export function WatermarkSheet(props: Props) {
  const [text, setText] = useState('');
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [rootHeight, setRootHeight] = useState(window.height);
  const compact = rootHeight < 480 || window.fontScale > 1.3;
  const atLimit = props.watermarks.length >= props.maxWatermarks;
  const close = () => { setText(''); props.onClose(); };
  return (
    <Modal animationType="slide" onRequestClose={close} transparent visible={props.visible}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, minHeight: 0 }}>
      <View testID="watermark-sheet-root"
        onLayout={(event) => setRootHeight(event.nativeEvent.layout.height)}
        style={{ flex: 1, minHeight: 0, justifyContent: 'flex-end', backgroundColor: '#000000A6', paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }}>
        <View testID="watermark-sheet-card" style={{ maxHeight: compact ? '100%' : '76%', minHeight: 0, flexShrink: 1, gap: compact ? 8 : 14, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderColor: '#FF8FC455', backgroundColor: chrome.surface, padding: compact ? 12 : 20 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ color: chrome.text, fontSize: 20, fontWeight: '900' }} numberOfLines={compact ? 1 : undefined}>Watermarks</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close watermarks" onPress={close} style={{ padding: 8, minHeight: 44, justifyContent: 'center' }}><Text style={{ color: chrome.muted, fontSize: 14, fontWeight: '800' }}>CLOSE</Text></Pressable>
          </View>
          <ScrollView style={{ flexShrink: 1, minHeight: 0 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 14, paddingBottom: 10 }}>
          <Text style={{ color: chrome.muted, fontSize: 12, lineHeight: 18 }}>Add up to five labels. Each is a regular timeline layer: drag it anywhere on the preview, then move or trim it on the timeline.</Text>
          <TextInput disableFullscreenUI accessibilityLabel="Watermark words" editable={!atLimit} maxLength={160} onChangeText={setText} placeholder="Words for this watermark" placeholderTextColor={chrome.muted} style={{ borderRadius: 12, borderWidth: 1, borderColor: '#FF8FC488', color: chrome.text, fontSize: 16, paddingHorizontal: 14, paddingVertical: 12 }} value={text} />
          <Pressable accessibilityLabel="Add watermark" disabled={atLimit || !text.trim()} onPress={() => { props.onAdd(text.trim()); setText(''); }} style={{ alignItems: 'center', borderRadius: 12, backgroundColor: atLimit || !text.trim() ? '#6D526088' : '#E8579C', paddingVertical: 13 }}><Text style={{ color: '#170C13', fontSize: 14, fontWeight: '900' }}>{atLimit ? 'FIVE WATERMARKS ADDED' : 'ADD WATERMARK'}</Text></Pressable>
          <View style={{ gap: 9 }}>
            {props.watermarks.map((watermark, index) => <View key={watermark.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, backgroundColor: '#E8579C1F', padding: 10 }}>
              <Pressable accessibilityLabel={`Select watermark ${index + 1}`} onPress={() => props.onSelect(watermark.id)} style={{ flex: 1 }}><Text numberOfLines={1} style={{ color: chrome.text, fontSize: 14, fontWeight: '800' }}>{watermark.text}</Text><Text style={{ color: '#FF8FC4', fontSize: 10, fontWeight: '700' }}>DRAG ON PREVIEW TO POSITION</Text></Pressable>
              <Pressable accessibilityLabel={`Remove watermark ${index + 1}`} onPress={() => props.onRemove(watermark.id)} style={{ padding: 8 }}><Text style={{ color: '#FF8FC4', fontSize: 11, fontWeight: '900' }}>REMOVE</Text></Pressable>
            </View>)}
          </View>
          </ScrollView>
        </View>
      </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
