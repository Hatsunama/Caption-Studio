import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import CaptionDiagnostics, { type NativeProcessExitRecord } from 'caption-diagnostics';

import { mergeBoundedExitRecords, type LocalProcessExitRecord } from '@/lib/diagnostic-redaction';

const RECORD_LIMIT = 20;
const DIAGNOSTIC_FILE = 'caption-studio-exit-diagnostics.json';

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
  if (!FileSystem.cacheDirectory) throw new Error('Diagnostic sharing storage is unavailable.');
  if (!await Sharing.isAvailableAsync()) throw new Error('Android file sharing is unavailable.');
  const records = await captureHistoricalProcessExits();
  const uri = `${FileSystem.cacheDirectory}caption-studio-sanitized-diagnostics.json`;
  try {
    await FileSystem.writeAsStringAsync(uri, JSON.stringify({ schemaVersion: 1, records }, null, 2));
    await Sharing.shareAsync(uri, {
      mimeType: 'application/json',
      dialogTitle: 'Share sanitized Caption Studio diagnostics',
      UTI: 'public.json',
    });
  } finally {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
  }
}

async function writeLocalProcessExits(records: LocalProcessExitRecord[]) {
  const uri = diagnosticFileUri();
  if (uri) await FileSystem.writeAsStringAsync(uri, JSON.stringify(records));
}

function diagnosticFileUri() {
  return FileSystem.documentDirectory ? `${FileSystem.documentDirectory}${DIAGNOSTIC_FILE}` : null;
}
