import { useEffect, useState } from 'react';
import type { AudioRecorder, RecorderState } from 'expo-audio';

/** Observe the editor-owned recorder without changing its native lifecycle. */
export function useVoiceoverRecorderState(recorder: AudioRecorder, observed: boolean): RecorderState {
  const [state, setState] = useState<RecorderState>(() => recorder.getStatus());
  // A take can outlive the panel (including asynchronous preparation). Its
  // timeline draft and stop/back guards still consume status outside the panel.
  const active = observed || state.isRecording;

  useEffect(() => {
    let live = true;
    const refresh = () => {
      if (!live) return;
      const next = recorder.getStatus();
      setState((previous) => {
        if (!live) return previous;
        // Match expo-audio 57.0.5's useAudioRecorderState thresholds exactly.
        const meteringChanged =
          (previous.metering === undefined) !== (next.metering === undefined) ||
          (previous.metering !== undefined && next.metering !== undefined &&
            Math.abs(previous.metering - next.metering) > 0.1);
        return previous.canRecord !== next.canRecord ||
          previous.isRecording !== next.isRecording ||
          previous.mediaServicesDidReset !== next.mediaServicesDidReset ||
          previous.url !== next.url ||
          Math.abs(previous.durationMillis - next.durationMillis) > 50 ||
          meteringChanged ? next : previous;
      });
    };
    // Events carry RecordingStatus, not RecorderState. Read native status when
    // idle; while active the existing 100ms cadence governs visible feedback.
    const subscription = recorder.addListener('recordingStatusUpdate', () => {
      if (!active) refresh();
    });
    let timer: ReturnType<typeof setInterval> | undefined;
    if (active) {
      refresh();
      timer = setInterval(refresh, 100);
    }
    return () => {
      live = false;
      if (timer !== undefined) clearInterval(timer);
      subscription.remove();
    };
  }, [recorder, active]);

  return state;
}
