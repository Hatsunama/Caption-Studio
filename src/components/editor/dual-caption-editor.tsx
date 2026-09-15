import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { chrome } from '@/lib/ui-theme';
import type { CaptionPair } from '@/lib/caption-tracks';
import {
  committedDualCaptionText,
  dualCaptionDraftsFromPairs,
  mergeRecoveredDualCaptionDrafts,
  shouldRestoreDualCaptionJournal,
  type DualCaptionDraft,
} from '@/lib/dual-caption-drafts';
import type { DualCaptionTextEdit } from '@/services/project-caption-translation';
import {
  clearEditorDraftJournal,
  readEditorDraftJournal,
  writeEditorDraftJournal,
  type EditorDraftKind,
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
  progressLabel?: string;
  errorMessage?: string;
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
  const sourceDrafts = useMemo(() => dualCaptionDraftsFromPairs(props.pairs), [props.pairs]);
  const [store] = useState(() => new DualCaptionDraftStore(sourceDrafts));
  const editCount = useSyncExternalStore(store.subscribeDirty, store.getDirtyCount, store.getDirtyCount);
  const [journalReady, setJournalReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const [journalError, setJournalError] = useState<string>();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const stopJournalRef = useRef<(() => void) | undefined>(undefined);
  const journalKind = `dual-captions-${props.trackId}` as EditorDraftKind;
  useLayoutEffect(() => { store.reconcile(sourceDrafts); }, [sourceDrafts, store]);

  useEffect(() => {
    const openingDrafts = store.committed;
    const allowedIds = Object.keys(openingDrafts);
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return undefined;
      return readEditorDraftJournal(props.projectId, journalKind);
    }).then((journal) => {
      if (!active) return;
      const recovered = decodeDualDraft(journal?.payload, allowedIds);
      const nextCommitted = store.committed;
      if (journal && !recovered) {
        setJournalError('The recovery draft could not be decoded. It is preserved; close and reopen the editor to retry.');
        return;
      }
      if (!recovered || !shouldRestoreDualCaptionJournal(recovered, nextCommitted)) {
        if (recovered) void clearEditorDraftJournal(props.projectId, journalKind).catch(() => { if (active) setJournalError('Old recovery data could not be cleared. Your current translation is unchanged.'); });
        setJournalReady(true);
        return;
      }
      Alert.alert(
        'Restore unsaved dual-subtitle edits?',
        'Caption Studio found typed edits that were not saved. Keeping the current translation leaves the second language as it is now.',
        [
          { text: 'Keep current translation', style: 'cancel', onPress: () => { if (!active) return; store.replace(store.committed); void clearEditorDraftJournal(props.projectId, journalKind).catch(() => { if (active) setJournalError('Old recovery data could not be cleared. Your current translation is unchanged.'); }); setJournalReady(true); } },
          { text: 'Restore unsaved typing', onPress: () => { if (!active) return; store.replace(mergeRecoveredDualCaptionDrafts(recovered, store.committed)); setJournalReady(true); } },
        ],
      );
    }).catch((caught) => {
      if (active) {
        setJournalError(caught instanceof Error ? caught.message : 'Dual-subtitle recovery storage could not be read. Existing recovery data is preserved.');
        setJournalReady(false);
      }
    });
    return () => { active = false; };
  }, [journalKind, props.projectId, store]);

  useEffect(() => {
    if (!journalReady || props.busy || saving || closing) return;
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
        void clearEditorDraftJournal(props.projectId, journalKind)
          .catch(() => { if (active) setJournalError('Old recovery data could not be cleared. Your current translation is unchanged.'); });
        return;
      }
      timer = setTimeout(() => {
        // Snapshot once after typing settles, not on every character. Journal
        // operations may be queued, so never pass the mutable draft map itself.
        void writeEditorDraftJournal(props.projectId, journalKind, props.baseRevision, store.snapshot())
          .then(() => { if (active) setJournalError(undefined); })
          .catch((caught) => { if (active) setJournalError(caught instanceof Error ? caught.message : 'Dual-subtitle recovery could not be saved. Keep this editor open until you save.'); });
      }, 600);
    };
    const unsubscribe = store.subscribeChanges(schedule);
    schedule();
    return () => { stop(); unsubscribe(); };
  }, [closing, journalKind, journalReady, props.baseRevision, props.busy, props.projectId, saving, store]);

  const includedPairs = useMemo(() => props.pairs.filter((pair) => !pair.translation.translationSkipped), [props.pairs]);
  const missingCount = useMemo(() => includedPairs.filter((pair) => !pair.translation.text.trim()).length, [includedPairs]);
  const needsRefresh = useMemo(() => includedPairs.filter((pair) => (
    !pair.translation.text.trim() || pair.translation.status === 'pending' || pair.translation.status === 'stale' || pair.translation.status === 'failed'
  )), [includedPairs]);
  const selectedPairs = useMemo(() => includedPairs.filter((pair) => selectedIds.has(pair.source.id)), [includedPairs, selectedIds]);
  const skippedCount = props.pairs.length - includedPairs.length;
  const dirty = editCount > 0;
  const disabled = props.busy || saving || closing || !journalReady;

  const closeAfterClearingJournal = useCallback(() => {
    stopJournalRef.current?.();
    setClosing(true);
    void clearEditorDraftJournal(projectId, journalKind).then(onClose)
      .catch(() => setJournalError('Recovery data could not be cleared. Your edits are still here; try Save or Close again.'))
      .finally(() => setClosing(false));
  }, [journalKind, onClose, projectId]);

  const requestClose = useCallback(() => {
    if (saving || closing) return;
    if (!journalReady) {
      if (journalError) onClose();
      return;
    }
    if (errorMessage) {
      onDismissError();
      return;
    }
    if (busy) {
      onCancelBusy();
      return;
    }
    if (selectedIds.size > 0) {
      setSelectedIds(new Set());
      return;
    }
    if (store.getDirtyCount() === 0) {
      closeAfterClearingJournal();
      return;
    }
    Alert.alert('Discard unsaved subtitle edits?', 'Your changes in both language columns have not been saved.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: closeAfterClearingJournal },
    ]);
  }, [busy, closeAfterClearingJournal, closing, errorMessage, journalError, journalReady, onCancelBusy, onClose, onDismissError, saving, selectedIds, store]);

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
    const edits = store.getEdits(props.pairs);
    if (edits.length === 0) return;
    stopJournalRef.current?.();
    setSaving(true);
    try {
      if (await props.onSave(edits)) await clearEditorDraftJournal(props.projectId, journalKind);
    } catch (caught) {
      setJournalError(caught instanceof Error ? caught.message : 'These edits could not be saved. They are still in this editor.');
    } finally {
      setSaving(false);
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
    <DualCaptionRow pair={pair} index={index} store={store} disabled={disabled} dirty={dirty}
      selected={selectedIds.has(pair.source.id)} onToggleSelection={toggleSelection}
      automaticTranslation={automaticTranslation} sourceLanguageLabel={sourceLanguageLabel}
      targetLanguageLabel={targetLanguageLabel} onRefresh={onRefresh} onSkip={onSkip} />
  ), [automaticTranslation, dirty, disabled, onRefresh, onSkip, selectedIds, sourceLanguageLabel, store, targetLanguageLabel, toggleSelection]);

  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={requestClose}>
      <View style={{ flex: 1, backgroundColor: chrome.background, paddingTop: insets.top }}>
        <View style={{ paddingHorizontal: 18, paddingTop: 22, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: chrome.hairline }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: chrome.text, fontSize: 28, fontWeight: '700' }}>Dual subtitles</Text>
              <Text style={{ marginTop: 4, color: chrome.muted, fontSize: 13, lineHeight: 18 }}>
                {props.sourceLanguageLabel} + {props.targetLanguageLabel} · independent text and timing
              </Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close dual subtitle editor" disabled={saving || closing || props.busy || (!journalReady && !journalError)} onPress={requestClose} hitSlop={10}>
              <Text style={{ color: chrome.text, fontSize: 28, lineHeight: 30 }}>×</Text>
            </Pressable>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
            <HeaderAction
              label={`${props.trackVisible ? 'Hide' : 'Show'} ${props.targetLanguageLabel} line`}
              disabled={disabled || dirty}
              onPress={props.onToggleVisibility}
            />
            <HeaderAction
                label={`Refresh unfinished (${needsRefresh.length})`}
                disabled={disabled || dirty || needsRefresh.length === 0}
                onPress={() => props.onRefresh(needsRefresh.map((pair) => pair.source.id))}
              />
            <HeaderAction label={`Refresh selected (${selectedPairs.length})`} disabled={disabled || dirty || selectedPairs.length === 0}
              onPress={() => props.onRefresh(selectedPairs.map((pair) => pair.source.id))} />
            <HeaderAction label={`Refresh all (${includedPairs.length})`} disabled={disabled || dirty || includedPairs.length === 0}
              onPress={() => props.onRefresh(includedPairs.map((pair) => pair.source.id))} />
            <HeaderAction label={selectedPairs.length === includedPairs.length && includedPairs.length > 0 ? 'Clear selection' : 'Select all'} disabled={disabled || includedPairs.length === 0}
              onPress={() => setSelectedIds(selectedPairs.length === includedPairs.length ? new Set() : new Set(includedPairs.map((pair) => pair.source.id)))} />
            <HeaderAction label="Remove second language" danger disabled={disabled || dirty} onPress={props.onRemove} />
          </View>
          <Text style={{ marginTop: 11, color: chrome.muted, fontSize: 12, lineHeight: 17 }}>
            {missingCount} need translation; {needsRefresh.length - missingCount} have text to review; {skippedCount} skipped. You can export available text anyway. Save typed edits before refreshing. Refresh replaces only the selected second-language text.
          </Text>
        </View>

        <FlatList
          style={{ flex: 1 }}
          data={props.pairs}
          keyExtractor={captionPairKey}
          renderItem={renderItem}
          initialNumToRender={6}
          maxToRenderPerBatch={6}
          windowSize={5}
          removeClippedSubviews={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ gap: 10, padding: 14, paddingBottom: 120 }}
        />

        {props.busy || props.errorMessage ? (
          <View style={{ position: 'absolute', inset: 0, zIndex: 20, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: 'rgba(0,0,0,0.78)' }}>
            <View style={{ width: '100%', maxWidth: 380, gap: 14, padding: 22, borderRadius: chrome.radius.xl, backgroundColor: chrome.surfaceRaised }}>
              {props.busy ? <ActivityIndicator color={chrome.accent} size="large" /> : null}
              <Text accessibilityRole={props.errorMessage ? 'alert' : undefined} selectable style={{ color: props.errorMessage ? chrome.dangerText : chrome.text, fontSize: 17, lineHeight: 24, fontWeight: '700', textAlign: 'center' }}>
                {props.errorMessage ?? props.progressLabel ?? 'Translating locally…'}
              </Text>
              <Text style={{ color: chrome.muted, fontSize: 13, lineHeight: 19, textAlign: 'center' }}>
                Keep Caption Studio open on this screen and keep the phone unlocked until this finishes.
              </Text>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                {props.errorMessage && props.retryErrorAvailable ? (
                  <Pressable accessibilityRole="button" accessibilityLabel="Retry interrupted translation" onPress={props.onRetryError} style={{ flex: 1, alignItems: 'center', paddingVertical: 11, borderRadius: chrome.radius.md, backgroundColor: chrome.accent }}>
                    <Text style={{ color: chrome.accentInk, fontWeight: '800' }}>Retry</Text>
                  </Pressable>
                ) : null}
                <Pressable accessibilityRole="button" onPress={props.errorMessage ? props.onDismissError : props.onCancelBusy} style={{ flex: 1, alignItems: 'center', paddingVertical: 11, borderRadius: chrome.radius.md, backgroundColor: chrome.fill }}>
                  <Text style={{ color: props.errorMessage ? chrome.text : chrome.dangerText, fontWeight: '800' }}>{props.errorMessage ? 'Close' : 'Cancel'}</Text>
                </Pressable>
              </View>
            </View>
          </View>
        ) : null}
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: 14, paddingBottom: Math.max(14, insets.bottom), borderTopWidth: 1, borderTopColor: chrome.hairline, backgroundColor: chrome.background }}>
          {journalError ? (
            <Text accessibilityRole="alert" selectable style={{ marginBottom: 8, color: chrome.dangerText, fontSize: 12, lineHeight: 17, textAlign: 'center' }}>
              {journalError}
            </Text>
          ) : null}
          {!props.busy ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save dual subtitle edits"
              disabled={editCount === 0 || disabled}
              onPress={() => { void save(); }}
              style={{ alignItems: 'center', paddingVertical: 16, borderRadius: chrome.radius.lg, backgroundColor: editCount > 0 ? chrome.accent : chrome.fill }}>
              <Text style={{ color: editCount > 0 ? chrome.accentInk : chrome.muted, fontSize: 16, fontWeight: '700' }}>
                {editCount > 0
                  ? `Save ${editCount} change${editCount === 1 ? '' : 's'}`
                  : 'No unsaved changes'}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
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
  onToggleSelection: (captionId: string) => void;
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
    <View key={pair.source.id} style={{ gap: 9, padding: 14, borderRadius: chrome.radius.lg, borderWidth: 1, borderColor: refreshRequired ? chrome.warning : chrome.hairline, backgroundColor: chrome.surface }}>
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
      {textChanged || pair.translation.status === 'stale' || pair.translation.status === 'reviewed' ? (
        <Text accessibilityRole="alert" style={{ color: chrome.warning, fontSize: 12, lineHeight: 17 }}>
          Text was edited. Check whether the other language still matches. Refresh is optional and replaces {props.targetLanguageLabel}; keeping your text is fine.
        </Text>
      ) : null}
      <LanguageInput
        label={props.sourceLanguageLabel}
        value={draft.primaryText}
        disabled={props.disabled}
        cueNumber={index + 1}
        onChangeText={(value) => props.store.setDraft(pair.source.id, 'primaryText', value)}
      />
      <LanguageInput
        label={props.targetLanguageLabel}
        value={draft.translatedText}
        disabled={props.disabled}
        cueNumber={index + 1}
        placeholder="Translation pending"
        onChangeText={(value) => props.store.setDraft(pair.source.id, 'translatedText', value)}
      />
    </View>
  );
});

function LanguageInput(props: {
  label: string;
  value: string;
  disabled: boolean;
  cueNumber: number;
  placeholder?: string;
  onChangeText: (value: string) => void;
}) {
  return (
    <View style={{ gap: 5 }}>
      <Text style={{ color: chrome.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.4 }}>{props.label.toUpperCase()}</Text>
      <TextInput
        accessibilityLabel={`${props.label} subtitle ${props.cueNumber} text`}
        value={props.value}
        editable={!props.disabled}
        multiline
        maxLength={500}
        placeholder={props.placeholder}
        placeholderTextColor={chrome.muted}
        onChangeText={props.onChangeText}
        style={{ minHeight: 54, paddingHorizontal: 14, paddingVertical: 12, borderRadius: chrome.radius.md, color: chrome.text, backgroundColor: chrome.surfaceRaised, fontSize: 16, lineHeight: 22, textAlignVertical: 'top' }}
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
      style={{ paddingHorizontal: 12, paddingVertical: 9, borderRadius: chrome.radius.pill, backgroundColor: chrome.surfaceRaised, opacity: props.disabled ? 0.45 : 1 }}>
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
