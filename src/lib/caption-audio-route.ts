import type { CaptionProject } from '@/types/project';

export function shouldTranscribeAudibleTimeline(
  project: Pick<CaptionProject, 'clips' | 'audioClips'>,
): boolean {
  return project.clips.length > 1
    || project.audioClips.some((clip) => !clip.muted && clip.volume > 0)
    || project.clips.some((clip) => clip.muted || clip.volume !== 1);
}
