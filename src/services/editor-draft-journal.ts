import { createKeyedOperationQueue } from '@/lib/keyed-operation-queue';
import * as FileSystem from 'expo-file-system/legacy';

export type EditorDraftKind = 'caption-script' | `dual-captions-${string}`;

export type EditorDraftJournal = {
  schemaVersion: 1;
  projectId: string;
  kind: EditorDraftKind;
  baseRevision: string;
  savedAt: string;
  payload: unknown;
};

const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const journalOperations = createKeyedOperationQueue();

async function readEditorDraftJournalUnqueued(projectId: string, kind: EditorDraftKind) {
  const uri = journalUri(projectId, kind);
  if (!uri) return null;
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists || info.isDirectory || (info.size ?? 0) > MAX_JOURNAL_BYTES) return null;
  const raw = await FileSystem.readAsStringAsync(uri);
  try {
    if (raw.length > MAX_JOURNAL_BYTES) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const record = value as Partial<EditorDraftJournal>;
    if (record.schemaVersion !== 1 || record.projectId !== projectId || record.kind !== kind
      || typeof record.baseRevision !== 'string' || typeof record.savedAt !== 'string') return null;
    return record as EditorDraftJournal;
  } catch {
    return null;
  }
}

async function writeEditorDraftJournalUnqueued(
  projectId: string,
  kind: EditorDraftKind,
  baseRevision: string,
  payload: unknown,
) {
  const directory = journalDirectoryUri();
  const uri = journalUri(projectId, kind);
  if (!directory || !uri) throw new Error('Recovery draft storage is unavailable. Keep the editor open and retry saving.');
  const encoded = JSON.stringify({
    schemaVersion: 1,
    projectId,
    kind,
    baseRevision,
    savedAt: new Date().toISOString(),
    payload,
  } satisfies EditorDraftJournal);
  if (encoded.length > MAX_JOURNAL_BYTES) throw new Error('This editor recovery draft is too large to save safely.');
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const staging = `${uri}.writing`;
  await FileSystem.writeAsStringAsync(staging, encoded);
  await FileSystem.moveAsync({ from: staging, to: uri });
}

async function clearEditorDraftJournalUnqueued(projectId: string, kind: EditorDraftKind) {
  const uri = journalUri(projectId, kind);
  if (uri) await FileSystem.deleteAsync(uri, { idempotent: true });
}

function journalDirectoryUri() {
  return FileSystem.documentDirectory ? `${FileSystem.documentDirectory}editor-drafts/` : null;
}

function journalUri(projectId: string, kind: EditorDraftKind) {
  const directory = journalDirectoryUri();
  return directory ? `${directory}${safe(projectId)}-${safe(kind)}.json` : null;
}

function safe(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 160);
}

export function readEditorDraftJournal(projectId: string, kind: EditorDraftKind) {
  return journalOperations(journalUri(projectId, kind) ?? projectId, () => readEditorDraftJournalUnqueued(projectId, kind));
}
export function writeEditorDraftJournal(projectId: string, kind: EditorDraftKind, baseRevision: string, payload: unknown) {
  return journalOperations(journalUri(projectId, kind) ?? projectId, () => writeEditorDraftJournalUnqueued(projectId, kind, baseRevision, payload));
}
export function clearEditorDraftJournal(projectId: string, kind: EditorDraftKind) {
  return journalOperations(journalUri(projectId, kind) ?? projectId, () => clearEditorDraftJournalUnqueued(projectId, kind));
}
