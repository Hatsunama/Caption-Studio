import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';

import type { TimelineAudioPlayer } from '@/services/timeline-audio-playback';

let configuration: Promise<void> | undefined;

export function prepareTimelineAudioRuntime() {
  if (!configuration) {
    configuration = setAudioModeAsync({
      interruptionMode: 'mixWithOthers',
      playsInSilentMode: true,
      shouldPlayInBackground: false,
    }).catch((error) => {
      configuration = undefined;
      throw error;
    });
  }
  return configuration;
}

export function createTimelineAudioPlayer(uri: string): TimelineAudioPlayer {
  return createAudioPlayer(uri, { updateInterval: 250 });
}
