import { Modal, Pressable, Text } from 'react-native';

import type { StyleScope } from '@/lib/style-resolver';
import { chrome } from '@/lib/ui-theme';

export function ScopeSheet(props: {
  visible: boolean;
  changeLabel: string;
  hasSelectedCaption: boolean;
  onChoose: (scope: StyleScope) => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.onClose}>
      <Pressable
        onPress={props.onClose}
        style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: chrome.overlay }}>
        <Pressable
          onPress={(event) => event.stopPropagation()}
          style={{
            gap: 14,
            padding: 22,
            paddingBottom: 34,
            borderTopLeftRadius: chrome.radius.xl,
            borderTopRightRadius: chrome.radius.xl,
            backgroundColor: chrome.surface,
          }}>
          <Text style={{ color: chrome.text, fontSize: 22, fontWeight: '800' }}>Apply to</Text>
          <Text style={{ color: chrome.muted, fontSize: 14 }}>{props.changeLabel}</Text>

          <ScopeButton
            title="This subtitle"
            description="Create an override for the selected timeline block."
            disabled={!props.hasSelectedCaption}
            onPress={() => props.onChoose('caption')}
          />
          <ScopeButton
            title="All subtitles"
            description="Update the project default while keeping intentional exceptions."
            onPress={() => props.onChoose('all')}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ScopeButton(props: {
  title: string;
  description: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => ({
        gap: 5,
        padding: 18,
        borderRadius: chrome.radius.md,
        opacity: props.disabled ? 0.35 : 1,
        backgroundColor: pressed ? chrome.fill : chrome.surfaceRaised,
        borderWidth: 1,
        borderColor: chrome.hairline,
      })}>
      <Text style={{ color: chrome.text, fontSize: 17, fontWeight: '700' }}>{props.title}</Text>
      <Text style={{ color: chrome.muted, fontSize: 13, lineHeight: 18 }}>{props.description}</Text>
    </Pressable>
  );
}
