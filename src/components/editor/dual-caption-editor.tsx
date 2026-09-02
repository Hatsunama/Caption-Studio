import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { chrome } from '@/lib/ui-theme';
import type { CaptionPair } from '@/lib/caption-tracks';
import {
  adoptCommittedDualCaptionDrafts,
  committedDualCaptionText,
  dualCaptionDraftsFromPairs,
  dualCaptionDraftsMatch,
  mergeRecoveredDualCaptionDrafts,
  type DualCaptionDraft,
} from '@/lib/dual-caption-drafts';
import type { DualCaptionTextEdit } from '@/services/project-caption-translation';
import {
  clearEditorDraftJournal,
  readEditorDraftJournal,
  writeEditorDraftJournal,
  type EditorDraftKind,
} from '@/services/editor-draft-journal';

export function DualCaptionEditor(props: {
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
  onClose: () => void;
  onSave: (edits: DualCaptionTextEdit[]) => Promise<boolean>;
  onRefresh: (sourceCaptionIds: string[]) => void;
  onToggleVisibility: () => void;
  onRemove: () => void;
  onCancelBusy: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [drafts, setDrafts] = useState<Record<string, DualCaptionDraft>>(() => dualCaptionDraftsFromPairs(props.pairs));
  const [journalReady, setJournalReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [journalError, setJournalError] = useState<string>();
  const wasVisibleRef = useRef(false);
  const committedRef = useRef<Record<string, DualCaptionDraft>>(dualCaptionDraftsFromPairs(props.pairs));
  const sourceDraftsRef = useRef<Record<string, DualCaptionDraft>>(committedRef.current);
  const journalKind = `dual-captions-${props.trackId}` as EditorDraftKind;
  const sourceDrafts = useMemo(() => dualCaptionDraftsFromPairs(props.pairs), [props.pairs]);
  sourceDraftsRef.current = sourceDrafts;
  const displayDrafts = adoptCommittedDualCaptionDrafts(committedRef.current, sourceDrafts, drafts);
  if (dualCaptionDraftsMatch(drafts, displayDrafts)) committedRef.current = sourceDrafts;

  useEffect(() => {
    const opening = props.visible && !wasVisibleRef.current;
    wasVisibleRef.current = props.visible;
    if (!opening) return;
    committedRef.current = sourceDrafts;
    setDrafts(sourceDrafts);
    setJournalReady(false);
    setJournalError(undefined);
    let active = true;
    void readEditorDraftJournal(props.projectId, journalKind).then((journal) => {
      if (!active) return;
      const recovered = decodeDualDraft(journal?.payload, props.pairs.map((pair) => pair.source.id));
      const committed = sourceDraftsRef.current;
      if (!recovered) {
        setJournalReady(true);
        return;
      }
      const merged = mergeRecoveredDualCaptionDrafts(recovered, committed);
      if (dualCaptionDraftsMatch(merged, committed)) {
        void clearEditorDraftJournal(props.projectId, journalKind);
        setJournalReady(true);
        return;
      }
      Alert.alert(
        journal?.baseRevision === props.baseRevision ? 'Restore unsaved dual-subtitle edits?' : 'Dual-subtitle recovery needs review',
        journal?.baseRevision === props.baseRevision
          ? 'Caption Studio recovered edits that were not saved before the app closed.'
          : 'The project changed after this recovery was created. Review both language columns before saving.',
        [
          { text: 'Discard recovery', style: 'destructive', onPress: () => { void clearEditorDraftJournal(props.projectId, journalKind); setJournalReady(true); } },
          { text: 'Restore', onPress: () => { setDrafts(mergeRecoveredDualCaptionDrafts(recovered, sourceDraftsRef.current)); setJournalReady(true); } },
        ],
      );
    }).catch(() => {
      if (active) {
        setJournalError('Dual-subtitle recovery storage could not be read. Save your changes before leaving this editor.');
        setJournalReady(true);
      }
    });
    return () => { active = false; };
  }, [journalKind, props.baseRevision, props.pairs, props.projectId, props.visible, sourceDrafts]);

  useEffect(() => {
    if (!props.visible || !journalReady || props.busy) return;
    if (dualCaptionDraftsMatch(displayDrafts, sourceDrafts)) {
      void clearEditorDraftJournal(props.projectId, journalKind);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      void writeEditorDraftJournal(props.projectId, journalKind, props.baseRevision, displayDrafts)
        .then(() => { if (active) setJournalError(undefined); })
        .catch(() => { if (active) setJournalError('Dual-subtitle recovery could not be saved. Keep this editor open until you save.'); });
    }, 600);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [displayDrafts, journalKind, journalReady, props.baseRevision, props.busy, props.projectId, props.visible, sourceDrafts]);

  const edits = useMemo(() => props.pairs.flatMap((pair) => {
    const draft = displayDrafts[pair.source.id];
    if (!draft) return [];
    const primaryText = committedDualCaptionText(draft.primaryText, pair.source.text);
    const translatedText = committedDualCaptionText(draft.translatedText, pair.translation.text);
    const primaryChanged = primaryText !== pair.source.text.trim();
    const translatedChanged = translatedText !== pair.translation.text.trim();
    return primaryChanged || translatedChanged ? [{
      sourceCaptionId: pair.source.id,
      primaryText,
      translatedText,
      primaryChanged,
      translatedChanged,
    }] : [];
  }), [displayDrafts, props.pairs]);

  const needsRefresh = props.pairs.filter((pair) => (
    pair.translation.status === 'pending' || pair.translation.status === 'stale'
  ));
  const dirty = edits.length > 0;

  const requestClose = () => {
    if (props.busy || saving) return;
    if (!dirty) {
      void clearEditorDraftJournal(props.projectId, journalKind).finally(props.onClose);
      return;
    }
    Alert.alert('Discard unsaved subtitle edits?', 'Your changes in both language columns have not been saved.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => { void clearEditorDraftJournal(props.projectId, journalKind).finally(props.onClose); } },
    ]);
  };

  const save = async () => {
    if (saving || edits.length === 0) return;
    setSaving(true);
    try {
      if (await props.onSave(edits)) await clearEditorDraftJournal(props.projectId, journalKind);
    } finally {
      setSaving(false);
    }
  };

  const setDraft = (captionId: string, field: keyof DualCaptionDraft, value: string) => {
    setDrafts((current) => {
      const baseline = displayDrafts[captionId] ?? current[captionId] ?? { primaryText: '', translatedText: '' };
      return {
        ...current,
        [captionId]: {
          ...baseline,
          [field]: value,
        },
      };
    });
  };

  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={requestClose}>
      <View style={{ flex: 1, backgroundColor: chrome.background, paddingTop: insets.top }}>
        <View style={{ paddingHorizontal: 18, paddingTop: 22, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: chrome.hairline }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: chrome.text, fontSize: 28, fontWeight: '700' }}>Dual subtitles</Text>
              <Text style={{ marginTop: 4, color: chrome.muted, fontSize: 13, lineHeight: 18 }}>
                {props.sourceLanguageLabel} + {props.targetLanguageLabel} · same timing
                {props.automaticTranslation ? ', translated as a whole then cut to this rhythm' : ''}
              </Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close dual subtitle editor" disabled={props.busy} onPress={requestClose} hitSlop={10}>
              <Text style={{ color: chrome.text, fontSize: 28, lineHeight: 30 }}>×</Text>
            </Pressable>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
            <HeaderAction
              label={`${props.trackVisible ? 'Hide' : 'Show'} ${props.targetLanguageLabel} line`}
              disabled={props.busy || dirty}
              onPress={props.onToggleVisibility}
            />
            {props.automaticTranslation ? (
              <HeaderAction
                label={needsRefresh.length > 0 ? `Refresh ${needsRefresh.length}` : 'Refresh all'}
                disabled={props.busy || dirty || props.pairs.length === 0}
                onPress={() => props.onRefresh((needsRefresh.length > 0 ? needsRefresh : props.pairs).map((pair) => pair.source.id))}
              />
            ) : null}
            <HeaderAction label="Remove second language" danger disabled={props.busy || dirty} onPress={props.onRemove} />
          </View>
          <Text style={{ marginTop: 11, color: chrome.muted, fontSize: 12, lineHeight: 17 }}>
            {props.automaticTranslation
              ? 'Finish your spoken-language edits before refreshing. Saving one column updates its partner locally. If you edit both columns, Caption Studio keeps both exactly as written.'
              : 'Type the second language yourself. Automatic translation currently covers English and Chinese only. Saving keeps both columns exactly as written.'}
          </Text>
        </View>

        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 10, padding: 14, paddingBottom: 120 }}>
          {props.pairs.map((pair, index) => {
            const draft = displayDrafts[pair.source.id] ?? { primaryText: pair.source.text, translatedText: pair.translation.text };
            const refreshRequired = pair.translation.status === 'pending' || pair.translation.status === 'stale';
            return (
              <View key={pair.source.id} style={{ gap: 9, padding: 14, borderRadius: chrome.radius.lg, borderWidth: 1, borderColor: refreshRequired ? chrome.warning : chrome.hairline, backgroundColor: chrome.surface }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <Text style={{ color: chrome.accent, fontSize: 12, fontWeight: '700' }}>#{index + 1} · {formatTime(pair.startMs)}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
                    <Text style={{ color: statusColor(pair.translation.status), fontSize: 10, fontWeight: '900' }}>
                      {statusLabel(pair.translation.status)}
                    </Text>
                    {props.automaticTranslation ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Refresh translation for subtitle ${index + 1}`}
                        disabled={props.busy || dirty}
                        onPress={() => props.onRefresh([pair.source.id])}
                        hitSlop={8}>
                        <Text style={{ color: chrome.accent, fontSize: 13, fontWeight: '700' }}>Refresh</Text>
                      </Pressable>
                    ) : null}
                  </View>
                </View>
                <LanguageInput
                  label={props.sourceLanguageLabel}
                  value={draft.primaryText}
                  disabled={props.busy}
                  onChangeText={(value) => setDraft(pair.source.id, 'primaryText', value)}
                />
                <LanguageInput
                  label={props.targetLanguageLabel}
                  value={draft.translatedText}
                  disabled={props.busy}
                  placeholder="Translation pending"
                  onChangeText={(value) => setDraft(pair.source.id, 'translatedText', value)}
                />
              </View>
            );
          })}
        </ScrollView>

        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: 14, paddingBottom: Math.max(14, insets.bottom), borderTopWidth: 1, borderTopColor: chrome.hairline, backgroundColor: chrome.background }}>
          {journalError ? (
            <Text accessibilityRole="alert" selectable style={{ marginBottom: 8, color: chrome.dangerText, fontSize: 12, lineHeight: 17, textAlign: 'center' }}>
              {journalError}
            </Text>
          ) : null}
          {props.errorMessage ? (
            <Text accessibilityRole="alert" selectable style={{ marginBottom: 8, color: chrome.dangerText, fontSize: 12, lineHeight: 17, textAlign: 'center' }}>
              {props.errorMessage}
            </Text>
          ) : null}
          {props.busy ? (
            <View style={{ gap: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 7, justifyContent: 'center' }}>
                <ActivityIndicator color={chrome.accent} />
                <Text style={{ flexShrink: 1, color: chrome.text, fontSize: 13, fontWeight: '600' }}>{props.progressLabel ?? 'Translating locally…'}</Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel="Cancel local translation" onPress={props.onCancelBusy} style={{ alignItems: 'center', paddingVertical: 9 }}>
                <Text style={{ color: chrome.dangerText, fontSize: 12, fontWeight: '900' }}>CANCEL</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save dual subtitle edits"
              disabled={edits.length === 0 || saving}
              onPress={() => { void save(); }}
              style={{ alignItems: 'center', paddingVertical: 16, borderRadius: chrome.radius.lg, backgroundColor: edits.length > 0 ? chrome.accent : chrome.fill }}>
              <Text style={{ color: edits.length > 0 ? chrome.accentInk : chrome.muted, fontSize: 16, fontWeight: '700' }}>
                {edits.length > 0
                  ? `Save ${edits.length} change${edits.length === 1 ? '' : 's'}${props.automaticTranslation ? ' + sync' : ''}`
                  : 'No unsaved changes'}
              </Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

function LanguageInput(props: {
  label: string;
  value: string;
  disabled: boolean;
  placeholder?: string;
  onChangeText: (value: string) => void;
}) {
  return (
    <View style={{ gap: 5 }}>
      <Text style={{ color: chrome.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.4 }}>{props.label.toUpperCase()}</Text>
      <TextInput
        accessibilityLabel={`${props.label} subtitle text`}
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
  if (status === 'stale') return 'NEEDS REFRESH';
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
