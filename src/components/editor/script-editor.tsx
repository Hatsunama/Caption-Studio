import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  mergeCaptionScriptBlock,
  splitCaptionScriptBlock,
  updateCaptionScriptText,
} from '@/lib/caption-script';
import {
  clearEditorDraftJournal,
  readEditorDraftJournal,
  writeEditorDraftJournal,
} from '@/services/editor-draft-journal';
import type { CaptionBlock, WordToken } from '@/types/project';

export function ScriptEditor(props: {
  visible: boolean;
  projectId: string;
  baseRevision: string;
  captions: CaptionBlock[];
  words: WordToken[];
  initialCaptionId?: string;
  onSelectCaption: (caption: CaptionBlock) => void;
  onCancel: () => void;
  onSave: (captions: CaptionBlock[]) => Promise<void>;
}) {
  const listRef = useRef<FlatList<CaptionBlock>>(null);
  const selectionRef = useRef<Record<string, { start: number; end: number }>>({});
  const splitCounterRef = useRef(0);
  const [draftCaptions, setDraftCaptions] = useState<CaptionBlock[]>([]);
  const [editingCaptionId, setEditingCaptionId] = useState<string>();
  const [selectedCaptionId, setSelectedCaptionId] = useState<string>();
  const [emptyCaptionId, setEmptyCaptionId] = useState<string>();
  const [boundaryMessage, setBoundaryMessage] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [journalReady, setJournalReady] = useState(false);
  const wasVisibleRef = useRef(false);

  const sourceCaptions = useMemo(
    () => [...props.captions].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs),
    [props.captions],
  );
  const initialIndex = useMemo(() => {
    const index = sourceCaptions.findIndex((caption) => caption.id === props.initialCaptionId);
    return index < 0 ? 0 : index;
  }, [sourceCaptions, props.initialCaptionId]);

  useEffect(() => {
    const opening = props.visible && !wasVisibleRef.current;
    wasVisibleRef.current = props.visible;
    if (!opening) return;
    setDraftCaptions(sourceCaptions);
    setSelectedCaptionId(sourceCaptions[initialIndex]?.id);
    setEditingCaptionId(undefined);
    setEmptyCaptionId(undefined);
    setBoundaryMessage(undefined);
    setSaveError(undefined);
    setSaving(false);
    setJournalReady(false);
    selectionRef.current = {};
    splitCounterRef.current = 0;
    void readEditorDraftJournal(props.projectId, 'caption-script').then((journal) => {
      const recovered = decodeCaptionDraft(journal?.payload);
      if (!recovered) {
        setJournalReady(true);
        return;
      }
      const conflict = journal?.baseRevision !== props.baseRevision;
      Alert.alert(
        conflict ? 'Recovery draft needs review' : 'Restore unsaved caption edits?',
        conflict
          ? 'The project changed after this recovery draft was created. Review it carefully before saving.'
          : 'Caption Studio recovered edits that were not saved before the app closed.',
        [
          {
            text: 'Discard recovery',
            style: 'destructive',
            onPress: () => {
              void clearEditorDraftJournal(props.projectId, 'caption-script');
              setJournalReady(true);
            },
          },
          { text: 'Restore', onPress: () => { setDraftCaptions(recovered); setJournalReady(true); } },
        ],
      );
    }).catch(() => setJournalReady(true));
    const timer = setTimeout(() => {
      if (sourceCaptions.length) {
        listRef.current?.scrollToIndex({ index: initialIndex, animated: false, viewPosition: 0.35 });
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [initialIndex, props.baseRevision, props.projectId, props.visible, sourceCaptions]);

  useEffect(() => {
    if (!props.visible || !journalReady || sameCaptionDraft(draftCaptions, sourceCaptions)) return;
    const timer = setTimeout(() => {
      void writeEditorDraftJournal(props.projectId, 'caption-script', props.baseRevision, draftCaptions);
    }, 600);
    return () => clearTimeout(timer);
  }, [draftCaptions, journalReady, props.baseRevision, props.projectId, props.visible, sourceCaptions]);

  const selectForEditing = (caption: CaptionBlock) => {
    selectionRef.current[caption.id] ??= { start: caption.text.length, end: caption.text.length };
    setSelectedCaptionId(caption.id);
    setEditingCaptionId(caption.id);
    setEmptyCaptionId(undefined);
    setBoundaryMessage(undefined);
    props.onSelectCaption(caption);
  };

  const focusCaption = (captionId: string, captions: CaptionBlock[]) => {
    const index = captions.findIndex((caption) => caption.id === captionId);
    setDraftCaptions(captions);
    setSelectedCaptionId(captionId);
    setEditingCaptionId(captionId);
    setEmptyCaptionId(undefined);
    setTimeout(() => {
      if (index >= 0) listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.4 });
    }, 40);
  };

  const updateText = (caption: CaptionBlock, text: string) => {
    const newlineIndex = text.indexOf('\n');
    if (newlineIndex >= 0) {
      const withTypedText = updateCaptionScriptText(draftCaptions, caption.id, text.replace('\n', ''));
      const result = splitCaptionScriptBlock(
        withTypedText,
        caption.id,
        newlineIndex,
        props.words,
        nextSplitCaptionId(caption.id, withTypedText, splitCounterRef),
      );
      if (result) {
        setBoundaryMessage(undefined);
        focusCaption(result.focusedId, result.captions);
        return;
      }
      setBoundaryMessage('Place the cursor between two words to split this subtitle.');
      return;
    }
    setDraftCaptions((current) => updateCaptionScriptText(current, caption.id, text));
    if (text.trim()) setEmptyCaptionId(undefined);
  };

  const mergeWithPrevious = (caption: CaptionBlock, requireCursorAtStart = true) => {
    const selection = selectionRef.current[caption.id];
    if (requireCursorAtStart && (!selection || selection.start !== 0 || selection.end !== 0)) return;
    const result = mergeCaptionScriptBlock(draftCaptions, caption.id);
    if (!result) return;
    if ('blockedByVideoCut' in result) {
      setBoundaryMessage('Subtitles on opposite sides of a video cut cannot be merged.');
      return;
    }
    setBoundaryMessage(undefined);
    focusCaption(result.focusedId, result.captions);
  };

  const mergeWithNext = (caption: CaptionBlock) => {
    const result = mergeCaptionScriptBlock(draftCaptions, caption.id, 'next');
    if (!result) {
      setBoundaryMessage('There is no subtitle below this one to join.');
      return;
    }
    if ('blockedByVideoCut' in result) {
      setBoundaryMessage('Subtitles on opposite sides of a video cut cannot be joined.');
      return;
    }
    setBoundaryMessage(undefined);
    focusCaption(result.focusedId, result.captions);
  };

  const splitAtCursor = (caption: CaptionBlock) => {
    const selection = selectionRef.current[caption.id];
    if (!selection || selection.start !== selection.end) {
      setBoundaryMessage('Tap between two words, then choose Split here.');
      return;
    }
    const result = splitCaptionScriptBlock(
      draftCaptions,
      caption.id,
      selection.start,
      props.words,
      nextSplitCaptionId(caption.id, draftCaptions, splitCounterRef),
    );
    if (!result) {
      setBoundaryMessage('Place the cursor between two words to split this subtitle.');
      return;
    }
    setBoundaryMessage(undefined);
    focusCaption(result.focusedId, result.captions);
  };

  const save = async () => {
    if (saving) return;
    const empty = draftCaptions.find((caption) => !caption.text.trim());
    if (empty) {
      const index = draftCaptions.findIndex((caption) => caption.id === empty.id);
      setEmptyCaptionId(empty.id);
      setSelectedCaptionId(empty.id);
      setEditingCaptionId(empty.id);
      listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.4 });
      return;
    }
    setSaving(true);
    setSaveError(undefined);
    try {
      await props.onSave(draftCaptions);
      await clearEditorDraftJournal(props.projectId, 'caption-script');
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : 'Caption changes were not saved. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    if (saving) return;
    const close = () => {
      void clearEditorDraftJournal(props.projectId, 'caption-script').finally(props.onCancel);
    };
    if (sameCaptionDraft(draftCaptions, sourceCaptions)) {
      close();
      return;
    }
    Alert.alert('Discard unsaved caption edits?', 'The recovery copy is also removed when you discard.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: close },
    ]);
  };

  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={saving ? undefined : cancel}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1, backgroundColor: '#0D1014' }}>
        <View style={{ minHeight: 76, paddingHorizontal: 18, paddingTop: 18, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: '#252B33' }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel caption edits" disabled={saving} hitSlop={10} onPress={cancel} style={{ minWidth: 60, minHeight: 44, justifyContent: 'center' }}>
            <Text style={{ color: '#A7B0BC', fontSize: 15, fontWeight: '700' }}>Cancel</Text>
          </Pressable>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={{ color: '#F7F8FA', fontSize: 19, fontWeight: '900' }}>Edit captions</Text>
            <Text style={{ color: '#7F8996', fontSize: 11 }}>{draftCaptions.length} subtitle blocks</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Save all caption edits" disabled={saving} hitSlop={10} onPress={() => { void save(); }} style={{ minWidth: 60, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' }}>
            <Text style={{ color: '#DFFF35', fontSize: 24, fontWeight: '900', opacity: saving ? 0.45 : 1 }}>✓</Text>
          </Pressable>
        </View>

        <FlatList
          ref={listRef}
          data={draftCaptions}
          keyExtractor={(caption) => caption.id}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 14, paddingBottom: 48, gap: 8 }}
          ListHeaderComponent={(
            <View style={{ marginBottom: 6, gap: 5 }}>
              <Text style={{ color: '#8E98A5', fontSize: 12, lineHeight: 17 }}>
                Tap a subtitle to edit it. Use the visible Split and Join controls. Enter and Backspace remain available as keyboard shortcuts.
              </Text>
              {boundaryMessage ? <Text style={{ color: '#FF8FA2', fontSize: 12, fontWeight: '700' }}>{boundaryMessage}</Text> : null}
              {saveError ? <Text accessibilityRole="alert" selectable style={{ color: '#FF8FA2', fontSize: 12, fontWeight: '700' }}>{saveError}</Text> : null}
            </View>
          )}
          ListEmptyComponent={(
            <View style={{ paddingVertical: 64, alignItems: 'center', gap: 8 }}>
              <Text style={{ color: '#F7F8FA', fontSize: 17, fontWeight: '800' }}>No captions yet</Text>
              <Text style={{ color: '#8E98A5', textAlign: 'center' }}>Generate captions before opening the script editor.</Text>
            </View>
          )}
          onScrollToIndexFailed={({ index, averageItemLength }) => {
            listRef.current?.scrollToOffset({ offset: Math.max(0, index * averageItemLength), animated: false });
            setTimeout(() => listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.4 }), 80);
          }}
          renderItem={({ item, index }) => {
            const selected = item.id === selectedCaptionId;
            const editing = item.id === editingCaptionId;
            const invalid = item.id === emptyCaptionId;
            return (
              <Pressable accessibilityRole="button" accessibilityLabel={`Edit caption ${index + 1} at ${formatTimestamp(item.startMs)}`} onPress={() => selectForEditing(item)} style={{ minHeight: 72, flexDirection: 'row', gap: 12, padding: 12, borderRadius: 15, borderWidth: 1.5, borderColor: invalid ? '#FF6680' : selected ? '#DFFF35' : '#252C35', backgroundColor: selected ? '#1F281C' : '#171C22' }}>
                <View style={{ width: 54, paddingTop: 3 }}>
                  <Text style={{ color: selected ? '#DFFF35' : '#7F8996', fontSize: 11, fontWeight: '900', fontVariant: ['tabular-nums'] }}>{formatTimestamp(item.startMs)}</Text>
                  <Text style={{ marginTop: 4, color: '#5E6874', fontSize: 9, fontVariant: ['tabular-nums'] }}>{formatTimestamp(item.endMs)}</Text>
                </View>
                <View style={{ flex: 1, justifyContent: 'center' }}>
                  {editing ? (
                    <View style={{ gap: 9 }}>
                      <TextInput
                        autoFocus
                        multiline
                        maxLength={500}
                        value={item.text}
                        onChangeText={(text) => updateText(item, text)}
                        onSelectionChange={(event) => { selectionRef.current[item.id] = event.nativeEvent.selection; }}
                        onKeyPress={(event) => { if (event.nativeEvent.key === 'Backspace') mergeWithPrevious(item); }}
                        selectionColor="#DFFF35"
                        style={{ minHeight: 44, padding: 0, color: '#F7F8FA', fontSize: 16, lineHeight: 22, fontWeight: '600', textAlignVertical: 'center' }}
                      />
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
                        <ScriptAction label="Split here" onPress={() => splitAtCursor(item)} />
                        <ScriptAction label="Join previous" onPress={() => mergeWithPrevious(item, false)} />
                        <ScriptAction label="Join next" onPress={() => mergeWithNext(item)} />
                      </View>
                    </View>
                  ) : (
                    <Text style={{ color: '#F7F8FA', fontSize: 16, lineHeight: 22, fontWeight: '600' }}>{item.text}</Text>
                  )}
                  {invalid ? <Text style={{ marginTop: 4, color: '#FF8FA2', fontSize: 11 }}>A subtitle cannot be empty. Merge it or delete its timeline block.</Text> : null}
                </View>
              </Pressable>
            );
          }}
        />
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ScriptAction(props: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={4}
      onPress={props.onPress}
      style={{ minHeight: 36, justifyContent: 'center', paddingHorizontal: 11, borderRadius: 10, borderWidth: 1, borderColor: '#46515E', backgroundColor: '#222933' }}>
      <Text style={{ color: '#E9EDF2', fontSize: 12, fontWeight: '800' }}>{props.label}</Text>
    </Pressable>
  );
}

function formatTimestamp(ms: number) {
  const tenths = Math.floor(Math.max(0, ms) / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor(tenths / 10) % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths % 10}`;
}

function nextSplitCaptionId(
  parentId: string,
  captions: CaptionBlock[],
  counter: { current: number },
) {
  let candidate = '';
  do {
    candidate = `${parentId}-split-${counter.current++}`;
  } while (captions.some((caption) => caption.id === candidate));
  return candidate;
}

function decodeCaptionDraft(value: unknown): CaptionBlock[] | null {
  if (!Array.isArray(value) || value.length > 20_000) return null;
  const valid = value.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const caption = entry as Partial<CaptionBlock>;
    return typeof caption.id === 'string'
      && typeof caption.text === 'string'
      && Number.isFinite(caption.startMs)
      && Number.isFinite(caption.endMs)
      && (caption.endMs ?? 0) > (caption.startMs ?? 0);
  });
  return valid ? value as CaptionBlock[] : null;
}

function sameCaptionDraft(left: CaptionBlock[], right: CaptionBlock[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}
