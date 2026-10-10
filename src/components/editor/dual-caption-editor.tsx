import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusedInputReveal, type FocusedInputReveal } from '@/hooks/use-focused-input-reveal';
import { KeyboardViewport } from '@/components/editor/keyboard-viewport';
import { CAPTION_CLEANUP_WARNING, createCaptionJournalQueue } from './caption-save-recovery';

import { chrome } from '@/lib/ui-theme';
import type { CaptionPair } from '@/lib/caption-tracks';
import {
  committedDualCaptionText,
  dualCaptionDraftRevision,
  dualCaptionDraftsFromPairs,
  mergeRecoveredDualCaptionDrafts,
  shouldRestoreDualCaptionJournal,
  type DualCaptionDraft,
} from '@/lib/dual-caption-drafts';
import type { DualCaptionTextEdit } from '@/services/project-caption-translation';
import {
  archiveEditorDraftJournal,
  clearEditorDraftJournal,
  readEditorDraftJournal,
  writeEditorDraftJournal,
  type EditorDraftKind,
  type EditorDraftJournalRecovery,
} from '@/services/editor-draft-journal';

type DualCaptionEditorProps = {
  visible: boolean;
  projectId: string;
  baseRevision: string;
  trackId: string;
  sourceLanguageLabel: string;
  targetLanguageLabel: string;
  pairs: CaptionPair[];
  trackVisible: boolean;
  automaticTranslation: boolean;
  busy: boolean;
  translationActive: boolean;
  progressLabel?: string;
  errorMessage?: string;
  warningMessage?: string;
  retryErrorAvailable: boolean;
  onDismissError: () => void;
  onRetryError: () => void;
  onBackRequestChange?: (request: (() => void) | undefined) => void;
  onClose: () => void;
  onSave: (edits: DualCaptionTextEdit[]) => Promise<boolean>;
  onRefresh: (sourceCaptionIds: string[]) => void;
  onSkip: (sourceCaptionId: string, skipped: boolean) => void;
  onToggleVisibility: () => void;
  onRemove: () => void;
  onCancelBusy: () => void;
};

const ignoreBackRequestChange = () => undefined;

export function DualCaptionEditor(props: DualCaptionEditorProps) {
  // Closing or changing projects/tracks owns a new draft and recovery lifetime.
  return props.visible ? <DualCaptionEditorSession key={JSON.stringify([props.projectId, props.trackId])} {...props} /> : null;
}

