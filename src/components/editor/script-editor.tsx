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
  updateCaptionScriptText,
} from '@/lib/caption-script';
import {
  clearEditorDraftJournal,
  readEditorDraftJournal,
  writeEditorDraftJournal,
} from '@/services/editor-draft-journal';
import { chrome } from '@/lib/ui-theme';
import type { CaptionBlock, WordToken } from '@/types/project';

const CaptionCellLayoutContext = createContext<(id: string, index: number, layout: LayoutRectangle) => void>(() => {});
const SCRIPT_ANCHOR = 8;
const SCRIPT_LEADING_SPACE = 96;
const SCRIPT_ROW_GAP = 8;
const ignoreBackRequestChange = () => undefined;

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
  onDraftChange: (captions: CaptionBlock[] | null) => void;
  onKeyboardChange: (open: boolean) => void;
  onEditingCaptionChange: (id: string | undefined) => void;
  currentMs: number;
  isPlaying: boolean;
  onSeekTimeline: (timelineMs: number) => void;
  onBackRequestChange?: (request: (() => void) | undefined) => void;
  onCancel: () => void;
  onSave: (captions: CaptionBlock[]) => Promise<boolean>;
}) {
  const {
    onBackRequestChange = ignoreBackRequestChange,
    onCancel,
    onDraftChange,
    onEditingCaptionChange,
    onKeyboardChange,
    onSeekTimeline,
    onSelectCaption,
    projectId,
  } = props;
  const listRef = useRef<FlatList<CaptionBlock>>(null);
  const inputRefs = useRef<Record<string, TextInput | null>>({});
  const sheetRef = useRef<View>(null);
  const selectionRef = useRef<Record<string, { start: number; end: number }>>({});
  const splitCounterRef = useRef(0);
  const [draftCaptions, setDraftCaptions] = useState<CaptionBlock[]>([]);
  const [inputHeights, setInputHeights] = useState<Record<string, number>>({});
  const [editingCaptionId, setEditingCaptionId] = useState<string>();
  const [selectedCaptionId, setSelectedCaptionId] = useState<string>();
  const [emptyCaptionId, setEmptyCaptionId] = useState<string>();
  const [boundaryMessage, setBoundaryMessage] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const [journalReady, setJournalReady] = useState(false);
  const [journalError, setJournalError] = useState<string>();
  const wasVisibleRef = useRef(false);
  const draftVersionRef = useRef(0);
  const captionLayoutsRef = useRef<Record<string, { y: number; height: number; index: number }>>({});
  const listViewportHeightRef = useRef(0);
  const listOffsetRef = useRef(0);
  const leadingSpaceRef = useRef(SCRIPT_LEADING_SPACE);
  const userScrollingRef = useRef(false);
  // Ownership survives gesture completion: delayed layouts must not undo a
  // user's scroll. Only an explicit selection or playback follow takes it back.
  const scrollOwnerRef = useRef<'user' | 'programmatic'>('programmatic');
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
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => {
      setKeyboardOpen(false);
      setEditingCaptionId(undefined);
    });
    return () => { show.remove(); hide.remove(); };
  }, [props.visible]);

  useEffect(() => {
    sessionRef.current = { visible: props.visible, captions: draftCaptions };
  }, [draftCaptions, props.visible]);

  // Preview is transient state, separate from the project and recovery journal.
  // Publish every mutation (including recovery, splits and joins) without debounce.
  useEffect(() => {
    // Opening initializes below. Do not publish an empty or previous session's
    // state before that initialization has committed.
    if (props.visible && wasVisibleRef.current) onDraftChange(draftCaptions);
  }, [draftCaptions, onDraftChange, props.visible]);

  useEffect(() => {
    onKeyboardChange(props.visible && keyboardOpen);
  }, [keyboardOpen, onKeyboardChange, props.visible]);

  useEffect(() => {
    onEditingCaptionChange(props.visible ? editingCaptionId : undefined);
  }, [editingCaptionId, onEditingCaptionChange, props.visible]);

  useEffect(() => () => {
    onDraftChange(null);
    onKeyboardChange(false);
    onEditingCaptionChange(undefined);
  }, [onDraftChange, onKeyboardChange, onEditingCaptionChange, props.visible]);

  useEffect(() => {
    if (editingCaptionId) inputRefs.current[editingCaptionId]?.focus();
  }, [editingCaptionId]);

  const cancelNavigation = useCallback(() => {
    clearTimeout(navigationTimerRef.current);
    navigationTimerRef.current = undefined;
    navigationRef.current = undefined;
  }, []);

  const revealCaption = useCallback((id: string, attempts = 0) => {
    const session = sessionRef.current;
    if (!session.visible || scrollOwnerRef.current === 'user' || userScrollingRef.current || listViewportHeightRef.current <= 0) return;
    pendingScrollSeekRef.current = false;
    const index = session.captions.findIndex((caption) => caption.id === id);
    if (index < 0) return;
    const layout = captionLayoutsRef.current[id];
    const targetOffset = layout?.index === index
      ? Math.max(0, layout.y - SCRIPT_ANCHOR)
      : undefined;
    if (targetOffset !== undefined && Math.abs(targetOffset - listOffsetRef.current) <= 1) return;
    cancelNavigation();
    navigationRef.current = { id, attempts };
    listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0, viewOffset: SCRIPT_ANCHOR });
  }, [cancelNavigation]);

  useEffect(() => {
    if (props.visible) return;
    userScrollingRef.current = false;
    scrollOwnerRef.current = 'programmatic';
    pendingScrollSeekRef.current = false;
    clearTimeout(scrollEndTimerRef.current);
    cancelNavigation();
    captionLayoutsRef.current = {};
    listViewportHeightRef.current = 0;
    listOffsetRef.current = 0;
    leadingSpaceRef.current = SCRIPT_LEADING_SPACE;
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

  // Only opening/closing owns recovery's lifetime. A style or project revision
  // update while storage is loading must not cancel that read or reset the draft.
  const openingStateRef = useRef({ sourceCaptions, initialIndex, onDraftChange, baseRevision: props.baseRevision });
  useEffect(() => {
    openingStateRef.current = { sourceCaptions, initialIndex, onDraftChange, baseRevision: props.baseRevision };
  }, [sourceCaptions, initialIndex, onDraftChange, props.baseRevision]);

  useEffect(() => {
    const opening = props.visible && !wasVisibleRef.current;
    wasVisibleRef.current = props.visible;
    if (!opening) return;
    const { sourceCaptions, initialIndex, onDraftChange } = openingStateRef.current;
    setDraftCaptions(sourceCaptions);
    draftVersionRef.current = 0;
    setInputHeights({});
    onDraftChange(sourceCaptions);
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
    void readEditorDraftJournal(projectId, 'caption-script').then((journal) => {
      if (!active) return;
      const recovered = decodeCaptionDraft(journal?.payload);
      if (!recovered) {
        setJournalReady(true);
        return;
      }
      const conflict = journal?.baseRevision !== openingStateRef.current.baseRevision;
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
              if (!active) return;
              void clearEditorDraftJournal(projectId, 'caption-script');
              setJournalReady(true);
            },
          },
          { text: 'Restore', onPress: () => {
            if (!active) return;
            draftVersionRef.current += 1;
            setDraftCaptions(recovered);
            setJournalReady(true);
          } },
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
  }, [projectId, props.visible]);

  useEffect(() => {
    if (!props.visible || closing || !journalReady || sameCaptionDraft(draftCaptions, sourceCaptions)) return;
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
  }, [closing, draftCaptions, journalReady, props.baseRevision, props.projectId, props.visible, sourceCaptions]);

  useEffect(() => {
    if (!props.visible) return;
    const active = draftCaptions.find((caption) => props.currentMs >= caption.startMs && props.currentMs < caption.endMs);
    const changed = lastTimelineCaptionIdRef.current !== active?.id;
    lastTimelineCaptionIdRef.current = active?.id;
    // A transport tick must never take the input (or a drag) off screen.
    if (editingCaptionId || userScrollingRef.current || pendingScrollSeekRef.current || !props.isPlaying || !active || !changed) return;
    scrollOwnerRef.current = 'programmatic';
    setSelectedCaptionId(active.id);
    revealCaption(active.id);
  }, [draftCaptions, editingCaptionId, props.currentMs, props.isPlaying, props.visible, revealCaption]);

  useEffect(() => {
    const id = editingCaptionId ?? selectedCaptionId;
    if (id) revealCaption(id);
  }, [draftCaptions, editingCaptionId, selectedCaptionId, keyboardOpen, listViewportHeight, props.isPlaying, props.visible, revealCaption]);

  const seekToAnchoredCaption = useCallback((offsetY: number) => {
    listOffsetRef.current = offsetY;
    if ((!userScrollingRef.current && !pendingScrollSeekRef.current) || listViewportHeightRef.current <= 0) return;
    const anchorY = offsetY + SCRIPT_ANCHOR;
    const firstLayout = captionLayoutsRef.current[draftCaptions[0]?.id];
    const firstY = firstLayout?.index === 0 ? firstLayout.y : leadingSpaceRef.current;
    // Blank leading space belongs to the first actual cue, even before its
    // virtualized cell is measured. All other rows use the same top anchor.
    const nearest = offsetY <= 0 || anchorY <= firstY ? draftCaptions[0] : draftCaptions.reduce<CaptionBlock | undefined>((closest, caption, index) => {
      const layout = captionLayoutsRef.current[caption.id];
      if (!layout || layout.index !== index) return closest;
      // A fast fling can outrun virtualization. Wait for the cell at the guide
      // instead of seeking to a distant, previously measured row.
      const atGuide = anchorY >= layout.y - 1 && anchorY < layout.y + layout.height + SCRIPT_ROW_GAP;
      const atEdge = index === draftCaptions.length - 1 && anchorY >= layout.y;
      if (!atGuide && !atEdge) return closest;
      return caption;
    }, undefined);
    pendingScrollSeekRef.current = !nearest;
    if (!nearest || lastScrollSeekIdRef.current === nearest.id) return;
    lastScrollSeekIdRef.current = nearest.id;
    setSelectedCaptionId(nearest.id);
    // Paused preview rendering prefers the parent's selected caption. Publish
    // that selection with the seek, only while this gesture owns navigation.
    onSelectCaption(nearest);
    onSeekTimeline(nearest.startMs);
  }, [draftCaptions, onSeekTimeline, onSelectCaption]);

  const reportCellLayout = useCallback((id: string, index: number, layout: LayoutRectangle) => {
    captionLayoutsRef.current[id] = { ...layout, index };
    if (userScrollingRef.current || pendingScrollSeekRef.current) {
      // Layout changes alone do not own a seek. Only resolve a gesture that
      // explicitly waited for an unmeasured row at its current anchor.
      if (pendingScrollSeekRef.current) seekToAnchoredCaption(listOffsetRef.current);
      return;
    }
    if (id === (editingCaptionId ?? selectedCaptionId)) revealCaption(id);
  }, [editingCaptionId, selectedCaptionId, revealCaption, seekToAnchoredCaption]);

  const selectForEditing = (caption: CaptionBlock) => {
    clearTimeout(scrollEndTimerRef.current);
    userScrollingRef.current = false;
    scrollOwnerRef.current = 'programmatic';
    pendingScrollSeekRef.current = false;
    cancelNavigation();
    selectionRef.current[caption.id] ??= { start: caption.text.length, end: caption.text.length };
    setSelectedCaptionId(caption.id);
    setEditingCaptionId(caption.id);
    onEditingCaptionChange(caption.id);
    setEmptyCaptionId(undefined);
    setBoundaryMessage(undefined);
    props.onSelectCaption(caption);
    props.onSeekTimeline(caption.startMs);
    inputRefs.current[caption.id]?.focus();
    revealCaption(caption.id);
  };

  const focusCaption = (captionId: string, captions: CaptionBlock[]) => {
    clearTimeout(scrollEndTimerRef.current);
    userScrollingRef.current = false;
    scrollOwnerRef.current = 'programmatic';
    pendingScrollSeekRef.current = false;
    cancelNavigation();
    draftVersionRef.current += 1;
    setDraftCaptions(captions);
    setSelectedCaptionId(captionId);
    setEditingCaptionId(captionId);
    onEditingCaptionChange(captionId);
    setEmptyCaptionId(undefined);
    const caption = captions.find((candidate) => candidate.id === captionId);
    if (caption) {
      onSelectCaption(caption);
      onSeekTimeline(caption.startMs);
    }
  };

  const updateText = (caption: CaptionBlock, text: string) => {
    // Wrapping and literal newlines are text edits. Only the explicit split/join
    // actions below may change cue boundaries or move text to another caption.
    draftVersionRef.current += 1;
    setDraftCaptions(updateCaptionScriptText(draftCaptions, caption.id, text));
    setBoundaryMessage(undefined);
    if (text.trim()) setEmptyCaptionId(undefined);
  };

  const mergeWithPrevious = (caption: CaptionBlock) => {
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
    if (saving || closing) return;
    const empty = draftCaptions.find((caption) => !caption.text.trim());
    if (empty) {
      focusCaption(empty.id, draftCaptions);
      setEmptyCaptionId(empty.id);
      return;
    }
    setSaving(true);
    setSaveError(undefined);
    const savingVersion = draftVersionRef.current;
    const savingDraft = draftCaptions;
    try {
      if (!await props.onSave(savingDraft)) {
        setSaveError('Caption edits were not saved. Review the draft and try again.');
        return;
      }
      if (draftVersionRef.current !== savingVersion) {
        setSaveError('Captions changed while saving. Review the latest text, then tap Done again.');
        return;
      }
      await clearEditorDraftJournal(props.projectId, 'caption-script');
      props.onCancel();
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : 'Caption changes were not saved. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const cancel = useCallback(() => {
    if (saving || closing) return;
    const close = async () => {
      setClosing(true);
      setSaveError(undefined);
      try {
        await clearEditorDraftJournal(projectId, 'caption-script');
        onCancel();
      } catch (caught) {
        setJournalError(caught instanceof Error ? caught.message : 'Caption recovery could not be cleared. Your edits are still open.');
      } finally {
        setClosing(false);
      }
    };
    if (sameCaptionDraft(draftCaptions, sourceCaptions)) {
      void close();
      return;
    }
    Alert.alert('Discard unsaved caption edits?', 'The recovery copy is also removed when you discard.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => { void close(); } },
    ]);
  }, [closing, draftCaptions, onCancel, projectId, saving, sourceCaptions]);

  useEffect(() => {
    if (!props.visible) {
      onBackRequestChange(undefined);
      return;
    }
    onBackRequestChange(cancel);
    return () => onBackRequestChange(undefined);
  }, [cancel, onBackRequestChange, props.visible]);

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
          // The workspace reserves the preview above us. Fill its remaining
          // space, including when Android resizes the root for the keyboard.
          flex: 1,
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
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel caption edits" disabled={saving || closing} hitSlop={10} onPress={cancel} style={{ minWidth: 60, minHeight: 44, justifyContent: 'center' }}>
            <Text style={{ color: chrome.muted, fontSize: 17, fontWeight: '600' }}>Cancel</Text>
          </Pressable>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={{ color: chrome.text, fontSize: 17, fontWeight: '700' }}>Edit captions</Text>
            <Text style={{ color: chrome.muted, fontSize: 12 }}>{draftCaptions.length} subtitle blocks</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Save all caption edits" disabled={saving || closing} hitSlop={10} onPress={() => { void save(); }} style={{ minWidth: 60, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' }}>
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
            keyboardDismissMode="none"
            keyboardShouldPersistTaps="always"
            // Focus capture retains the active cell in VirtualizedList's render
            // mask; disabling native clipping also keeps its Android input attached.
            removeClippedSubviews={false}
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
              scrollOwnerRef.current = 'user';
              onEditingCaptionChange(undefined);
              pendingScrollSeekRef.current = false;
              lastScrollSeekIdRef.current = undefined;
            }}
            onScroll={(event) => {
              listOffsetRef.current = event.nativeEvent.contentOffset.y;
              seekToAnchoredCaption(event.nativeEvent.contentOffset.y);
            }}
            onScrollEndDrag={(event) => {
              seekToAnchoredCaption(event.nativeEvent.contentOffset.y);
              // Momentum begins after end-drag. Only this gesture owns the gap;
              // playback rerenders cannot cancel its release.
              clearTimeout(scrollEndTimerRef.current);
              scrollEndTimerRef.current = setTimeout(finishUserScroll, 100);
            }}
            onMomentumScrollBegin={() => { clearTimeout(scrollEndTimerRef.current); }}
            onMomentumScrollEnd={(event) => {
              seekToAnchoredCaption(event.nativeEvent.contentOffset.y);
              finishUserScroll();
            }}
            scrollEventThrottle={32}
            contentContainerStyle={{ paddingHorizontal: 14 }}
            ItemSeparatorComponent={() => <View style={{ height: SCRIPT_ROW_GAP }} />}
            ListFooterComponent={<View testID="script-trailing-space" style={{ height: Math.max(48, listViewportHeight - SCRIPT_ANCHOR) }} />}
          ListHeaderComponent={(
            <View testID="script-leading-space" onLayout={(event) => { leadingSpaceRef.current = event.nativeEvent.layout.height; }} style={{ minHeight: SCRIPT_LEADING_SPACE, paddingTop: 14, paddingBottom: 8, gap: 5 }}>
              {!keyboardOpen ? <Text style={{ color: chrome.muted, fontSize: 13, lineHeight: 18 }}>
                Scroll this list to seek the video. The subtitle at the top guide is selected; playback follows the same guide. Tap a subtitle to edit it.
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
            if (!pending || scrollOwnerRef.current === 'user' || userScrollingRef.current || !props.visible
              || draftCaptions[index]?.id !== pending.id || pending.attempts >= 3) return;
            listRef.current?.scrollToOffset({ offset: Math.max(0, leadingSpaceRef.current + index * averageItemLength - SCRIPT_ANCHOR), animated: false });
            clearTimeout(navigationTimerRef.current);
            navigationTimerRef.current = setTimeout(() => revealCaption(pending.id, pending.attempts + 1), 80);
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
                <View style={{ flex: 1, minWidth: 0, justifyContent: 'center' }}>
                    <View style={{ gap: 9 }}>
                      <TextInput
                        ref={(input) => { inputRefs.current[item.id] = input; }}
                        multiline
                        editable={!saving && !closing}
                        scrollEnabled={false}
                        submitBehavior="newline"
                        value={item.text}
                        onChangeText={(text) => updateText(item, text)}
                        onFocus={() => selectForEditing(item)}
                        onPressIn={() => { if (editing) selectForEditing(item); }}
                        onContentSizeChange={(event) => {
                          const height = Math.ceil(event.nativeEvent.contentSize.height);
                          if (!Number.isFinite(height) || height <= 0) return;
                          // Measure every row, including prefilled/recovered text before
                          // focus. Native measurement accounts for width and font scale;
                          // no guessed line count or viewport cap can truncate the input.
                          setInputHeights((previous) => previous[item.id] === height
                            ? previous : { ...previous, [item.id]: height });
                          // The cell's subsequent onLayout re-anchors the focused row
                          // using its committed size, without seeking the video.
                          if (editing) revealCaption(item.id);
                        }}
                        onSelectionChange={(event) => { selectionRef.current[item.id] = event.nativeEvent.selection; }}
                        selectionColor={chrome.accent}
                        style={{ height: inputHeights[item.id], minHeight: editing ? 46 : 23, padding: 0, color: chrome.text, fontSize: 17, lineHeight: 23, fontWeight: '400', textAlignVertical: 'top' }}
                      />
                      {editing ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
                        <ScriptAction label="Split here" disabled={saving || closing} onPress={() => splitAtCursor(item)} />
                        <ScriptAction label="Join previous" disabled={saving || closing} onPress={() => mergeWithPrevious(item)} />
                        <ScriptAction label="Join next" disabled={saving || closing} onPress={() => mergeWithNext(item)} />
                      </View> : null}
                    </View>
                  {invalid ? <Text style={{ marginTop: 4, color: '#FF8FA2', fontSize: 11 }}>A subtitle cannot be empty. Merge it or delete its timeline block.</Text> : null}
                </View>
              </Pressable>
            );
          }}
          />
          </CaptionCellLayoutContext.Provider>
          <View pointerEvents="none" style={{ position: 'absolute', left: 8, right: 8, top: SCRIPT_ANCHOR, height: 2, borderRadius: 1, backgroundColor: '#B7FF4A', shadowColor: '#B7FF4A', shadowOpacity: 0.95, shadowRadius: 5, elevation: 5 }} />
        </View>
      </KeyboardAvoidingView>
      </View>
  );
}

function ScriptAction(props: { label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      hitSlop={4}
      onPress={props.onPress}
      style={{ minHeight: 36, justifyContent: 'center', paddingHorizontal: 12, borderRadius: chrome.radius.pill, backgroundColor: chrome.fill, opacity: props.disabled ? 0.45 : 1 }}>
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
  // Script edits own text, timing and segmentation. Current appearance changes
  // alone must not manufacture an unsaved script or a stale recovery journal.
  const script = (captions: CaptionBlock[]) => captions.map(({ styleOverride: _appearance, ...caption }) => caption);
  return JSON.stringify(script(left)) === JSON.stringify(script(right));
}
