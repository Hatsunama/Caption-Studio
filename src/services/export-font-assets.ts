import { Asset } from 'expo-asset';

import { FONT_ASSETS } from '@/lib/font-catalog';
import type { ResolvedFontUris } from '@/lib/export-render-plan';

export async function resolveExportFontUris(families: readonly string[]): Promise<ResolvedFontUris> {
  const resolved = new Map<string, string>();
  await Promise.all([...new Set(families)].map(async (family) => {
    if (!Object.hasOwn(FONT_ASSETS, family)) {
      throw new Error(`The bundled ${family} font is not available in this build.`);
    }
    const asset = Asset.fromModule(FONT_ASSETS[family]);
    if (!asset.localUri) await asset.downloadAsync();
    const uri = asset.localUri ?? asset.uri;
    if (!uri) throw new Error(`The ${family} font could not be prepared for export.`);
    resolved.set(family, uri);
  }));
  return resolved;
}