function DualCaptionEditorSession(props: DualCaptionEditorProps) {
  const {
    busy,
    errorMessage,
    onBackRequestChange = ignoreBackRequestChange,
    onCancelBusy,
    onClose,
    onDismissError,
    projectId,
    visible,
  } = props;
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const [rootSize, setRootSize] = useState<{ width: number; height: number }>();
  const [actionsOpen, setActionsOpen] = useState(false);
  const width = (rootSize?.width ?? window.width) - insets.left - insets.right;
  const height = (rootSize?.height ?? window.height) - insets.top - insets.bottom;
  const compact = height < 500 || width > height * 1.2;
  const paired = width >= 600;
  const shortWide = paired && height < 260;
  const listRef = useRef<FlatList<CaptionPair>>(null);
  const [listHeight, setListHeight] = useState<number>();
  // Short-wide rows have 4dp top/bottom padding and a 1dp border. Each
  // LanguageInput subtracts its measured label and gap from the remaining pane.
  const inputMaxHeight = shortWide ? Math.max(44, (listHeight ?? height) - 10) : undefined;
  const scrollToOffset = useCallback((offset: number) => listRef.current?.scrollToOffset({ offset, animated: false }), []);
  const [viewportRef, reveal] = useFocusedInputReveal(scrollToOffset);
  const sourceDrafts = useMemo(() => dualCaptionDraftsFromPairs(props.pairs), [props.pairs]);
  const [store] = useState(() => new DualCaptionDraftStore(sourceDrafts));
  const [openingRevision] = useState(() => dualCaptionDraftRevision(sourceDrafts));
  const editCount = useSyncExternalStore(store.subscribeDirty, store.getDirtyCount, store.getDirtyCount);
  const [journalReady, setJournalReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const [cleanupPending, setCleanupPending] = useState(false);
  const cleanupPendingRef = useRef(false);
  const journalQueueRef = useRef(createCaptionJournalQueue());
  const recoveryActiveRef = useRef(true);
  const [journalRestart, setJournalRestart] = useState(0);
  const [journalError, setJournalError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [journalRecovery, setJournalRecovery] = useState<EditorDraftJournalRecovery>();
  const [journalConflict, setJournalConflict] = useState(false);
  const journalProtected = journalConflict || !!journalRecovery?.failures.some((failure) => journalRecovery.source !== 'primary' || failure.source === 'primary');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const stopJournalRef = useRef<(() => void) | undefined>(undefined);
  const journalKind = `dual-captions-${props.trackId}` as EditorDraftKind;
  useLayoutEffect(() => { store.reconcile(sourceDrafts); }, [sourceDrafts, store]);
  useEffect(() => {
    const journalQueue = journalQueueRef.current;
    recoveryActiveRef.current = true;
    return () => { recoveryActiveRef.current = false; journalQueue.pause(); };
  }, []);

  useEffect(() => {
    const openingDrafts = store.committed;
    const allowedIds = Object.keys(openingDrafts);
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return undefined;
      return readEditorDraftJournal(props.projectId, journalKind);
    }).then((journal) => {
      if (!active) return;
      setJournalRecovery(journal?.recovery);
      const preserveRecovery = !!journal?.recovery?.failures.length;
      const recovered = decodeDualDraft(journal?.payload, allowedIds);
      const nextCommitted = store.committed;
      const revisionConflict = !!journal && journal.baseRevision !== openingRevision;
      if (revisionConflict) setJournalConflict(true);
      const finishConflict = () => {
        if (!revisionConflict || preserveRecovery) { setJournalReady(true); return; }
        void archiveEditorDraftJournal(props.projectId, journalKind)
          .then(() => { if (active) { setJournalConflict(false); setJournalReady(true); } })
          .catch((caught) => { if (active) {
            setJournalError(caught instanceof Error ? caught.message : 'The stale recovery draft could not be preserved.');
            setJournalReady(true);
          } });
      };
      if (journal && !recovered) {
        setJournalError('The recovery draft could not be decoded. It is preserved; close and reopen the editor to retry.');
        return;
      }
      if (!recovered || !shouldRestoreDualCaptionJournal(recovered, nextCommitted)) {
        if (recovered && !preserveRecovery && !revisionConflict) void clearEditorDraftJournal(props.projectId, journalKind).catch(() => { if (active) setJournalError('Old recovery data could not be cleared. Your current translation is unchanged.'); });
        if (revisionConflict) setJournalError('Recovery conflict: the captions changed since this draft was saved. The recovery draft is preserved.');
        finishConflict();
        return;
      }
      Alert.alert(
        'Restore unsaved dual-subtitle edits?',
        [journal?.recovery?.warning, revisionConflict ? 'Recovery conflict: the captions changed since this draft was saved. Restoring may replace newer caption text; the recovery draft will be preserved.' : undefined, 'Caption Studio found typed edits that were not saved. Keeping the current translation leaves the second language as it is now.'].filter(Boolean).join('\n\n'),
        [
          { text: 'Keep current translation', style: 'cancel', onPress: () => { if (!active) return; store.replace(store.committed); if (!preserveRecovery && !revisionConflict) void clearEditorDraftJournal(props.projectId, journalKind).catch(() => { if (active) setJournalError('Old recovery data could not be cleared. Your current translation is unchanged.'); }); finishConflict(); } },
          { text: 'Restore unsaved typing', onPress: () => { if (!active) return; store.replace(mergeRecoveredDualCaptionDrafts(recovered, store.committed)); finishConflict(); } },
        ],
      );
    }).catch((caught) => {
      if (active) {
        setJournalError(caught instanceof Error ? caught.message : 'Dual-subtitle recovery storage could not be read. Existing recovery data is preserved.');
        setJournalReady(false);
      }
    });
    return () => { active = false; };
  }, [journalKind, openingRevision, props.projectId, store]);

  useEffect(() => {
    if (!journalReady || props.busy || saving || closing) return;
    if (journalProtected) return;
    if (cleanupPendingRef.current && !store.hasRecoveryChanges()) return;
    journalQueueRef.current.resume();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      active = false;
      clearTimeout(timer);
    };
    stopJournalRef.current = stop;
    const schedule = () => {
      if (!active) return;
      clearTimeout(timer);
      if (!store.hasRecoveryChanges()) {
        void journalQueueRef.current.clear(() => clearEditorDraftJournal(props.projectId, journalKind), () => !store.hasRecoveryChanges())
          .catch(() => { if (active) setJournalError('Old recovery data could not be cleared. Your current translation is unchanged.'); });
        return;
      }
      timer = setTimeout(() => {
        // Snapshot once after typing settles, not on every character. Journal
        // operations may be queued, so never pass the mutable draft map itself.
        const snapshot = store.snapshot();
        const revision = dualCaptionDraftRevision(store.committed);
        journalQueueRef.current.resume();
        void journalQueueRef.current.write(() => writeEditorDraftJournal(props.projectId, journalKind, revision, snapshot))
          .then(() => { if (active) setJournalError(undefined); })
          .catch((caught) => { if (active) setJournalError(caught instanceof Error ? caught.message : 'Dual-subtitle recovery could not be saved. Keep this editor open until you save.'); });
      }, 600);
    };
    const unsubscribe = store.subscribeChanges(schedule);
    schedule();
    return () => { stop(); unsubscribe(); };
  }, [closing, journalKind, journalProtected, journalReady, journalRestart, openingRevision, props.busy, props.projectId, saving, store]);

  const includedPairs = useMemo(() => props.pairs.filter((pair) => !pair.translation.translationSkipped), [props.pairs]);
  const missingCount = useMemo(() => includedPairs.filter((pair) => !pair.translation.text.trim()).length, [includedPairs]);
  const failedCount = useMemo(() => includedPairs.filter((pair) => pair.translation.status === 'failed').length, [includedPairs]);
  const needsRefresh = useMemo(() => includedPairs.filter((pair) => (
    !pair.translation.text.trim() || pair.translation.status === 'pending' || pair.translation.status === 'stale' || pair.translation.status === 'failed'
  )), [includedPairs]);
  const selectedPairs = useMemo(() => includedPairs.filter((pair) => selectedIds.has(pair.source.id)), [includedPairs, selectedIds]);
  const skippedCount = props.pairs.length - includedPairs.length;
  const dirty = editCount > 0;
  const disabled = props.busy || saving || closing || !journalReady;

  const retryCleanup = useCallback(async function retrySavedRecoveryCleanup(): Promise<void> {
    if (!recoveryActiveRef.current || !cleanupPendingRef.current || store.hasRecoveryChanges()) return;
    stopJournalRef.current?.();
    setClosing(true);
    try {
      const cleared = await journalQueueRef.current.clear(
        () => clearEditorDraftJournal(projectId, journalKind),
        () => recoveryActiveRef.current && !store.hasRecoveryChanges(),
      );
      if (!cleared) return;
      cleanupPendingRef.current = false;
      setCleanupPending(false);
      setJournalError(undefined);
    } catch {
      Alert.alert('Changes saved', CAPTION_CLEANUP_WARNING, [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'Retry cleanup', onPress: () => { void retrySavedRecoveryCleanup(); } },
      ]);
    } finally {
      setClosing(false);
      setJournalRestart((value) => value + 1);
    }
  }, [journalKind, projectId, store]);

  const closeAfterClearingJournal = useCallback(() => {
    stopJournalRef.current?.();
    if (!journalReady || journalProtected) { onClose(); return; }
    setClosing(true);
    void journalQueueRef.current.clear(() => clearEditorDraftJournal(projectId, journalKind)).then(onClose)
      .catch(() => setJournalError(cleanupPendingRef.current ? CAPTION_CLEANUP_WARNING : 'Recovery data could not be cleared. Your edits are still here; try Save or Close again.'))
      .finally(() => { setClosing(false); setJournalRestart((value) => value + 1); });
  }, [journalKind, journalProtected, journalReady, onClose, projectId]);

  const requestClose = useCallback(() => {
    if (saving || closing) return;
    if (!journalReady && !journalError) return;
    if (errorMessage) {
      onDismissError();
      return;
    }
    if (busy) {
      onCancelBusy();
      return;
    }
    if (compact && actionsOpen) { setActionsOpen(false); return; }
    if (selectedIds.size > 0) {
      setSelectedIds(new Set());
      return;
    }
    if (!store.hasRecoveryChanges()) {
      closeAfterClearingJournal();
      return;
    }
    Alert.alert('Discard unsaved subtitle edits?', journalReady && !journalProtected
      ? 'Your changes in both language columns have not been saved.'
      : 'Current edits will be discarded. The unread recovery files will be preserved.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: closeAfterClearingJournal },
    ]);
  }, [actionsOpen, compact, busy, closeAfterClearingJournal, closing, errorMessage, journalError, journalProtected, journalReady, onCancelBusy, onDismissError, saving, selectedIds, store]);

  useEffect(() => {
    if (!visible) {
      onBackRequestChange(undefined);
      return;
    }
    onBackRequestChange(requestClose);
    return () => onBackRequestChange(undefined);
  }, [onBackRequestChange, requestClose, visible]);

  const save = async () => {
    if (disabled) return;
    if (cleanupPendingRef.current && !store.hasRecoveryChanges()) { await retryCleanup(); return; }
    const edits = store.getEdits(props.pairs);
    if (edits.length === 0) return;
    const snapshot = store.snapshot();
    stopJournalRef.current?.();
    journalQueueRef.current.pause();
    setSaving(true);
    setSaveError(undefined);
    let saved = false;
    try {
      saved = await props.onSave(edits);
      if (!saved) setSaveError('Dual-subtitle edits could not be saved. Your changes are still here. Try again.');
      else store.accept(edits, snapshot);
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : 'These edits could not be saved. They are still in this editor.');
    } finally {
      setSaving(false);
      setJournalRestart((value) => value + 1);
    }
    if (saved && journalReady && !journalProtected && !store.hasRecoveryChanges()) {
      cleanupPendingRef.current = true;
      setCleanupPending(true);
      await retryCleanup();
    }
  };

  const toggleSelection = useCallback((captionId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(captionId)) next.delete(captionId); else next.add(captionId);
      return next;
    });
  }, []);
  const { automaticTranslation, sourceLanguageLabel, targetLanguageLabel, onRefresh, onSkip } = props;
  const renderItem = useCallback(({ item: pair, index }: { item: CaptionPair; index: number }) => (
    <DualCaptionRow pair={pair} index={index} store={store} disabled={disabled} dirty={dirty} paired={paired} shortWide={shortWide}
      selected={selectedIds.has(pair.source.id)} onToggleSelection={toggleSelection}
      automaticTranslation={automaticTranslation} sourceLanguageLabel={sourceLanguageLabel}
      targetLanguageLabel={targetLanguageLabel} onRefresh={onRefresh} onSkip={onSkip} reveal={reveal} inputMaxHeight={inputMaxHeight} />
  ), [automaticTranslation, dirty, disabled, inputMaxHeight, onRefresh, onSkip, paired, reveal, selectedIds, shortWide, sourceLanguageLabel, store, targetLanguageLabel, toggleSelection]);

  const recoveryStatus = (
    <View style={{ gap: 8 }}>
      {[journalRecovery?.warning, journalError, saveError].filter(Boolean).map((message, index) => (
        <Text key={index} accessibilityRole="alert" selectable style={{ color: chrome.dangerText, fontSize: 12, lineHeight: 17 }}>{message}</Text>
      ))}
    </View>
  );
  const hasStatus = Boolean(journalRecovery?.warning || journalError || saveError);
  const actions = (
    <View style={{ gap: 11 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <HeaderAction label={`${props.trackVisible ? 'Hide' : 'Show'} ${props.targetLanguageLabel} line`} disabled={disabled || dirty} onPress={props.onToggleVisibility} />
        <HeaderAction label={`Refresh unfinished (${needsRefresh.length})`} disabled={disabled || dirty || !props.automaticTranslation || needsRefresh.length === 0} onPress={() => props.onRefresh(needsRefresh.map((pair) => pair.source.id))} />
        <HeaderAction label={`Refresh selected (${selectedPairs.length})`} disabled={disabled || dirty || !props.automaticTranslation || selectedPairs.length === 0} onPress={() => props.onRefresh(selectedPairs.map((pair) => pair.source.id))} />
        <HeaderAction label={`Refresh all (${includedPairs.length})`} disabled={disabled || dirty || !props.automaticTranslation || includedPairs.length === 0} onPress={() => props.onRefresh(includedPairs.map((pair) => pair.source.id))} />
        <HeaderAction label={selectedPairs.length === includedPairs.length && includedPairs.length > 0 ? 'Clear selection' : 'Select all'} disabled={disabled || includedPairs.length === 0} onPress={() => setSelectedIds(selectedPairs.length === includedPairs.length ? new Set() : new Set(includedPairs.map((pair) => pair.source.id)))} />
        <HeaderAction label="Remove second language" danger disabled={disabled || dirty} onPress={props.onRemove} />
      </View>
      <Text style={{ color: chrome.muted, fontSize: 12, lineHeight: 17 }}>
        {failedCount} failed; {missingCount} without a saved translation; {needsRefresh.length} unfinished; {skippedCount} skipped. Failed lines without saved translations show current source text as an unresolved fallback. You can export available text and source fallbacks anyway. Save typed edits before refreshing. Failed refreshes keep saved text; successful refreshes replace only the requested second-language text.
      </Text>
    </View>
  );

  const saveControl = !props.busy ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save dual subtitle edits"
              disabled={(editCount === 0 && !cleanupPending) || disabled}
              onPress={() => { void save(); }}
              style={{ alignItems: 'center', minHeight: 44, justifyContent: 'center', paddingHorizontal: shortWide ? 12 : undefined, paddingVertical: shortWide ? 8 : 16, borderRadius: chrome.radius.lg, backgroundColor: editCount > 0 ? chrome.accent : chrome.fill }}>
              <Text style={{ color: editCount > 0 ? chrome.accentInk : chrome.muted, fontSize: 16, fontWeight: '700' }}>
                {cleanupPending && !store.hasRecoveryChanges() ? 'Retry recovery cleanup' : editCount > 0
                  ? `Save ${editCount} change${editCount === 1 ? '' : 's'}`
                  : 'No unsaved changes'}
              </Text>
            </Pressable>
          ) : null;

  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={requestClose}>
      <KeyboardViewport safeAreaBottom={insets.bottom} style={{ flex: 1 }}>
      {({ safeAreaBottom }) => (
      <View testID="dual-caption-root" onLayout={({ nativeEvent: { layout } }) => setRootSize({ width: layout.width, height: layout.height })}
        style={{ flex: 1, minHeight: 0, backgroundColor: chrome.background, paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }}>
        <View style={{ paddingHorizontal: 18, paddingTop: compact ? 4 : 22, paddingBottom: compact ? 4 : 14, borderBottomWidth: 1, borderBottomColor: chrome.hairline }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: chrome.text, fontSize: compact ? 22 : 28, fontWeight: '700' }}>Dual subtitles</Text>
              {!compact ? <Text style={{ marginTop: 4, color: chrome.muted, fontSize: 13, lineHeight: 18 }}>
                {props.sourceLanguageLabel} + {props.targetLanguageLabel} · independent text and timing
              </Text> : null}
            </View>
            {shortWide ? saveControl : null}
            {compact ? <Pressable accessibilityRole="button" accessibilityLabel="Dual subtitle actions and status" accessibilityState={{ expanded: actionsOpen }} onPress={() => setActionsOpen((value) => !value)} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 }}>
              <Text style={{ color: chrome.accent, fontSize: 14, fontWeight: '700' }}>Actions{hasStatus ? ' !' : ''}</Text>
            </Pressable> : null}
            <Pressable accessibilityRole="button" accessibilityLabel="Close dual subtitle editor" disabled={saving || closing || props.busy || (!journalReady && !journalError)} onPress={requestClose} hitSlop={10} style={{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: chrome.text, fontSize: 28, lineHeight: 30 }}>×</Text>
            </Pressable>
          </View>
          {!compact ? <View style={{ marginTop: 14 }}>{actions}</View> : null}
        </View>

        <View collapsable={false} ref={viewportRef} onLayout={(event) => { setListHeight(event.nativeEvent.layout.height); reveal.onViewportLayout(); }} style={{ flex: 1, minHeight: 0 }}>
        <FlatList
          ref={listRef}
          onScroll={reveal.onScroll}
          onScrollBeginDrag={reveal.onScrollBeginDrag}
          scrollEventThrottle={16}
          style={{ flex: 1, minHeight: 0 }}
          ListHeaderComponent={compact && (actionsOpen || hasStatus) ? <View style={{ gap: 12 }}>{actionsOpen ? actions : null}{hasStatus ? recoveryStatus : null}</View> : null}
          data={props.pairs}
          keyExtractor={captionPairKey}
          renderItem={renderItem}
          initialNumToRender={6}
          maxToRenderPerBatch={6}
          windowSize={5}
          removeClippedSubviews={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{ gap: 10, padding: 14, paddingTop: shortWide ? 0 : 14, paddingBottom: shortWide ? 0 : 14 }}
        />
        </View>

        {props.busy || props.errorMessage || props.warningMessage ? (
          <View accessibilityViewIsModal style={{ position: 'absolute', inset: 0, zIndex: 20, alignItems: 'center', justifyContent: 'center', paddingTop: Math.max(8, insets.top), paddingBottom: Math.max(8, safeAreaBottom), paddingLeft: Math.max(12, insets.left), paddingRight: Math.max(12, insets.right), backgroundColor: 'rgba(0,0,0,0.78)' }}>
            <ScrollView keyboardShouldPersistTaps="handled" style={{ width: '100%', maxWidth: 380, maxHeight: '100%', flexShrink: 1, borderRadius: chrome.radius.xl, backgroundColor: chrome.surfaceRaised }} contentContainerStyle={{ gap: 14, padding: 22 }}>
              {props.busy ? <ActivityIndicator color={chrome.accent} size="large" /> : null}
              <Text accessibilityRole={props.errorMessage || props.warningMessage ? 'alert' : undefined} selectable style={{ color: props.warningMessage ? chrome.warning : props.errorMessage ? chrome.dangerText : chrome.text, fontSize: 17, lineHeight: 24, fontWeight: '700', textAlign: 'center' }}>
                {props.warningMessage ?? props.errorMessage ?? props.progressLabel ?? 'Translating locally…'}
              </Text>
              {props.busy && !props.errorMessage && !props.warningMessage ? (
                <Text style={{ color: '#E8EF8D', fontSize: 13, lineHeight: 19, textAlign: 'center' }}>
                  Turn off battery saver and keep Caption Studio open on this screen until this finishes
                </Text>
              ) : null}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                {props.errorMessage && props.retryErrorAvailable ? (
                  <Pressable accessibilityRole="button" accessibilityLabel="Retry interrupted translation" onPress={props.onRetryError} style={{ flex: 1, alignItems: 'center', paddingVertical: 11, borderRadius: chrome.radius.md, backgroundColor: chrome.accent }}>
                    <Text style={{ color: chrome.accentInk, fontWeight: '800' }}>Retry</Text>
                  </Pressable>
                ) : null}
                <Pressable accessibilityRole="button" onPress={props.errorMessage || props.warningMessage ? props.onDismissError : props.onCancelBusy} style={{ flex: 1, alignItems: 'center', paddingVertical: 11, borderRadius: chrome.radius.md, backgroundColor: chrome.fill }}>
                  <Text style={{ color: props.errorMessage || props.warningMessage ? chrome.text : chrome.dangerText, fontWeight: '800' }}>{props.errorMessage || props.warningMessage ? 'Close' : 'Cancel'}</Text>
                </Pressable>
              </View>
              {props.translationActive && !props.errorMessage && !props.warningMessage ? (
                <Text style={{ color: chrome.muted, fontSize: 12, lineHeight: 17, textAlign: 'center' }}>
                  Translations are happening locally with a 1.5B Qwen model. It will not be instant and I apologize for that.
                </Text>
              ) : null}
            </ScrollView>
          </View>
        ) : null}
        <View testID="dual-caption-footer" style={{ padding: shortWide ? 0 : compact ? 8 : 14, paddingBottom: shortWide ? safeAreaBottom : Math.max(compact ? 8 : 14, safeAreaBottom), borderTopWidth: shortWide ? 0 : 1, borderTopColor: chrome.hairline, backgroundColor: chrome.background }}>
          {!compact && journalRecovery?.warning ? (
            <Text accessibilityRole="alert" selectable style={{ marginBottom: 8, color: chrome.dangerText, fontSize: 12, lineHeight: 17, textAlign: 'center' }}>
              {journalRecovery.warning}
            </Text>
          ) : null}
          {!compact && journalError ? (
            <Text accessibilityRole="alert" selectable style={{ marginBottom: 8, color: chrome.dangerText, fontSize: 12, lineHeight: 17, textAlign: 'center' }}>
              {journalError}
            </Text>
          ) : null}
          {!compact && saveError ? (
            <Text accessibilityRole="alert" selectable style={{ marginBottom: 8, color: chrome.dangerText, fontSize: 12, lineHeight: 17, textAlign: 'center' }}>
              {saveError}
            </Text>
          ) : null}
          {!shortWide ? saveControl : null}
        </View>
      </View>
      )}
      </KeyboardViewport>
    </Modal>
  );
}

