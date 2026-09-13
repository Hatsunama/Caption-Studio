import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  type CellRendererProps,
  type LayoutRectangle,
} from 'react-native';

import {
  mergeCaptionScriptBlock,
  splitCaptionScriptBlock,
  updateCaptionScriptInput,
} from '@/lib/caption-script';
import {
  clearEditorDraftJournal,
  readEditorDraftJournal,
  writeEditorDraftJournal,
} from '@/services/editor-draft-journal';
import { chrome } from '@/lib/ui-theme';
import type { CaptionBlock, WordToken } from '@/types/project';

const CaptionCellLayoutContext = createContext<(id: string, index: number, layout: LayoutRectangle) => void>(() => {});

// The cell, unlike renderItem's child, is positioned in list-content coordinates.
function CaptionCell({ item, index, onLayout, onFocusCapture, style, children }: CellRendererProps<CaptionBlock>) {
  const reportLayout = useContext(CaptionCellLayoutContext);
  return (
    <View {...{ onFocusCapture }} style={style} onLayout={(event) => {
      onLayout?.(event);
      reportLayout(item.id, index, event.nativeEvent.layout);
    }}>
      {children}
    </View>
  );
}

export function ScriptEditor(props: {
  visible: boolean;
  projectId: string;
  baseRevision: string;
  captions: CaptionBlock[];
  words: WordToken[];
  initialCaptionId?: string;
  onSelectCaption: (caption: CaptionBlock) => void;
  currentMs: number;
  isPlaying: boolean;
  onSeekTimeline: (timelineMs: number) => void;
  onCancel: () => void;
  onSave: (captions: CaptionBlock[]) => Promise<void>;
}) {
  const { onSeekTimeline } = props;
  const listRef = useRef<FlatList<CaptionBlock>>(null);
  const sheetRef = useRef<View>(null);
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
  const [journalError, setJournalError] = useState<string>();
  const wasVisibleRef = useRef(false);
  const captionLayoutsRef = useRef<Record<string, { y: number; height: number; index: number }>>({});
  const listViewportHeightRef = useRef(0);
  const listOffsetRef = useRef(0);
  const userScrollingRef = useRef(false);
  const pendingScrollSeekRef = useRef(false);
  const scrollEndTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastScrollSeekIdRef = useRef<string | undefined>(undefined);
  const lastTimelineCaptionIdRef = useRef<string | undefined>(undefined);
  const navigationRef = useRef<{ id: string; attempts: number } | undefined>(undefined);
  const navigationTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sessionRef = useRef<{ visible: boolean; captions: CaptionBlock[] }>({ visible: false, captions: [] });
  const [listViewportHeight, setListViewportHeight] = useState(0);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [keyboardVerticalOffset, setKeyboardVerticalOffset] = useState(0);

  useEffect(() => {
    if (!props.visible) return;
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboardOpen(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboardOpen(false));
    return () => { show.remove(); hide.remove(); };
  }, [props.visible]);

  useEffect(() => {
    sessionRef.current = { visible: props.visible, captions: draftCaptions };
  }, [draftCaptions, props.visible]);

  const cancelNavigation = useCallback(() => {
    clearTimeout(navigationTimerRef.current);
    navigationTimerRef.current = undefined;
    navigationRef.current = undefined;
  }, []);

  const revealCaption = useCallback((id: string, center = false, attempts = 0) => {
    const session = sessionRef.current;
    if (!session.visible || userScrollingRef.current || listViewportHeightRef.current <= 0) return;
    pendingScrollSeekRef.current = false;
    const index = session.captions.findIndex((caption) => caption.id === id);
    if (index < 0) return;
    const layout = captionLayoutsRef.current[id];
    const viewport = listViewportHeightRef.current;
    if (!center && layout?.index === index && layout.y >= listOffsetRef.current + 8
      && layout.y + layout.height <= listOffsetRef.current + viewport - 8) return;
    cancelNavigation();
    navigationRef.current = { id, attempts };
    const tall = layout?.index === index && layout.height > viewport - 16;
    listRef.current?.scrollToIndex({ index, animated: false, viewPosition: tall ? 0 : 0.5, viewOffset: tall ? 8 : 0 });
  }, [cancelNavigation]);

  useEffect(() => {
    if (props.visible) return;
    userScrollingRef.current = false;
    pendingScrollSeekRef.current = false;
    clearTimeout(scrollEndTimerRef.current);
    cancelNavigation();
    captionLayoutsRef.current = {};
    listViewportHeightRef.current = 0;
    listOffsetRef.current = 0;
    lastScrollSeekIdRef.current = undefined;
    lastTimelineCaptionIdRef.current = undefined;
  }, [cancelNavigation, props.visible]);

  useEffect(() => () => {
    clearTimeout(scrollEndTimerRef.current);
    cancelNavigation();
  }, [cancelNavigation]);

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
    setKeyboardOpen(Keyboard.isVisible());
    setJournalReady(false);
    setJournalError(undefined);
    selectionRef.current = {};
    splitCounterRef.current = 0;
    let active = true;
    void readEditorDraftJournal(props.projectId, 'caption-script').then((journal) => {
      if (!active) return;
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
    }).catch(() => {
      if (active) {
        setJournalError('Caption recovery storage could not be read. Save your changes before leaving this editor.');
        setJournalReady(true);
      }
    });
    return () => {
      active = false;
    };
  }, [initialIndex, props.baseRevision, props.projectId, props.visible, sourceCaptions]);

  useEffect(() => {
    if (!props.visible || !journalReady || sameCaptionDraft(draftCaptions, sourceCaptions)) return;
    let active = true;
    const timer = setTimeout(() => {
      void writeEditorDraftJournal(props.projectId, 'caption-script', props.baseRevision, draftCaptions)
        .then(() => { if (active) setJournalError(undefined); })
        .catch(() => { if (active) setJournalError('Caption recovery could not be saved. Keep this editor open until you save.'); });
    }, 600);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [draftCaptions, journalReady, props.baseRevision, props.projectId, props.visible, sourceCaptions]);

  useEffect(() => {
    if (!props.visible) return;
    const active = draftCaptions.find((caption) => props.currentMs >= caption.startMs && props.currentMs < caption.endMs);
    const changed = lastTimelineCaptionIdRef.current !== active?.id;
    lastTimelineCaptionIdRef.current = active?.id;
    // A transport tick must never take the input (or a drag) off screen.
    if (editingCaptionId || userScrollingRef.current || !props.isPlaying || !active || !changed) return;
    setSelectedCaptionId(active.id);
    revealCaption(active.id, true);
  }, [draftCaptions, editingCaptionId, props.currentMs, props.isPlaying, props.visible, revealCaption]);

  useEffect(() => {
    const id = editingCaptionId ?? selectedCaptionId;
    if (id) revealCaption(id);
  }, [draftCaptions, editingCaptionId, selectedCaptionId, listViewportHeight, props.visible, revealCaption]);

  const seekToCenteredCaption = useCallback((offsetY: number) => {
    listOffsetRef.current = offsetY;
    if ((!userScrollingRef.current && !pendingScrollSeekRef.current) || listViewportHeightRef.current <= 0) return;
    const centerY = offsetY + listViewportHeightRef.current / 2;
    const nearest = draftCaptions.reduce<CaptionBlock | undefined>((closest, caption, index) => {
      const layout = captionLayoutsRef.current[caption.id];
      if (!layout || layout.index !== index) return closest;
      // A fast fling can outrun virtualization. Wait for the cell at the guide
      // instead of seeking to a distant, previously measured row.
      const atGuide = Math.abs(layout.y + layout.height / 2 - centerY) <= layout.height / 2 + 8;
      const atEdge = (index === 0 && centerY < layout.y)
        || (index === draftCaptions.length - 1 && centerY > layout.y + layout.height);
      if (!atGuide && !atEdge) return closest;
      if (!closest) return caption;
      const closestLayout = captionLayoutsRef.current[closest.id];
      return Math.abs(layout.y + layout.height / 2 - centerY) < Math.abs(closestLayout.y + closestLayout.height / 2 - centerY)
        ? caption : closest;
    }, undefined);
    pendingScrollSeekRef.current = !nearest;
    if (!nearest || lastScrollSeekIdRef.current === nearest.id) return;
    lastScrollSeekIdRef.current = nearest.id;
    setSelectedCaptionId(nearest.id);
    onSeekTimeline(nearest.startMs);
  }, [draftCaptions, onSeekTimeline]);

  const reportCellLayout = useCallback((id: string, index: number, layout: LayoutRectangle) => {
    captionLayoutsRef.current[id] = { ...layout, index };
    if (userScrollingRef.current || pendingScrollSeekRef.current) {
      seekToCenteredCaption(listOffsetRef.current);
      return;
    }
    if (id === (editingCaptionId ?? selectedCaptionId)) revealCaption(id);
  }, [editingCaptionId, selectedCaptionId, revealCaption, seekToCenteredCaption]);

  const selectForEditing = (caption: CaptionBlock) => {
    selectionRef.current[caption.id] ??= { start: caption.text.length, end: caption.text.length };
    setSelectedCaptionId(caption.id);
    setEditingCaptionId(caption.id);
    setEmptyCaptionId(undefined);
    setBoundaryMessage(undefined);
    props.onSelectCaption(caption);
    props.onSeekTimeline(caption.startMs);
  };

  const focusCaption = (captionId: string, captions: CaptionBlock[]) => {
    setDraftCaptions(captions);
    setSelectedCaptionId(captionId);
    setEditingCaptionId(captionId);
    setEmptyCaptionId(undefined);
  };

  const updateText = (caption: CaptionBlock, text: string) => {
    const result = updateCaptionScriptInput(
      draftCaptions,
      caption.id,
      text,
      props.words,
      (captions) => nextSplitCaptionId(caption.id, captions, splitCounterRef),
    );
    setBoundaryMessage(undefined);
    if (result.focusedId !== caption.id) {
      focusCaption(result.focusedId, result.captions);
    } else {
      setDraftCaptions(result.captions);
    }
    if (text.trim()) setEmptyCaptionId(undefined);
  };

  const mergeWithPrevious = (caption: CaptionBlock, requireCursorAtStart = true) => {
    const selection = selectionRef.current[caption.id];
    if (requireCursorAtStart && (!selection || selection.start !== 0 || selection.end !== 0)) return;
    const result = mergeCaptionScriptBlock(draftCaptions, caption.id);
    if (!result) return;
    setBoundaryMessage(undefined);
    focusCaption(result.focusedId, result.captions);
  };

  const mergeWithNext = (caption: CaptionBlock) => {
    const result = mergeCaptionScriptBlock(draftCaptions, caption.id, 'next');
    if (!result) {
      setBoundaryMessage('There is no subtitle below this one to join.');
      return;
    }
    setBoundaryMessage(undefined);
    focusCaption(result.focusedId, result.captions);
  };

  const splitAtCursor = (caption: CaptionBlock) => {
    const selection = selectionRef.current[caption.id];
    if (!selection || selection.start !== selection.end) {
      setBoundaryMessage('Place the cursor where you want to split, then choose Split here.');
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
      setBoundaryMessage('Splitting needs text on both sides and at least 0.16 seconds.');
      return;
    }
    setBoundaryMessage(undefined);
    focusCaption(result.focusedId, result.captions);
  };

  const save = async () => {
    if (saving) return;
    const empty = draftCaptions.find((caption) => !caption.text.trim());
    if (empty) {
      setEmptyCaptionId(empty.id);
      setSelectedCaptionId(empty.id);
      setEditingCaptionId(empty.id);
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

  if (!props.visible) return null;

  const finishUserScroll = () => {
    clearTimeout(scrollEndTimerRef.current);
    userScrollingRef.current = false;
  };

  return (
      <View
        ref={sheetRef}
        testID="caption-script-sheet"
        onLayout={() => {
          // Keyboard coordinates are screen-relative; the nested avoiding view's
          // layout is local to this sheet below the preview/navigation header.
          sheetRef.current?.measureInWindow((_x, y) => setKeyboardVerticalOffset(y));
        }}
        style={{
          // Reserve space below the preview. A half-height absolute overlay can
          // cover its fixed minimum height when Android resizes for the keyboard.
          height: '50%',
          flexShrink: 1,
          minHeight: 0,
          zIndex: 100,
          backgroundColor: chrome.background,
          borderTopWidth: 1,
          borderTopColor: chrome.hairline,
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          overflow: 'hidden',
        }}>
      <KeyboardAvoidingView
        // Android already resizes the window. Its 'height' behavior reuses the
        // pre-keyboard height instead of respecting the remaining flex space.
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={keyboardVerticalOffset}
        style={{ flex: 1, minHeight: 0 }}>
        <View style={{ minHeight: keyboardOpen ? 44 : 76, paddingHorizontal: 18, paddingTop: keyboardOpen ? 0 : 18, paddingBottom: keyboardOpen ? 0 : 12, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: chrome.hairline }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel caption edits" disabled={saving} hitSlop={10} onPress={cancel} style={{ minWidth: 60, minHeight: 44, justifyContent: 'center' }}>
            <Text style={{ color: chrome.muted, fontSize: 17, fontWeight: '600' }}>Cancel</Text>
          </Pressable>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={{ color: chrome.text, fontSize: 17, fontWeight: '700' }}>Edit captions</Text>
            <Text style={{ color: chrome.muted, fontSize: 12 }}>{draftCaptions.length} subtitle blocks</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Save all caption edits" disabled={saving} hitSlop={10} onPress={() => { void save(); }} style={{ minWidth: 60, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' }}>
            <Text style={{ color: chrome.accent, fontSize: 17, fontWeight: '700', opacity: saving ? 0.45 : 1 }}>Done</Text>
          </Pressable>
        </View>

        <View style={{ flex: 1, minHeight: 0 }}>
          <CaptionCellLayoutContext.Provider value={reportCellLayout}>
          <FlatList
            ref={listRef}
            data={draftCaptions}
            keyExtractor={(caption) => caption.id}
            CellRendererComponent={CaptionCell}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            onLayout={(event) => {
              listViewportHeightRef.current = event.nativeEvent.layout.height;
              setListViewportHeight(event.nativeEvent.layout.height);
              const id = editingCaptionId ?? selectedCaptionId;
              if (id) revealCaption(id);
            }}
            onScrollBeginDrag={() => {
              clearTimeout(scrollEndTimerRef.current);
              cancelNavigation();
              userScrollingRef.current = true;
              lastScrollSeekIdRef.current = undefined;
              setEditingCaptionId(undefined);
            }}
            onScroll={(event) => {
              listOffsetRef.current = event.nativeEvent.contentOffset.y;
              seekToCenteredCaption(event.nativeEvent.contentOffset.y);
            }}
            onScrollEndDrag={(event) => {
              seekToCenteredCaption(event.nativeEvent.contentOffset.y);
              // Momentum begins after end-drag. Only this gesture owns the gap;
              // playback rerenders cannot cancel its release.
              clearTimeout(scrollEndTimerRef.current);
              scrollEndTimerRef.current = setTimeout(finishUserScroll, 100);
            }}
            onMomentumScrollBegin={() => { clearTimeout(scrollEndTimerRef.current); }}
            onMomentumScrollEnd={(event) => {
              seekToCenteredCaption(event.nativeEvent.contentOffset.y);
              finishUserScroll();
            }}
            scrollEventThrottle={32}
            contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 14, paddingBottom: 48, gap: 8 }}
          ListHeaderComponent={(
            <View style={{ marginBottom: 6, gap: 5 }}>
              {!keyboardOpen ? <Text style={{ color: chrome.muted, fontSize: 13, lineHeight: 18 }}>
                Keep the video visible while you edit. Scroll this list to seek the video; while it plays, the active subtitle stays at the center guide. Tap a subtitle to edit it.
              </Text> : null}
              {boundaryMessage ? <Text style={{ color: '#FF8FA2', fontSize: 12, fontWeight: '700' }}>{boundaryMessage}</Text> : null}
              {journalError ? <Text accessibilityRole="alert" selectable style={{ color: '#FF8FA2', fontSize: 12, fontWeight: '700' }}>{journalError}</Text> : null}
              {saveError ? <Text accessibilityRole="alert" selectable style={{ color: '#FF8FA2', fontSize: 12, fontWeight: '700' }}>{saveError}</Text> : null}
            </View>
          )}
          ListEmptyComponent={(
            <View style={{ paddingVertical: 64, alignItems: 'center', gap: 8 }}>
              <Text style={{ color: chrome.text, fontSize: 17, fontWeight: '700' }}>No captions yet</Text>
              <Text style={{ color: chrome.muted, textAlign: 'center' }}>Generate captions before opening the script editor.</Text>
            </View>
          )}
          onScrollToIndexFailed={({ index, averageItemLength }) => {
            const pending = navigationRef.current;
            if (!pending || userScrollingRef.current || !props.visible
              || draftCaptions[index]?.id !== pending.id || pending.attempts >= 3) return;
            listRef.current?.scrollToOffset({ offset: Math.max(0, index * averageItemLength), animated: false });
            clearTimeout(navigationTimerRef.current);
            navigationTimerRef.current = setTimeout(() => revealCaption(pending.id, true, pending.attempts + 1), 80);
          }}
          renderItem={({ item, index }) => {
            const selected = item.id === selectedCaptionId;
            const editing = item.id === editingCaptionId;
            const invalid = item.id === emptyCaptionId;
            return (
              <Pressable accessibilityRole="button" accessibilityLabel={`Edit caption ${index + 1} at ${formatTimestamp(item.startMs)}`} onPress={() => selectForEditing(item)} style={{ minHeight: 72, flexDirection: 'row', gap: 12, padding: 14, borderRadius: chrome.radius.lg, backgroundColor: selected ? chrome.surfaceRaised : chrome.surface }}>
                <View style={{ width: 54, paddingTop: 3 }}>
                  <Text style={{ color: selected ? chrome.accent : chrome.muted, fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{formatTimestamp(item.startMs)}</Text>
                  <Text style={{ marginTop: 4, color: '#5E6874', fontSize: 9, fontVariant: ['tabular-nums'] }}>{formatTimestamp(item.endMs)}</Text>
                </View>
                <View style={{ flex: 1, justifyContent: 'center' }}>
                  {editing ? (
                    <View style={{ gap: 9 }}>
                      <TextInput
                        autoFocus
                        multiline
                        scrollEnabled
                        maxLength={500}
                        value={item.text}
                        onChangeText={(text) => updateText(item, text)}
                        onFocus={() => revealCaption(item.id)}
                        onContentSizeChange={() => revealCaption(item.id)}
                        onSelectionChange={(event) => { selectionRef.current[item.id] = event.nativeEvent.selection; }}
                        onKeyPress={(event) => { if (event.nativeEvent.key === 'Backspace') mergeWithPrevious(item); }}
                        selectionColor={chrome.accent}
                        style={{ minHeight: Math.min(44, Math.max(24, listViewportHeight / 2)), maxHeight: Math.max(24, listViewportHeight / 2), padding: 0, color: chrome.text, fontSize: 17, lineHeight: 23, fontWeight: '400', textAlignVertical: 'top' }}
                      />
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
                        <ScriptAction label="Split here" onPress={() => splitAtCursor(item)} />
                        <ScriptAction label="Join previous" onPress={() => mergeWithPrevious(item, false)} />
                        <ScriptAction label="Join next" onPress={() => mergeWithNext(item)} />
                      </View>
                    </View>
                  ) : (
                    <Text style={{ color: chrome.text, fontSize: 17, lineHeight: 23, fontWeight: '400' }}>{item.text}</Text>
                  )}
                  {invalid ? <Text style={{ marginTop: 4, color: '#FF8FA2', fontSize: 11 }}>A subtitle cannot be empty. Merge it or delete its timeline block.</Text> : null}
                </View>
              </Pressable>
            );
          }}
          />
          </CaptionCellLayoutContext.Provider>
          <View pointerEvents="none" style={{ position: 'absolute', left: 8, right: 8, top: '50%', height: 2, borderRadius: 1, backgroundColor: '#B7FF4A', shadowColor: '#B7FF4A', shadowOpacity: 0.95, shadowRadius: 5, elevation: 5 }} />
        </View>
      </KeyboardAvoidingView>
      </View>
  );
}

function ScriptAction(props: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={4}
      onPress={props.onPress}
      style={{ minHeight: 36, justifyContent: 'center', paddingHorizontal: 12, borderRadius: chrome.radius.pill, backgroundColor: chrome.fill }}>
      <Text style={{ color: chrome.text, fontSize: 13, fontWeight: '600' }}>{props.label}</Text>
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
