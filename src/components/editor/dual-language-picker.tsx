import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
  const insets = useSafeAreaInsets();
  const choices = dualCaptionLanguageChoices(props.sourceLanguageTag);

  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onClose}>
      <View style={{ flex: 1, backgroundColor: chrome.background, paddingTop: insets.top }}>
        <View style={{ paddingHorizontal: 20, paddingTop: 18, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: chrome.hairline }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: chrome.text, fontSize: 28, fontWeight: '700' }}>Second language</Text>
              <Text style={{ marginTop: 6, color: chrome.muted, fontSize: 14, lineHeight: 20 }}>
                Spoken captions stay in {props.sourceLanguageLabel}. Finish those edits first. English and Chinese can be translated on this phone as a whole, then cut to the same subtitle rhythm. Other languages are typed or pasted by you.
              </Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close language picker" onPress={props.onClose} hitSlop={10}>
              <Text style={{ color: chrome.accent, fontSize: 17, fontWeight: '700' }}>Close</Text>
            </Pressable>
          </View>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: Math.max(48, insets.bottom + 24), gap: 10 }}>
          {choices.map((choice) => (
            <Pressable
              key={choice.tag}
              accessibilityRole="button"
              accessibilityLabel={`Add ${choice.displayName} subtitles, generated on this phone`}
              onPress={() => props.onChoose(choice)}
              style={{ gap: 6, paddingHorizontal: 16, paddingVertical: 14, borderRadius: chrome.radius.lg, backgroundColor: chrome.surface }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <Text style={{ flex: 1, color: chrome.text, fontSize: 17, fontWeight: '700' }}>{choice.displayName}</Text>
                <View style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: chrome.radius.pill, backgroundColor: choice.automatic ? chrome.accent : chrome.fill }}>
                  <Text style={{ color: choice.automatic ? chrome.accentInk : chrome.muted, fontSize: 11, fontWeight: '700' }}>
                    {choice.automatic ? 'On this phone' : 'Unavailable'}
                  </Text>
                </View>
              </View>
              <Text style={{ color: chrome.muted, fontSize: 13, lineHeight: 18 }}>
                {choice.automatic
                  ? `Uses the ${props.automaticModelLabel} model after a one-time download. Keep this screen open while the whole ${props.sourceLanguageLabel} script is translated.`
                  : `${choice.displayName} is unavailable for this source language.`}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

export type { DualCaptionLanguageChoice };
