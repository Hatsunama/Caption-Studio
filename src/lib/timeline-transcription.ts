import { buildClipTimeline, sourceTimeAt } from '@/lib/video-timeline';
import type { CaptionProject } from '@/types/project';

/** Restore media ownership without treating mixed audio as a source transcript. */
export function restoreTimelineTranscription<T extends CaptionProject>(project: CaptionProject, generated: T): T {
  // Source checkpoints have not published new timeline words/captions yet.
  const complete = generated.transcription.words !== project.transcription.words;
  const entryById = new Map(buildClipTimeline(project.clips).map((entry) => [entry.clip.id, entry]));
  return {
    ...generated,
    sources: project.sources,
    clips: project.clips,
    audioSources: project.audioSources,
    audioClips: project.audioClips,
    transcription: complete ? {
      ...generated.transcription,
      wordTiming: 'timeline',
      sourceResults: project.transcription.sourceResults,
    } : project.transcription,
    captions: complete ? generated.captions.map((caption) => {
      const anchor = caption.sourceAnchor;
      const entry = anchor && entryById.get(anchor.clipId);
      if (!anchor || !entry) return caption;
      return {
        ...caption,
        sourceAnchor: {
          ...anchor,
          sourceStartMs: sourceTimeAt(entry, anchor.sourceStartMs),
          sourceEndMs: sourceTimeAt(entry, anchor.sourceEndMs),
        },
      };
    }) : project.captions,
  };
}
