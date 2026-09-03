import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { dualCaptionLanguageChoices, type DualCaptionLanguageChoice } from '@/lib/caption-languages';
import { chrome } from '@/lib/ui-theme';

export function DualLanguagePicker(props: {
  visible: boolean;
  sourceLanguageTag: string;
  sourceLanguageLabel: string;
  automaticModelLabel: string;
  onClose: () => void;
  onChoose: (choice: DualCaptionLanguageChoice) => Promise<void>;
}) {
  const insets = useSafeAreaInsets();
  const choices = dualCaptionLanguageChoices(props.sourceLanguageTag);
  const [pendingTag, setPendingTag] = useState<string>();
  const [selectionError, setSelectionError] = useState<string>();

  const close = () => {
    if (pendingTag) return;
    setSelectionError(undefined);
    props.onClose();
  };

  const choose = async (choice: DualCaptionLanguageChoice) => {
    if (pendingTag) return;
    setPendingTag(choice.tag);
    setSelectionError(undefined);
    try {
      await props.onChoose(choice);
    } catch (caught) {
      setSelectionError(caught instanceof Error ? caught.message : `${choice.displayName} subtitles could not be added.`);
    } finally {
      setPendingTag(undefined);
    }
  };

  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View style={{ flex: 1, backgroundColor: chrome.background, paddingTop: insets.top }}>
        <View style={{ paddingHorizontal: 20, paddingTop: 18, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: chrome.hairline }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: chrome.text, fontSize: 28, fontWeight: '700' }}>Second language</Text>
              <Text style={{ marginTop: 6, color: chrome.muted, fontSize: 14, lineHeight: 20 }}>
                Spoken captions stay in {props.sourceLanguageLabel}. Choose any language below to generate it privately on this phone.
              </Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close language picker" disabled={Boolean(pendingTag)} onPress={close} hitSlop={10} style={{ opacity: pendingTag ? 0.4 : 1 }}>
              <Text style={{ color: chrome.accent, fontSize: 17, fontWeight: '700' }}>Close</Text>
            </Pressable>
          </View>
        </View>
        {selectionError ? (
          <View accessibilityRole="alert" style={{ marginHorizontal: 16, marginTop: 14, padding: 14, borderRadius: chrome.radius.md, backgroundColor: chrome.dangerFill }}>
            <Text style={{ color: '#FFBBC8', fontSize: 14, lineHeight: 20, fontWeight: '700' }}>{selectionError}</Text>
            <Text style={{ marginTop: 4, color: chrome.muted, fontSize: 13 }}>Your project was not changed. Choose a language to retry.</Text>
          </View>
        ) : null}
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingBottom: Math.max(48, insets.bottom + 24), gap: 10 }}>
          {choices.map((choice) => (
            <Pressable
              key={choice.tag}
              accessibilityRole="button"
              accessibilityLabel={`Add ${choice.displayName} subtitles, generated on this phone`}
              accessibilityState={{ busy: pendingTag === choice.tag, disabled: Boolean(pendingTag) }}
              disabled={Boolean(pendingTag)}
              android_ripple={{ color: chrome.fill }}
              onPress={() => { void choose(choice); }}
              style={({ pressed }) => ({ gap: 6, paddingHorizontal: 16, paddingVertical: 14, borderRadius: chrome.radius.lg, backgroundColor: chrome.surface, opacity: pendingTag && pendingTag !== choice.tag ? 0.45 : pressed ? 0.75 : 1 })}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <Text style={{ flex: 1, color: chrome.text, fontSize: 17, fontWeight: '700' }}>{choice.displayName}</Text>
                {pendingTag === choice.tag ? <ActivityIndicator color={chrome.accent} /> : (
                  <View style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: chrome.radius.pill, backgroundColor: choice.automatic ? chrome.accent : chrome.fill }}>
                    <Text style={{ color: choice.automatic ? chrome.accentInk : chrome.muted, fontSize: 11, fontWeight: '700' }}>
                      {choice.automatic ? 'On this phone' : 'Unavailable'}
                    </Text>
                  </View>
                )}
              </View>
              <Text style={{ color: chrome.muted, fontSize: 13, lineHeight: 18 }}>
                {pendingTag === choice.tag
                  ? `Adding ${choice.displayName} to this project…`
                  : choice.automatic
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
