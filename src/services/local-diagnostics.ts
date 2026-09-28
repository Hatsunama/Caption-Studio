import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import CaptionDiagnostics, { type NativeProcessExitRecord } from 'caption-diagnostics';

import { mergeBoundedExitRecords, type LocalProcessExitRecord } from '@/lib/diagnostic-redaction';

const RECORD_LIMIT = 20;
const DIAGNOSTIC_FILE = 'caption-studio-exit-diagnostics.json';
const SHARED_DIAGNOSTIC_PREFIX = 'caption-studio-sanitized-diagnostics-';
const SHARED_DIAGNOSTIC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const activeDiagnosticShares = new Set<string>();
let diagnosticShareSequence = 0;

export async function captureHistoricalProcessExits(): Promise<LocalProcessExitRecord[]> {
  const existing = await readLocalProcessExits();
  const incoming = await CaptionDiagnostics.getHistoricalExitReasons(32).catch(
    () => [] as NativeProcessExitRecord[],
  );
  const merged = mergeBoundedExitRecords(existing, incoming, RECORD_LIMIT);
  await writeLocalProcessExits(merged);
  return merged;
}

export async function readLocalProcessExits(): Promise<LocalProcessExitRecord[]> {
  const uri = diagnosticFileUri();
  if (!uri) return [];
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists || info.isDirectory) return [];
  try {
    const parsed: unknown = JSON.parse(await FileSystem.readAsStringAsync(uri));
    return Array.isArray(parsed) ? mergeBoundedExitRecords([], parsed, RECORD_LIMIT) : [];
  } catch {
    return [];
  }
}

export async function shareLocalProcessExits() {
  if (!FileSystem.documentDirectory) throw new Error('Diagnostic sharing storage is unavailable.');
  if (!await Sharing.isAvailableAsync()) throw new Error('Android file sharing is unavailable.');
  const directory = `${FileSystem.documentDirectory}diagnostic-shares/`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  await pruneOldDiagnosticShares(directory);
  const records = await captureHistoricalProcessExits();
  const uri = `${directory}${SHARED_DIAGNOSTIC_PREFIX}${Date.now()}-${diagnosticShareSequence++}.json`;
  activeDiagnosticShares.add(uri);
  try {
    await FileSystem.writeAsStringAsync(uri, JSON.stringify({ schemaVersion: 1, records }, null, 2));
    await Sharing.shareAsync(uri, {
      mimeType: 'application/json',
      dialogTitle: 'Share sanitized Caption Studio diagnostics',
      UTI: 'public.json',
    });
  } finally {
    activeDiagnosticShares.delete(uri);
  }
}

async function pruneOldDiagnosticShares(directory: string, nowMs = Date.now()) {
  let names: string[];
  try {
    names = await FileSystem.readDirectoryAsync(directory);
  } catch {
    return;
  }
  await Promise.allSettled(names.map(async (name) => {
    if (!/^caption-studio-sanitized-diagnostics-\d{13}-\d+\.json$/.test(name)) return;
    const uri = `${directory}${name}`;
    if (activeDiagnosticShares.has(uri)) return;
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists && !info.isDirectory && typeof info.modificationTime === 'number'
      && nowMs - info.modificationTime * 1000 > SHARED_DIAGNOSTIC_MAX_AGE_MS) {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    }
  }));
}

async function writeLocalProcessExits(records: LocalProcessExitRecord[]) {
  const uri = diagnosticFileUri();
  if (uri) await FileSystem.writeAsStringAsync(uri, JSON.stringify(records));
}

function diagnosticFileUri() {
  return FileSystem.documentDirectory ? `${FileSystem.documentDirectory}${DIAGNOSTIC_FILE}` : null;
}
