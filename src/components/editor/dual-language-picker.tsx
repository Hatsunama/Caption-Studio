import { Modal, Pressable, ScrollView, Text, View } from 'react-native';

import { dualCaptionLanguageChoices, type DualCaptionLanguageChoice } from '@/lib/caption-languages';
import { chrome } from '@/lib/ui-theme';

export function DualLanguagePicker(props: {
  visible: boolean;
  sourceLanguageTag: string;
  sourceLanguageLabel: string;
  automaticModelLabel: string;
  onClose: () => void;
  onChoose: (choice: DualCaptionLanguageChoice) => void;
}) {
  const choices = dualCaptionLanguageChoices(props.sourceLanguageTag);

  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onClose}>
      <View style={{ flex: 1, backgroundColor: chrome.background }}>
        <View style={{ paddingHorizontal: 20, paddingTop: 18, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: chrome.hairline }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: chrome.text, fontSize: 28, fontWeight: '700' }}>Second language</Text>
              <Text style={{ marginTop: 6, color: chrome.muted, fontSize: 14, lineHeight: 20 }}>
                Spoken captions stay in {props.sourceLanguageLabel}. Finish those edits first. The second language is translated as a whole, then cut to the same subtitle rhythm.
              </Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close language picker" onPress={props.onClose} hitSlop={10}>
              <Text style={{ color: chrome.accent, fontSize: 17, fontWeight: '700' }}>Close</Text>
            </Pressable>
          </View>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 10 }}>
          {choices.map((choice) => (
            <Pressable
              key={choice.tag}
              accessibilityRole="button"
              accessibilityLabel={`Add ${choice.displayName} subtitles${choice.automatic ? ', translated on this phone' : ', typed by you'}`}
              onPress={() => props.onChoose(choice)}
              style={{ gap: 6, paddingHorizontal: 16, paddingVertical: 14, borderRadius: chrome.radius.lg, backgroundColor: chrome.surface }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <Text style={{ flex: 1, color: chrome.text, fontSize: 17, fontWeight: '700' }}>{choice.displayName}</Text>
                <View style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: chrome.radius.pill, backgroundColor: choice.automatic ? chrome.accent : chrome.fill }}>
                  <Text style={{ color: choice.automatic ? chrome.accentInk : chrome.muted, fontSize: 11, fontWeight: '700' }}>
                    {choice.automatic ? 'On this phone' : 'Type it'}
                  </Text>
                </View>
              </View>
              <Text style={{ color: chrome.muted, fontSize: 13, lineHeight: 18 }}>
                {choice.automatic
                  ? `Uses the ${props.automaticModelLabel} model after a one-time download. The whole ${props.sourceLanguageLabel} script is translated, then cut to your current subtitle blocks.`
                  : `Automatic translation does not cover this pair yet. Caption Studio still uses ${choice.displayName}-aware subtitle cuts, and you can type or paste the second language.`}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

export type { DualCaptionLanguageChoice };
