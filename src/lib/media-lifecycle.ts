import type { CaptionProject } from '@/types/project';

export type ProjectOwnedAssetLedger = Readonly<{
  uris: readonly string[];
}>;

export type LinkedMediaPermissionLedger = Readonly<{
  uris: readonly string[];
}>;

export function collectLinkedMediaUris(project: CaptionProject): string[] {
  const uris = project.sources
    .filter((source) => source.storageMode === 'linked')
    .map((source) => source.uri);
  const background = project.backgroundReplacement.source;
  if (background?.storageMode === 'linked') uris.push(background.uri);
  return uniqueUris(uris);
}

export function collectProjectOwnedUris(project: CaptionProject): string[] {
  return uniqueUris([
    ...project.sources.flatMap((source) => [
      source.storageMode === 'copied' ? source.uri : undefined,
      source.thumbnailUri,
    ]),
    ...project.audioSources
      .filter((source) => source.storageMode === 'copied')
      .map((source) => source.uri),
    ...project.layers.map((layer) => layer.kind === 'image' ? layer.uri : undefined),
    project.backgroundReplacement.source?.storageMode === 'copied'
      ? project.backgroundReplacement.source.uri
      : undefined,
  ]);
}

export function abandonedProjectOwnedUris(
  fromProject: CaptionProject,
  retainedProject: CaptionProject,
): string[] {
  const retained = new Set(collectProjectOwnedUris(retainedProject));
  return collectProjectOwnedUris(fromProject).filter((uri) => !retained.has(uri));
}

export function createProjectOwnedAssetLedger(
  initialProject: CaptionProject,
): ProjectOwnedAssetLedger {
  return { uris: collectProjectOwnedUris(initialProject) };
}

export function trackProjectOwnedAssets(
  ledger: ProjectOwnedAssetLedger,
  uris: Iterable<string | undefined>,
): ProjectOwnedAssetLedger {
  return { uris: uniqueUris([...ledger.uris, ...uris]) };
}

export function abandonedLedgerAssets(
  ledger: ProjectOwnedAssetLedger,
  retainedProject: CaptionProject,
): string[] {
  const retained = new Set(collectProjectOwnedUris(retainedProject));
  return ledger.uris.filter((uri) => !retained.has(uri));
}

export function createLinkedMediaPermissionLedger(
  initialProject: CaptionProject,
): LinkedMediaPermissionLedger {
  return { uris: collectLinkedMediaUris(initialProject) };
}

export function trackLinkedMediaPermissions(
  ledger: LinkedMediaPermissionLedger,
  uris: Iterable<string | undefined>,
): LinkedMediaPermissionLedger {
  return { uris: uniqueUris([...ledger.uris, ...uris]).filter(isAndroidContentUri) };
}

export function abandonedLinkedMediaPermissions(
  ledger: LinkedMediaPermissionLedger,
  retainedProject: CaptionProject,
): string[] {
  const retained = new Set(collectLinkedMediaUris(retainedProject));
  return ledger.uris.filter((uri) => !retained.has(uri));
}

export function unreferencedLinkedMediaUris(
  candidates: Iterable<string>,
  projects: Iterable<CaptionProject>,
): string[] {
  const referenced = new Set(
    [...projects].flatMap((project) => collectLinkedMediaUris(project)),
  );
  return uniqueUris(candidates)
    .filter(isAndroidContentUri)
    .filter((uri) => !referenced.has(uri));
}

function uniqueUris(uris: Iterable<string | undefined>): string[] {
  return [...new Set([...uris].filter((uri): uri is string => Boolean(uri)))];
}

function isAndroidContentUri(uri: string): boolean {
  return uri.startsWith('content:');
}
