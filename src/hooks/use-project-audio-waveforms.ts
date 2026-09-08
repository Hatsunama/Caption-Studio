import { useEffect, useRef } from 'react';

import { AUDIO_WAVEFORM_VERSION, audioWaveformNeedsRefresh } from '@/lib/audio-waveform';
import { generateAudioWaveformPeaks } from '@/services/project-media';
import type { CaptionProject } from '@/types/project';

export type GeneratedAudioWaveform = {
  sourceId: string;
  sourceUri: string;
  waveformPeaks: number[];
  waveformVersion: typeof AUDIO_WAVEFORM_VERSION;
};

export function useProjectAudioWaveforms(
  project: CaptionProject,
  enabled: boolean,
  onGenerated: (result: GeneratedAudioWaveform) => void,
  onError: (message: string) => void,
) {
  const inFlightRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const onGeneratedRef = useRef(onGenerated);
  const onErrorRef = useRef(onError);

  const source = project.audioSources.find(audioWaveformNeedsRefresh);
  const sourceKey = source
    ? `${source.id}:${source.uri}:${source.durationMs}:${source.waveformVersion ?? 0}:${source.waveformPeaks?.length ?? 0}`
    : '';

  useEffect(() => {
    onGeneratedRef.current = onGenerated;
    onErrorRef.current = onError;
  }, [onError, onGenerated]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled || !source || !sourceKey || inFlightRef.current.has(sourceKey)) return;
    inFlightRef.current.add(sourceKey);

    void generateAudioWaveformPeaks(source.uri, source.durationMs)
      .then((waveformPeaks) => {
        if (!mountedRef.current) return;
        onGeneratedRef.current({
          sourceId: source.id,
          sourceUri: source.uri,
          waveformPeaks,
          waveformVersion: AUDIO_WAVEFORM_VERSION,
        });
      })
      .catch(() => {
        if (mountedRef.current) {
          onErrorRef.current('The audio waveform could not be built. Audio playback and export are still available.');
        }
      })
      .finally(() => {
        inFlightRef.current.delete(sourceKey);
      });
  }, [enabled, source, sourceKey]);
}
