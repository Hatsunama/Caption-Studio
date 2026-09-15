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

export const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const journalOperations = createKeyedOperationQueue();

type JournalSource = 'primary' | 'previous';
type JournalErrorCode = 'oversized' | 'corrupt' | 'unavailable';
type JournalReadFailure = { source: JournalSource; code: JournalErrorCode; message: string };
type JournalReadReason = JournalReadFailure | { source: JournalSource; code: 'missing'; message: string };
export type EditorDraftJournalRecovery = {
  source: JournalSource;
  failures: JournalReadFailure[];
  warning?: string;
};
type EditorDraftJournalRead = EditorDraftJournal & { recovery: EditorDraftJournalRecovery };

export class EditorDraftJournalError extends Error {
  constructor(public readonly code: JournalErrorCode, message: string, public readonly reasons: JournalReadReason[] = []) {
    super(message);
    this.name = 'EditorDraftJournalError';
  }
}

// Count UTF-8 without allocating a second, potentially multi-megabyte buffer.
// Unpaired UTF-16 surrogates encode as the three-byte replacement character.
function utf8Bytes(value: string) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff
      && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function checkByteBudget(bytes: number) {
  if (bytes > MAX_JOURNAL_BYTES) throw new EditorDraftJournalError('oversized',
    'The recovery draft exceeds the 4 MiB UTF-8 limit. Existing recovery data is preserved. Keep the editor open until you save your current edits.');
}

function corruptJournal(): never {
  throw new EditorDraftJournalError('corrupt',
    'The recovery draft is corrupt or incompatible. It has been preserved; automatic recovery saving is paused.');
}

async function readJournalFile(uri: string, projectId: string, kind: EditorDraftKind): Promise<EditorDraftJournal | null> {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) return null;
  if (info.isDirectory) return corruptJournal();
  checkByteBudget(info.size ?? 0);
  const raw = await FileSystem.readAsStringAsync(uri);
  checkByteBudget(utf8Bytes(raw));
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return corruptJournal(); }
  if (!value || typeof value !== 'object') return corruptJournal();
  const record = value as Partial<EditorDraftJournal>;
  if (record.schemaVersion !== 1 || record.projectId !== projectId || record.kind !== kind
    || typeof record.baseRevision !== 'string' || typeof record.savedAt !== 'string'
    || !Object.hasOwn(record, 'payload')) return corruptJournal();
  return record as EditorDraftJournal;
}

async function readJournalCandidate(uri: string, projectId: string, kind: EditorDraftKind, source: JournalSource) {
  try {
    const journal = await readJournalFile(uri, projectId, kind);
    return journal ? { journal } : { reason: { source, code: 'missing', message: 'No recovery file exists.' } satisfies JournalReadReason };
  } catch (caught) {
    return { reason: { source, code: caught instanceof EditorDraftJournalError ? caught.code : 'unavailable',
      message: caught instanceof Error ? caught.message : 'Recovery file could not be read.' } satisfies JournalReadReason };
  }
}

