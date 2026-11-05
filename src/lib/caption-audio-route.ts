import type { CaptionProject } from '@/types/project';
import { isAudibleVideoOverlay } from '@/lib/audible-video-overlays';

export function shouldTranscribeAudibleTimeline(
  project: Pick<CaptionProject, 'clips' | 'audioClips'> & Partial<Pick<CaptionProject, 'layers'>>,
): boolean {
  return project.clips.length > 1
    || Boolean(project.layers?.some(isAudibleVideoOverlay))
    || project.audioClips.some((clip) => !clip.muted && clip.volume > 0)
    || project.clips.some((clip) => clip.muted || clip.volume !== 1);
}