function captionPairKey(pair: CaptionPair) { return pair.source.id; }

const DualCaptionRow = memo(function DualCaptionRow(props: {
  pair: CaptionPair;
  index: number;
  store: DualCaptionDraftStore;
  disabled: boolean;
  dirty: boolean;
  selected: boolean;
  paired: boolean;
  shortWide: boolean;
  onToggleSelection: (captionId: string) => void;
  reveal: FocusedInputReveal;
  inputMaxHeight?: number;
} & Pick<DualCaptionEditorProps, 'automaticTranslation' | 'sourceLanguageLabel' | 'targetLanguageLabel' | 'onRefresh' | 'onSkip'>) {
  const { pair, index, store } = props;
  const subscribe = useCallback((listener: () => void) => store.subscribeCue(pair.source.id, listener), [pair.source.id, store]);
  const getSnapshot = useCallback(() => store.getDraft(pair.source.id), [pair.source.id, store]);
  const draftValue = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const draft = draftValue ?? { primaryText: pair.source.text, translatedText: pair.translation.text };
  const refreshRequired = pair.translation.status === 'pending' || pair.translation.status === 'stale' || pair.translation.status === 'failed';
  const skipped = Boolean(pair.translation.translationSkipped);
  const textChanged = draft.primaryText.trim() !== pair.source.text.trim() || draft.translatedText.trim() !== pair.translation.text.trim();
  return (
    <View key={pair.source.id} style={{ flexDirection: props.shortWide ? 'row' : 'column', gap: 9, padding: props.shortWide ? 4 : 14, borderRadius: chrome.radius.lg, borderWidth: 1, borderColor: refreshRequired ? chrome.warning : chrome.hairline, backgroundColor: chrome.surface }}>
      <ScrollView scrollEnabled={props.shortWide} keyboardShouldPersistTaps="handled"
        style={props.shortWide ? { width: 156, maxHeight: props.inputMaxHeight, flexGrow: 0, flexShrink: 0 } : { flexGrow: 0 }}
        contentContainerStyle={{ gap: 9 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: props.selected, disabled: props.disabled || skipped }}
          accessibilityLabel={`Select subtitle ${index + 1} for refresh`} disabled={props.disabled || skipped}
          onPress={() => props.onToggleSelection(pair.source.id)}
          hitSlop={8} style={{ paddingVertical: 8 }}>
          <Text style={{ color: chrome.accent, fontSize: 12, fontWeight: '700' }}>{props.selected ? '[x]' : '[ ]'} #{index + 1} · {formatTime(pair.startMs)}</Text>
        </Pressable>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
          <Text style={{ color: statusColor(pair.translation.status), fontSize: 10, fontWeight: '900' }}>
            {skipped ? 'SKIPPED' : statusLabel(pair.translation.status)}
          </Text>
          {props.automaticTranslation ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Refresh translation for subtitle ${index + 1}`}
              disabled={props.disabled || props.dirty || skipped}
              onPress={() => props.onRefresh([pair.source.id])}
              hitSlop={8}>
              <Text style={{ color: chrome.accent, fontSize: 13, fontWeight: '700' }}>Refresh</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      <HeaderAction label={skipped ? 'Include second line' : 'Skip second line'} disabled={props.disabled || props.dirty}
        onPress={() => props.onSkip(pair.source.id, !skipped)} />
      {pair.translation.status === 'failed' ? (
        <Text accessibilityRole="alert" selectable style={{ color: chrome.dangerText, fontSize: 12, lineHeight: 17 }}>
          Translation failed: {pair.translation.failureReason || 'No failure reason was returned.'}
          {pair.translation.text.trim() ? ' Previously saved text was kept.' : ' Showing current source text as an unresolved fallback. No translated text was saved.'}
        </Text>
      ) : null}
      {textChanged || pair.translation.status === 'stale' || pair.translation.status === 'reviewed' ? (
        <Text accessibilityRole="alert" style={{ color: chrome.warning, fontSize: 12, lineHeight: 17 }}>
          Text was edited. Check whether the other language still matches. Refresh is optional and replaces {props.targetLanguageLabel}; keeping your text is fine.
        </Text>
      ) : null}
      </ScrollView>
      <View style={{ flex: props.shortWide ? 1 : undefined, minWidth: 0, flexDirection: props.paired ? 'row' : 'column', gap: 9 }}>
      <LanguageInput
        reveal={props.reveal}
        inputMaxHeight={props.inputMaxHeight}
        horizontal={props.paired}
        label={props.sourceLanguageLabel}
        value={draft.primaryText}
        disabled={props.disabled}
        cueNumber={index + 1}
        onChangeText={(value) => props.store.setDraft(pair.source.id, 'primaryText', value)}
      />
      <LanguageInput
        reveal={props.reveal}
        inputMaxHeight={props.inputMaxHeight}
        horizontal={props.paired}
        label={props.targetLanguageLabel}
        value={draft.translatedText}
        disabled={props.disabled}
        cueNumber={index + 1}
        placeholder={skipped ? 'Translation skipped' : pair.displayProvenance === 'source-fallback' ? draft.primaryText : 'Translation pending'}
        onChangeText={(value) => props.store.setDraft(pair.source.id, 'translatedText', value)}
      />
      </View>
    </View>
  );
});

function LanguageInput(props: {
  reveal: FocusedInputReveal;
  inputMaxHeight?: number;
  horizontal?: boolean;
  label: string;
  value: string;
  disabled: boolean;
  cueNumber: number;
  placeholder?: string;
  onChangeText: (value: string) => void;
}) {
  const inputRef = useRef<TextInput>(null);
  const focused = useRef(false);
  const [labelHeight, setLabelHeight] = useState(16);
  const maxHeight = props.inputMaxHeight === undefined ? undefined : Math.max(44, props.inputMaxHeight - labelHeight - 5);
  return (
    <View style={{ flex: props.horizontal ? 1 : undefined, minWidth: 0, gap: 5 }}>
      <Text onLayout={(event) => setLabelHeight(event.nativeEvent.layout.height)} style={{ color: chrome.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.4 }}>{props.label.toUpperCase()}</Text>
      <TextInput
        ref={inputRef}
        onFocus={() => { focused.current = true; props.reveal.focus(inputRef.current); }}
        onBlur={() => { focused.current = false; props.reveal.blur(inputRef.current); }}
        onLayout={() => { if (focused.current) props.reveal.focus(inputRef.current); }}
        onContentSizeChange={() => { if (focused.current) props.reveal.focus(inputRef.current); }}
        disableFullscreenUI
        accessibilityLabel={`${props.label} subtitle ${props.cueNumber} text`}
        value={props.value}
        editable={!props.disabled}
        multiline
        scrollEnabled
        maxLength={500}
        placeholder={props.placeholder}
        placeholderTextColor={chrome.muted}
        onChangeText={props.onChangeText}
        style={{ height: maxHeight, minHeight: Math.min(54, maxHeight ?? 54), maxHeight, paddingHorizontal: 14, paddingVertical: maxHeight ? 6 : 12, borderRadius: chrome.radius.md, color: chrome.text, backgroundColor: chrome.surfaceRaised, fontSize: 16, lineHeight: 22, textAlignVertical: 'top' }}
      />
    </View>
  );
}

function HeaderAction(props: { label: string; disabled: boolean; danger?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 9, borderRadius: chrome.radius.pill, backgroundColor: chrome.surfaceRaised, opacity: props.disabled ? 0.45 : 1 }}>
      <Text style={{ color: props.danger ? chrome.dangerText : chrome.text, fontSize: 12, fontWeight: '600' }}>{props.label}</Text>
    </Pressable>
  );
}

function statusLabel(status: CaptionPair['translation']['status']) {
  if (status === 'reviewed') return 'REVIEWED';
  if (status === 'translated') return 'READY';
  if (status === 'stale') return 'CHECK TRANSLATION';
  if (status === 'failed') return 'FAILED - RETRY';
  return 'PENDING';
}

function statusColor(status: CaptionPair['translation']['status']) {
  if (status === 'reviewed') return chrome.success;
  if (status === 'translated') return chrome.accent;
  return chrome.warning;
}

function formatTime(milliseconds: number) {
  const totalSeconds = Math.max(0, milliseconds) / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}

// Drafts outlive virtualized rows. A keystroke replaces one immutable cue
// snapshot, updates its dirty membership, and notifies only that cue. Document
// work is reserved for incoming pairs, recovery, and explicit save boundaries.
class DualCaptionDraftStore {
  committed: Record<string, DualCaptionDraft>;
  private drafts = new Map<string, DualCaptionDraft>();
  private edits = new Map<string, DualCaptionTextEdit>();
  private recoveryIds = new Set<string>();
  private cueListeners = new Map<string, Set<() => void>>();
  private dirtyListeners = new Set<() => void>();
  private changeListeners = new Set<() => void>();

  constructor(committed: Record<string, DualCaptionDraft>) {
    this.committed = committed;
    this.drafts = new Map(Object.entries(committed));
  }

  getDraft = (id: string) => this.drafts.get(id);
  getDirtyCount = () => this.edits.size;
  hasRecoveryChanges = () => this.recoveryIds.size > 0;
  snapshot = () => Object.fromEntries(this.drafts);
  getEdits = (pairs: CaptionPair[]) => pairs.flatMap((pair) => {
    const edit = this.edits.get(pair.source.id);
    return edit ? [edit] : [];
  });

  subscribeCue = (id: string, listener: () => void) => {
    let listeners = this.cueListeners.get(id);
    if (!listeners) { listeners = new Set(); this.cueListeners.set(id, listeners); }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.cueListeners.delete(id);
    };
  };
  subscribeDirty = (listener: () => void) => {
    this.dirtyListeners.add(listener);
    return () => { this.dirtyListeners.delete(listener); };
  };
  subscribeChanges = (listener: () => void) => {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  };

  setDraft(id: string, field: keyof DualCaptionDraft, value: string) {
    const current = this.drafts.get(id);
    if (!current || current[field] === value) return;
    const previousCount = this.edits.size;
    this.update(id, { ...current, [field]: value });
    this.notify(previousCount);
  }

  reconcile(next: Record<string, DualCaptionDraft>) {
    if (next === this.committed) return;
    const previous = this.committed;
    const previousCount = this.edits.size;
    this.committed = next;
    for (const [id, committed] of Object.entries(next)) {
      const draft = this.drafts.get(id);
      this.update(id, {
        primaryText: !draft || !previous[id] || draft.primaryText === previous[id].primaryText ? committed.primaryText : draft.primaryText,
        translatedText: !draft || !previous[id] || draft.translatedText === previous[id].translatedText ? committed.translatedText : draft.translatedText,
      });
    }
    for (const id of this.drafts.keys()) {
      if (Object.hasOwn(next, id)) continue;
      this.drafts.delete(id);
      this.edits.delete(id);
      this.recoveryIds.delete(id);
      this.cueListeners.get(id)?.forEach((listener) => listener());
    }
    this.notify(previousCount);
  }

  replace(next: Record<string, DualCaptionDraft>) {
    const previousCount = this.edits.size;
    for (const [id, committed] of Object.entries(this.committed)) this.update(id, next[id] ?? committed);
    this.notify(previousCount);
  }

  // Accept only the fields submitted by this save. Incoming translations and
  // keystrokes arriving during the save retain their own ownership.
  accept(edits: DualCaptionTextEdit[], snapshot: Record<string, DualCaptionDraft>) {
    const previousCount = this.edits.size;
    const committed = { ...this.committed };
    for (const edit of edits) {
      const id = edit.sourceCaptionId;
      const current = this.drafts.get(id);
      if (!current || !committed[id] || !snapshot[id]) continue;
      committed[id] = {
        primaryText: edit.primaryChanged ? edit.primaryText : committed[id].primaryText,
        translatedText: edit.translatedChanged ? edit.translatedText : committed[id].translatedText,
      };
      this.committed = committed;
      this.update(id, {
        primaryText: edit.primaryChanged && current.primaryText === snapshot[id].primaryText ? edit.primaryText : current.primaryText,
        translatedText: edit.translatedChanged && current.translatedText === snapshot[id].translatedText ? edit.translatedText : current.translatedText,
      });
    }
    this.notify(previousCount);
  }

  private update(id: string, draft: DualCaptionDraft) {
    const committed = this.committed[id];
    const previous = this.drafts.get(id);
    const primaryText = committedDualCaptionText(draft.primaryText, committed.primaryText);
    const translatedText = committedDualCaptionText(draft.translatedText, committed.translatedText);
    const primaryChanged = primaryText !== committed.primaryText.trim();
    const translatedChanged = translatedText !== committed.translatedText.trim();
    if (primaryChanged || translatedChanged) this.edits.set(id, { sourceCaptionId: id, primaryText, translatedText, primaryChanged, translatedChanged });
    else this.edits.delete(id);
    if (draft.primaryText !== committed.primaryText || draft.translatedText !== committed.translatedText) this.recoveryIds.add(id);
    else this.recoveryIds.delete(id);
    if (previous?.primaryText === draft.primaryText && previous?.translatedText === draft.translatedText) return;
    this.drafts.set(id, draft);
    this.cueListeners.get(id)?.forEach((listener) => listener());
  }

  private notify(previousCount: number) {
    if (previousCount !== this.edits.size) this.dirtyListeners.forEach((listener) => listener());
    this.changeListeners.forEach((listener) => listener());
  }
}

function decodeDualDraft(value: unknown, allowedIds: string[]): Record<string, DualCaptionDraft> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = new Set(allowedIds);
  const entries = Object.entries(value);
  if (entries.length > allowed.size || entries.some(([id]) => !allowed.has(id))) return null;
  const valid = entries.every(([, draft]) => {
    if (!draft || typeof draft !== 'object') return false;
    const candidate = draft as Partial<DualCaptionDraft>;
    return typeof candidate.primaryText === 'string' && typeof candidate.translatedText === 'string';
  });
  return valid ? value as Record<string, DualCaptionDraft> : null;
}