async function readEditorDraftJournalUnqueued(projectId: string, kind: EditorDraftKind): Promise<EditorDraftJournalRead | null> {
  const uri = journalUri(projectId, kind);
  if (!uri) throw new EditorDraftJournalError('unavailable', 'Recovery draft storage is unavailable. Keep the editor open and retry saving.');
  const primary = await readJournalCandidate(uri, projectId, kind, 'primary');
  const previous = await readJournalCandidate(`${uri}.previous`, projectId, kind, 'previous');
  const reasons = [primary.reason, previous.reason].filter((reason): reason is JournalReadReason => !!reason);
  const failures = reasons.filter((reason): reason is JournalReadFailure => reason.code !== 'missing');
  const journal = primary.journal ?? previous.journal;
  const detail = failures.map((reason) => `${reason.source} (${reason.code}): ${reason.message}`).join(' ');
  if (!journal) {
    const failure = failures[0];
    if (failure) throw new EditorDraftJournalError(failure.code,
      `Neither recovery copy could be recovered. ${detail} Existing recovery files are preserved; automatic recovery saving is paused.`, reasons);
    return null;
  }
  const source = primary.journal ? 'primary' : 'previous';
  const provenance = source === 'previous' ? 'Recovered the .previous backup because the primary recovery file is missing or unreadable.' : '';
  const warning = [provenance, failures.length
    ? `${detail} Both recovery files are preserved; automatic recovery saving and cleanup are paused. Save current edits to the project before closing.` : ''].filter(Boolean).join(' ') || undefined;
  return { ...journal, recovery: { source, failures, warning } };
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
  checkByteBudget(utf8Bytes(encoded));
  // Refuse to replace an unreadable journal even if a caller skipped recovery.
  const existing = await readEditorDraftJournalUnqueued(projectId, kind);
  const recovery = existing?.recovery;
  const failure = recovery?.failures[0];
  if (recovery && failure) throw new EditorDraftJournalError(failure.code, recovery.warning ?? failure.message, recovery.failures);
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const staging = `${uri}.writing`;
  await FileSystem.writeAsStringAsync(staging, encoded);
  const previous = `${uri}.previous`;
  // Expo's iOS move removes its destination first. Move only to an empty
  // destination: the project queue gives atomic visibility to live readers,
  // and .previous gives old-or-new recovery across process interruption.
  if ((await FileSystem.getInfoAsync(uri)).exists) {
    if ((await FileSystem.getInfoAsync(previous)).exists) await FileSystem.deleteAsync(previous, { idempotent: true });
    await FileSystem.moveAsync({ from: uri, to: previous });
  }
  await FileSystem.moveAsync({ from: staging, to: uri });
  if ((await FileSystem.getInfoAsync(previous)).exists) await FileSystem.deleteAsync(previous, { idempotent: true });
}

async function clearEditorDraftJournalUnqueued(projectId: string, kind: EditorDraftKind) {
  const uri = journalUri(projectId, kind);
  if (uri) {
    // Delete fallback first so an interrupted explicit clear cannot resurrect it.
    await FileSystem.deleteAsync(`${uri}.previous`, { idempotent: true });
    await FileSystem.deleteAsync(uri, { idempotent: true });
  }
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
  return journalOperations(safe(projectId), () => readEditorDraftJournalUnqueued(projectId, kind));
}
export function writeEditorDraftJournal(projectId: string, kind: EditorDraftKind, baseRevision: string, payload: unknown) {
  return journalOperations(safe(projectId), () => writeEditorDraftJournalUnqueued(projectId, kind, baseRevision, payload));
}
export function clearEditorDraftJournal(projectId: string, kind: EditorDraftKind) {
  return journalOperations(safe(projectId), () => clearEditorDraftJournalUnqueued(projectId, kind));
}

// Share the project queue with every journal kind so pending writes finish before
// lifecycle cleanup enumerates files, including staging files left by failed writes.
export function clearProjectEditorDraftJournals(projectId: string) {
  return journalOperations(safe(projectId), async () => {
    const directory = journalDirectoryUri();
    if (!directory) return;
    const info = await FileSystem.getInfoAsync(directory);
    if (!info.exists || !info.isDirectory) return;
    const prefix = `${safe(projectId)}-`;
    const entries = await FileSystem.readDirectoryAsync(directory);
    const results = await Promise.allSettled(entries
      .filter((name) => name.startsWith(prefix)
        && /^(caption-script|dual-captions-[a-zA-Z0-9_-]*)\.json(\.(writing|previous))?$/.test(name.slice(prefix.length)))
      .map(async (name) => {
        const uri = `${directory}${name}`;
        const entry = await FileSystem.getInfoAsync(uri);
        if (!entry.exists || entry.isDirectory) return;
        const raw = await FileSystem.readAsStringAsync(uri);
        let record: unknown;
        try {
          record = JSON.parse(raw);
        } catch {
          // Interrupted writes may leave invalid JSON; the filename still scopes cleanup.
        }
        // Legacy sanitized filenames can overlap another project's namespace.
        if (record && typeof record === 'object' && 'projectId' in record && record.projectId !== projectId) return;
        await FileSystem.deleteAsync(uri, { idempotent: true });
      }));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  });
}
