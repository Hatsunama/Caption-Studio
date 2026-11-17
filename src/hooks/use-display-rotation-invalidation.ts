import { useEffect } from 'react';
import { DeviceEventEmitter } from 'react-native';

/** RN emits this independently of Dimensions, including same-size 180° turns.
 * Treat each event as an external coordinate-basis change, not media rotation. */
export function useDisplayRotationInvalidation(invalidate: () => void) {
  useEffect(() => {
    let live = true;
    const subscription = DeviceEventEmitter.addListener('namedOrientationDidChange', () => {
      if (live) invalidate();
    });
    return () => {
      live = false;
      subscription.remove();
    };
  }, [invalidate]);
}
