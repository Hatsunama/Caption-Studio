import { createAudioPlayer } from 'expo-audio';
import { useEffect, useMemo, useRef } from 'react';

import { audioClipEnd, audioClipVolume } from '@/lib/audio-timeline';
import { TimelineAudioPlaybackController } from '@/services/timeline-audio-playback';
import type { CaptionProject } from '@/types/project';

export function useTimelineAudioController(
  project: CaptionProject,
  currentMs: number,
  isPlaying: boolean,
  admitted = true,
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
    const controller = new TimelineAudioPlaybackController(
      (uri) => createAudioPlayer(uri, { updateInterval: 250 }),
      (error) => console.warn('Timeline audio preview could not synchronize.', error),
    );
    controllerRef.current = controller;
    return () => {
      if (controllerRef.current === controller) controllerRef.current = undefined;
      controller.dispose();
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.synchronize(targets);
  }, [targets]);
}
