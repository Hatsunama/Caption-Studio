import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

const lastPulse: Partial<Record<'selection' | 'boundary', number>> = {};

/** Best-effort platform feedback; never gates editing, persistence or playback. */
export function timelineHaptic(kind: 'selection' | 'boundary') {
  const now = Date.now();
  if (now - (lastPulse[kind] ?? -Infinity) < 60) return;
  lastPulse[kind] = now;
  try {
    const pulse = Platform.OS === 'android'
      ? Haptics.performAndroidHapticsAsync(kind === 'selection' ? Haptics.AndroidHaptics.Context_Click : Haptics.AndroidHaptics.Segment_Tick)
      : Haptics.selectionAsync();
    void pulse.catch(() => {});
  } catch {
    // Unsupported hardware/settings must not turn feedback into an edit error.
  }
}
