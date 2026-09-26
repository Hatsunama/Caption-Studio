type StoredFile = {
  readonly exists: boolean;
  readonly size: number;
  delete(): void;
};

export const RESUMABLE_MODEL_SUFFIXES = [
  '.download',
  '.download.resume.json',
  '.download.resume.json.writing',
  '.download.chunk',
  '.download.chunk.offset',
] as const;

export const MODEL_STORAGE_SUFFIXES = [
  '', '.sha256', '.sha256.download', ...RESUMABLE_MODEL_SUFFIXES,
] as const;

export function storedModelBytes(
  fileName: string,
  resolve: (name: string) => StoredFile,
): number {
  return MODEL_STORAGE_SUFFIXES.reduce((total, suffix) => {
    const file = resolve(`${fileName}${suffix}`);
    return total + (file.exists ? file.size : 0);
  }, 0);
}

export function removeModelArtifacts(
  fileName: string,
  resolve: (name: string) => StoredFile,
  suffixes: readonly string[] = MODEL_STORAGE_SUFFIXES,
): void {
  for (const suffix of suffixes) {
    const file = resolve(`${fileName}${suffix}`);
    if (file.exists) file.delete();
  }
}
