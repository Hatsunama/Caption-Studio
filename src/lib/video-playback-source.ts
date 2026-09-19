import type { ProjectVideoSource } from '@/types/project';

export function videoPlaybackUri(source: Pick<ProjectVideoSource, 'uri' | 'previewUri'>) {
  return source.previewUri ?? source.uri;
}
