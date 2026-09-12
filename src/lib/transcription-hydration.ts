import { anchorCaptionsToClips, mapSourceWordsToTimeline, recoverCanonicalSourceWords } from '@/lib/video-timeline';
import type { CaptionProject, VideoClip } from '@/types/project';

/** Recover legacy source timing only when it reproduces every timeline word. */
export function hydrateProjectTranscription(project: CaptionProject, clips: VideoClip[]) {
  const transcription = project.transcription;
  const persisted = transcription.sourceResults ?? {};
  if (transcription.wordTiming === 'timeline' || Object.keys(persisted).length > 0) {
    return {
      transcription,
      captions: anchorCaptionsToClips(project.captions, clips, transcription.words),
    };
  }

  const recovered = recoverCanonicalSourceWords(clips, transcription.words);
  if (Object.keys(recovered).length === 0) {
    return {
      transcription,
      captions: anchorCaptionsToClips(project.captions, clips, transcription.words),
    };
  }
  const words = mapSourceWordsToTimeline(clips, recovered);
  const aliases = new Map(transcription.words.map((word, index) => [word.id, words[index].id]));
  const remapIds = (ids: string[]) => ids.map((id) => aliases.get(id) ?? id);
  const captions = project.captions.map((caption) => ({
    ...caption,
    wordIds: remapIds(caption.wordIds),
    sourceAnchor: caption.sourceAnchor && {
      ...caption.sourceAnchor,
      wordIds: remapIds(caption.sourceAnchor.wordIds),
    },
  }));
  return {
    transcription: {
      ...transcription,
      words,
      sourceResults: Object.fromEntries(Object.entries(recovered).map(([sourceId, sourceWords]) => [sourceId, {
        language: transcription.language,
        modelId: transcription.modelId,
        generatedAt: transcription.generatedAt ?? project.updatedAt,
        words: sourceWords,
      }])),
    },
    captions: anchorCaptionsToClips(captions, clips, words),
  };
}
