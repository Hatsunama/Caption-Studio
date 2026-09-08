import { useEffect, useMemo, useRef } from 'react';

import { audioClipEnd, audioClipVolume } from '@/lib/audio-timeline';
import { TimelineAudioPlaybackController } from '@/services/timeline-audio-playback';
import { createTimelineAudioPlayer, prepareTimelineAudioRuntime } from '@/services/timeline-audio-runtime';
import type { CaptionProject } from '@/types/project';

export function useTimelineAudioController(
  project: CaptionProject,
  currentMs: number,
  isPlaying: boolean,
  admitted = true,
  onError: (message: string) => void = () => {},
) {
  const controllerRef = useRef<TimelineAudioPlaybackController | undefined>(undefined);
  const sourceById = useMemo(
    () => new Map(project.audioSources.map((source) => [source.id, source])),
    [project.audioSources],
  );
  const targets = useMemo(
    () => admitted ? project.audioClips.flatMap((clip) => {
      if (currentMs < clip.startMs || currentMs >= audioClipEnd(clip)) return [];
      const source = sourceById.get(clip.sourceId);
      if (!source) return [];
      return [{
        clipId: clip.id,
        sourceId: source.id,
        uri: source.uri,
        targetSeconds: (clip.sourceStartMs + currentMs - clip.startMs) / 1_000,
        volume: audioClipVolume(clip, currentMs),
        muted: clip.muted,
        playing: isPlaying,
      }];
    }) : [],
    [admitted, currentMs, isPlaying, project.audioClips, sourceById],
  );

  useEffect(() => {
    const controller = new TimelineAudioPlaybackController({
      createPlayer: createTimelineAudioPlayer,
      preparePlayback: prepareTimelineAudioRuntime,
      onError: () => onError('Timeline audio preview could not start. Android could not configure shared video and audio playback. The exported audio is unchanged.'),
    });
    controllerRef.current = controller;
    return () => {
      if (controllerRef.current === controller) controllerRef.current = undefined;
      controller.dispose();
    };
  }, [onError]);

  useEffect(() => {
    controllerRef.current?.synchronize(targets);
  }, [targets]);
}
