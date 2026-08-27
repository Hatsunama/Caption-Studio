export type PickedMediaKind = 'image' | 'video' | 'unknown';

const IMAGE_EXTENSIONS = new Set([
  'avif',
  'bmp',
  'gif',
  'heic',
  'heif',
  'jpeg',
  'jpg',
  'png',
  'webp',
]);

const VIDEO_EXTENSIONS = new Set([
  '3g2',
  '3gp',
  'avi',
  'm2ts',
  'm4v',
  'mkv',
  'mov',
  'mp4',
  'mpeg',
  'mpg',
  'ts',
  'webm',
]);

export function classifyPickedMedia(mimeType: string | undefined, fileName: string): PickedMediaKind {
  const normalizedMime = mimeType?.trim().toLowerCase();
  if (normalizedMime?.startsWith('image/')) return 'image';
  if (normalizedMime?.startsWith('video/')) return 'video';

  const extension = fileName.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase();
  if (!extension) return 'unknown';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return 'unknown';
}
