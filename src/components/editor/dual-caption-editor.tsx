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

import type { CaptionPair } from '@/lib/caption-tracks';
import type { DualCaptionTextEdit } from '@/services/project-caption-translation';
import {
  clearEditorDraftJournal,
  readEditorDraftJournal,
  writeEditorDraftJournal,
  type EditorDraftKind,
} from '@/services/editor-draft-journal';

type Draft = { primaryText: string; translatedText: string };

export function DualCaptionEditor(props: {
  visible: boolean;
  projectId: string;
  baseRevision: string;
  trackId: string;
  sourceLanguageLabel: string;
  targetLanguageLabel: string;
  pairs: CaptionPair[];
  trackVisible: boolean;
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
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => (
    Object.fromEntries(props.pairs.map((pair) => [pair.source.id, {
      primaryText: pair.source.text,
      translatedText: pair.translation.text,
    }]))
  ));
  const [journalReady, setJournalReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const wasVisibleRef = useRef(false);
  const journalKind = `dual-captions-${props.trackId}` as EditorDraftKind;
  const sourceDrafts = useMemo(() => Object.fromEntries(props.pairs.map((pair) => [pair.source.id, {
    primaryText: pair.source.text,
    translatedText: pair.translation.text,
  }])), [props.pairs]);

  useEffect(() => {
    const opening = props.visible && !wasVisibleRef.current;
    wasVisibleRef.current = props.visible;
    if (!opening) return;
    setDrafts(sourceDrafts);
    setJournalReady(false);
    void readEditorDraftJournal(props.projectId, journalKind).then((journal) => {
      const recovered = decodeDualDraft(journal?.payload, props.pairs.map((pair) => pair.source.id));
      if (!recovered) {
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
          { text: 'Restore', onPress: () => { setDrafts(recovered); setJournalReady(true); } },
        ],
      );
    }).catch(() => setJournalReady(true));
  }, [journalKind, props.baseRevision, props.pairs, props.projectId, props.visible, sourceDrafts]);

  useEffect(() => {
    if (!props.visible || !journalReady || JSON.stringify(drafts) === JSON.stringify(sourceDrafts)) return;
    const timer = setTimeout(() => {
      void writeEditorDraftJournal(props.projectId, journalKind, props.baseRevision, drafts);
    }, 600);
    return () => clearTimeout(timer);
  }, [drafts, journalKind, journalReady, props.baseRevision, props.projectId, props.visible, sourceDrafts]);

  const edits = useMemo(() => props.pairs.flatMap((pair) => {
    const draft = drafts[pair.source.id];
    if (!draft) return [];
    const primaryText = draft.primaryText.trim();
    const translatedText = draft.translatedText.trim();
    const primaryChanged = primaryText !== pair.source.text.trim();
    const translatedChanged = translatedText !== pair.translation.text.trim();
    return primaryChanged || translatedChanged ? [{
      sourceCaptionId: pair.source.id,
      primaryText,
      translatedText,
      primaryChanged,
      translatedChanged,
    }] : [];
  }), [drafts, props.pairs]);

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

  const setDraft = (captionId: string, field: keyof Draft, value: string) => {
    setDrafts((current) => ({
      ...current,
      [captionId]: {
        primaryText: current[captionId]?.primaryText ?? '',
        translatedText: current[captionId]?.translatedText ?? '',
        [field]: value,
      },
    }));
  };

  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={requestClose}>
      <View style={{ flex: 1, backgroundColor: '#090B0E' }}>
        <View style={{ paddingHorizontal: 18, paddingTop: 22, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: '#242B34' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#F7F8FA', fontSize: 21, fontWeight: '900' }}>Dual subtitles</Text>
              <Text style={{ marginTop: 3, color: '#9DA8B5', fontSize: 12 }}>
                {props.sourceLanguageLabel} + {props.targetLanguageLabel} · linked by timing
              </Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close dual subtitle editor" disabled={props.busy} onPress={requestClose} hitSlop={10}>
              <Text style={{ color: '#F7F8FA', fontSize: 28, lineHeight: 30 }}>×</Text>
            </Pressable>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
            <HeaderAction
              label={`${props.trackVisible ? 'Hide' : 'Show'} ${props.targetLanguageLabel} line`}
              disabled={props.busy || dirty}
              onPress={props.onToggleVisibility}
            />
            <HeaderAction
              label={needsRefresh.length > 0 ? `Refresh ${needsRefresh.length}` : 'Refresh all'}
              disabled={props.busy || dirty || props.pairs.length === 0}
              onPress={() => props.onRefresh((needsRefresh.length > 0 ? needsRefresh : props.pairs).map((pair) => pair.source.id))}
            />
            <HeaderAction label="Remove second language" danger disabled={props.busy || dirty} onPress={props.onRemove} />
          </View>
          <Text style={{ marginTop: 11, color: '#7F8A97', fontSize: 11, lineHeight: 16 }}>
            Saving an edit in one column refreshes its partner locally. If you edit both columns, Caption Studio keeps both exactly as written.
          </Text>
        </View>

        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 10, padding: 14, paddingBottom: 120 }}>
          {props.pairs.map((pair, index) => {
            const draft = drafts[pair.source.id] ?? { primaryText: pair.source.text, translatedText: pair.translation.text };
            const refreshRequired = pair.translation.status === 'pending' || pair.translation.status === 'stale';
            return (
              <View key={pair.source.id} style={{ gap: 9, padding: 12, borderRadius: 15, borderWidth: 1, borderColor: refreshRequired ? '#FFB13B' : '#27303A', backgroundColor: '#141920' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <Text style={{ color: '#DFFF35', fontSize: 11, fontWeight: '900' }}>#{index + 1} · {formatTime(pair.startMs)}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
                    <Text style={{ color: statusColor(pair.translation.status), fontSize: 10, fontWeight: '900' }}>
                      {statusLabel(pair.translation.status)}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Refresh translation for subtitle ${index + 1}`}
                      disabled={props.busy || dirty}
                      onPress={() => props.onRefresh([pair.source.id])}
                      hitSlop={8}>
                      <Text style={{ color: '#64E8FF', fontSize: 12, fontWeight: '900' }}>REFRESH</Text>
                    </Pressable>
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

        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: 14, borderTopWidth: 1, borderTopColor: '#242B34', backgroundColor: '#0D1014' }}>
          {props.errorMessage ? (
            <Text accessibilityRole="alert" selectable style={{ marginBottom: 8, color: '#FF8C9D', fontSize: 12, lineHeight: 17, textAlign: 'center' }}>
              {props.errorMessage}
            </Text>
          ) : null}
          {props.busy ? (
            <View style={{ gap: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 7, justifyContent: 'center' }}>
                <ActivityIndicator color="#DFFF35" />
                <Text style={{ flexShrink: 1, color: '#F7F8FA', fontSize: 13, fontWeight: '800' }}>{props.progressLabel ?? 'Translating locally…'}</Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel="Cancel local translation" onPress={props.onCancelBusy} style={{ alignItems: 'center', paddingVertical: 9 }}>
                <Text style={{ color: '#FF8C9D', fontSize: 12, fontWeight: '900' }}>CANCEL</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save dual subtitle edits"
              disabled={edits.length === 0 || saving}
              onPress={() => { void save(); }}
              style={{ alignItems: 'center', paddingVertical: 15, borderRadius: 14, backgroundColor: edits.length > 0 ? '#DFFF35' : '#30363D' }}>
              <Text style={{ color: edits.length > 0 ? '#10130A' : '#88929E', fontSize: 14, fontWeight: '900' }}>
                {edits.length > 0 ? `Save ${edits.length} change${edits.length === 1 ? '' : 's'} + sync` : 'No unsaved changes'}
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
      <Text style={{ color: '#AAB4C0', fontSize: 9, fontWeight: '900', letterSpacing: 0.8 }}>{props.label.toUpperCase()}</Text>
      <TextInput
        accessibilityLabel={`${props.label} subtitle text`}
        value={props.value}
        editable={!props.disabled}
        multiline
        placeholder={props.placeholder}
        placeholderTextColor="#66717D"
        onChangeText={props.onChangeText}
        style={{ minHeight: 54, paddingHorizontal: 11, paddingVertical: 9, borderRadius: 10, color: '#F7F8FA', backgroundColor: '#20262E', fontSize: 15, lineHeight: 21, textAlignVertical: 'top' }}
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
      style={{ paddingHorizontal: 11, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: props.danger ? '#743643' : '#35404C', opacity: props.disabled ? 0.45 : 1 }}>
      <Text style={{ color: props.danger ? '#FF8C9D' : '#DCE2E9', fontSize: 11, fontWeight: '800' }}>{props.label}</Text>
    </Pressable>
  );
}

function statusLabel(status: CaptionPair['translation']['status']) {
  if (status === 'reviewed') return 'REVIEWED';
  if (status === 'translated') return 'LOCAL TRANSLATION';
  if (status === 'stale') return 'NEEDS REFRESH';
  return 'PENDING';
}

function statusColor(status: CaptionPair['translation']['status']) {
  if (status === 'reviewed') return '#19D98B';
  if (status === 'translated') return '#64E8FF';
  return '#FFB13B';
}

function formatTime(milliseconds: number) {
  const totalSeconds = Math.max(0, milliseconds) / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}

function decodeDualDraft(value: unknown, allowedIds: string[]): Record<string, Draft> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = new Set(allowedIds);
  const entries = Object.entries(value);
  if (entries.length > allowed.size || entries.some(([id]) => !allowed.has(id))) return null;
  const valid = entries.every(([, draft]) => {
    if (!draft || typeof draft !== 'object') return false;
    const candidate = draft as Partial<Draft>;
    return typeof candidate.primaryText === 'string' && typeof candidate.translatedText === 'string';
  });
  return valid ? value as Record<string, Draft> : null;
}
