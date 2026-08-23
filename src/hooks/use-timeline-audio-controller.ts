import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { useEffect, useRef } from 'react';

import { audioClipEnd, audioClipVolume } from '@/lib/audio-timeline';
import type { CaptionProject } from '@/types/project';

type ManagedPlayer = {
  player: AudioPlayer;
  sourceId: string;
};

export function useTimelineAudioController(project: CaptionProject, currentMs: number, isPlaying: boolean) {
  const playersRef = useRef(new Map<string, ManagedPlayer>());

  useEffect(() => {
    const validIds = new Set(project.audioClips.map((clip) => clip.id));
    for (const [clipId, managed] of playersRef.current) {
      if (validIds.has(clipId)) continue;
      managed.player.pause();
      managed.player.remove();
      playersRef.current.delete(clipId);
    }

    for (const clip of project.audioClips) {
      const active = currentMs >= clip.startMs && currentMs < audioClipEnd(clip);
      let managed = playersRef.current.get(clip.id);
      const source = project.audioSources.find((candidate) => candidate.id === clip.sourceId);
      if (!source) continue;
      if (!managed || managed.sourceId !== source.id) {
        managed?.player.remove();
        managed = { player: createAudioPlayer(source.uri, { updateInterval: 100 }), sourceId: source.id };
        playersRef.current.set(clip.id, managed);
      }
      const player = managed.player;
      if (!active) {
        if (player.playing) player.pause();
        continue;
      }
      player.muted = clip.muted;
      player.volume = audioClipVolume(clip, currentMs);
      const targetSeconds = (clip.sourceStartMs + currentMs - clip.startMs) / 1_000;
      const driftMs = Math.abs(player.currentTime - targetSeconds) * 1_000;
      if (!isPlaying || !player.playing || driftMs > 220) void player.seekTo(targetSeconds);
      if (isPlaying && !player.playing) player.play();
      if (!isPlaying && player.playing) player.pause();
    }
  }, [currentMs, isPlaying, project.audioClips, project.audioSources]);

  useEffect(() => () => {
    for (const { player } of playersRef.current.values()) {
      player.pause();
      player.remove();
    }
    playersRef.current.clear();
  }, []);
}
