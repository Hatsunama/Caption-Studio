import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { dualLanguageChoiceCopy } from '@/components/editor/dual-language-choice-copy';

import { dualCaptionLanguageChoices, type DualCaptionLanguageChoice } from '@/lib/caption-languages';
import { chrome } from '@/lib/ui-theme';

export function DualLanguagePicker(props: {
  visible: boolean;
  sourceLanguageTag: string;
  sourceLanguageLabel: string;
  automaticModelLabel: string;
  onBackRequestChange?: (request: (() => void) | undefined) => void;
  onClose: () => void;
  onChoose: (choice: DualCaptionLanguageChoice) => Promise<void>;
}) {
  const { onBackRequestChange, onClose, visible } = props;
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const [rootHeight, setRootHeight] = useState(window.height);
  const compact = rootHeight < 480 || window.fontScale > 1.3;
  const choices = dualCaptionLanguageChoices(props.sourceLanguageTag);
  const [pendingTag, setPendingTag] = useState<string>();
  const [selectionError, setSelectionError] = useState<string>();

  const close = useCallback(() => {
    if (pendingTag) return;
    setSelectionError(undefined);
    onClose();
  }, [onClose, pendingTag]);

  useEffect(() => {
    onBackRequestChange?.(visible ? close : undefined);
    return () => onBackRequestChange?.(undefined);
  }, [close, onBackRequestChange, visible]);

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

  const intro = <Text testID="dual-language-picker-intro" style={{ marginTop: 6, color: chrome.muted, fontSize: 14, lineHeight: 20 }}>
                Spoken captions stay in {props.sourceLanguageLabel}. Choose any language below to generate it privately on this phone.
              </Text>;

  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View testID="dual-language-picker-root" onLayout={(event) => setRootHeight(event.nativeEvent.layout.height)}
        style={{ flex: 1, minHeight: 0, backgroundColor: chrome.background, paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }}>
        <View style={{ paddingHorizontal: compact ? 12 : 20, paddingTop: compact ? 8 : 18, paddingBottom: compact ? 8 : 12, borderBottomWidth: 1, borderBottomColor: chrome.hairline }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={compact ? 1 : undefined} style={{ color: chrome.text, fontSize: compact ? 20 : 28, fontWeight: '700' }}>Second language</Text>
              {!compact ? intro : null}
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close language picker" disabled={Boolean(pendingTag)} onPress={close} hitSlop={10} style={{ opacity: pendingTag ? 0.4 : 1, minHeight: 44, justifyContent: 'center' }}>
              <Text style={{ color: chrome.accent, fontSize: 17, fontWeight: '700' }}>Close</Text>
            </Pressable>
          </View>
        </View>

        <ScrollView style={{ flexShrink: 1, minHeight: 0 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingBottom: Math.max(48, insets.bottom + 24), gap: 10 }}>
          {compact ? intro : null}
        {selectionError ? (
          <View accessibilityRole="alert" style={{ marginHorizontal: 16, marginTop: 14, padding: 14, borderRadius: chrome.radius.md, backgroundColor: chrome.dangerFill }}>
            <Text style={{ color: '#FFBBC8', fontSize: 14, lineHeight: 20, fontWeight: '700' }}>{selectionError}</Text>
            <Text style={{ marginTop: 4, color: chrome.muted, fontSize: 13 }}>Your project was not changed. Choose a language to retry.</Text>
          </View>
        ) : null}
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
                      {dualLanguageChoiceCopy(choice.automatic, choice.displayName, props.sourceLanguageLabel, props.automaticModelLabel).badge}
                    </Text>
                  </View>
                )}
              </View>
              <Text style={{ color: chrome.muted, fontSize: 13, lineHeight: 18 }}>
                {pendingTag === choice.tag
                  ? `Adding ${choice.displayName} to this project…`
                  : dualLanguageChoiceCopy(choice.automatic, choice.displayName, props.sourceLanguageLabel, props.automaticModelLabel).detail}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

export type { DualCaptionLanguageChoice };
