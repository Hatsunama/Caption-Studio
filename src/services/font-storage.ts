import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Font from 'expo-font';

import CaptionMedia from 'caption-media';
import type { FontChoice } from '@/lib/font-catalog';
import { getDatabase } from '@/services/database';
import { readPreference, writePreference } from '@/services/preferences';
import { requireFreeSpace } from '@/services/storage-policy';

const FAVORITES_KEY = 'font-favorites';
const RECENT_KEY = 'font-recent';
const MAX_IMPORTED_FONT_BYTES = 25 * 1024 * 1024;

const FONT_MIME_TYPES = [
  'font/ttf',
  'font/otf',
  'application/x-font-ttf',
  'application/x-font-opentype',
  'application/vnd.ms-opentype',
];

export async function loadFontLibrary() {
  const database = await getDatabase();
  const rows = await database.getAllAsync<{ font_json: string }>(
    'SELECT font_json FROM imported_fonts ORDER BY imported_at DESC',
  );
  const imported: FontChoice[] = [];
  for (const row of rows) {
    try {
      const choice = JSON.parse(row.font_json) as FontChoice;
      if (choice.font.source !== 'imported' || !choice.font.uri) continue;
      await Font.loadAsync({ [choice.font.family]: choice.font.uri });
      imported.push(choice);
    } catch (error) {
      console.error('Skipped an imported font that could not be loaded', error);
    }
  }
  return {
    imported,
    favorites: await readStringList(FAVORITES_KEY, ['bungee', 'monoton', 'rubik-glitch']),
    recent: await readStringList(RECENT_KEY, []),
  };
}

export async function saveImportedFont(choice: FontChoice) {
  const database = await getDatabase();
  await database.runAsync(
    `INSERT INTO imported_fonts (id, font_json, imported_at)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET font_json = excluded.font_json`,
    choice.font.id,
    JSON.stringify(choice),
    new Date().toISOString(),
  );
}

export async function importFontFromDevice(): Promise<FontChoice | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: FONT_MIME_TYPES,
    copyToCacheDirectory: false,
    multiple: false,
  });
  if (result.canceled) return null;

  const asset = result.assets[0];
  if (!FileSystem.documentDirectory) {
    throw new Error('Permanent app storage is unavailable on this device.');
  }

  const extensionMatch = asset.name.toLowerCase().match(/\.(ttf|otf)$/);
  if (!extensionMatch) throw new Error('Choose a TTF or OTF font file.');
  if (asset.size != null && asset.size > MAX_IMPORTED_FONT_BYTES) {
    throw new Error('This font is larger than the 25 MB import limit. Choose an optimized TTF or OTF file.');
  }
  await requireFreeSpace((asset.size ?? MAX_IMPORTED_FONT_BYTES) + 16 * 1024 * 1024, 'import this font');
  const extension = `.${extensionMatch[1]}`;
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const family = `imported-${nonce}`;
  const directory = `${FileSystem.documentDirectory}fonts/`;
  const destinationUri = `${directory}${family}${extension}`;
  const stagingUri = `${directory}.staging-${nonce}${extension}`;
  let committed = false;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });

  try {
    await FileSystem.copyAsync({ from: asset.uri, to: stagingUri });
    const staged = await FileSystem.getInfoAsync(stagingUri);
    if (!staged.exists || staged.isDirectory || staged.size < 1_024) {
      throw new Error('The selected font file is incomplete.');
    }
    if (staged.size > MAX_IMPORTED_FONT_BYTES) {
      throw new Error('This font is larger than the 25 MB import limit. Choose an optimized TTF or OTF file.');
    }
    await CaptionMedia.validateFontFile(stagingUri);
    const existing = await FileSystem.getInfoAsync(destinationUri);
    if (existing.exists) throw new Error('Caption Studio could not allocate a unique font file. Try again.');
    await FileSystem.moveAsync({ from: stagingUri, to: destinationUri });
    await Font.loadAsync({ [family]: destinationUri });
    const name = asset.name.replace(/\.(ttf|otf)$/i, '');
    const choice: FontChoice = {
      font: {
        id: family,
        family,
        source: 'imported',
        uri: destinationUri,
        postScriptName: name,
      },
      name,
      mood: 'Your imported font',
      treatment: 'solid',
    };
    await saveImportedFont(choice);
    committed = true;
    return choice;
  } catch (error) {
    throw error;
  } finally {
    await FileSystem.deleteAsync(stagingUri, { idempotent: true }).catch(() => undefined);
    if (!committed) {
      await FileSystem.deleteAsync(destinationUri, { idempotent: true }).catch(() => undefined);
    }
  }
}

export async function saveFontFavorites(ids: string[]) {
  await writeStringList(FAVORITES_KEY, ids);
}

export async function saveRecentFonts(ids: string[]) {
  await writeStringList(RECENT_KEY, ids.slice(0, 8));
}

async function readStringList(key: string, fallback: string[]) {
  const value: unknown = await readPreference(key, fallback);
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : fallback;
}

async function writeStringList(key: string, value: string[]) {
  await writePreference(key, value);
}
