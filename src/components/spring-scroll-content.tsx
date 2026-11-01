import { forwardRef, useImperativeHandle, useLayoutEffect } from 'react';
import { StyleSheet, type HostInstance, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';

type ContentOwnerProps = {
  host: HostInstance;
  onStyle: (style: ViewStyle | undefined) => void;
};

// The native content host exists before this owner mounts. Own its real family
// and GC lifetime without wrapping or remounting the ScrollView. Settled styles
// return to that host through React props; animation frames remain on the UI.
const ContentStyleTarget = forwardRef<HostInstance, ContentOwnerProps & { style?: StyleProp<ViewStyle> }>(
  function ContentStyleTarget({ host, style, onStyle }, ref) {
    useImperativeHandle(ref, () => host, [host]);
    useLayoutEffect(() => {
      const value = StyleSheet.flatten(style);
      onStyle(value && Object.keys(value).length ? value : undefined);
    }, [style, onStyle]);
    return null;
  },
);

export const ScrollContentOwner = Animated.createAnimatedComponent(ContentStyleTarget);

// Reanimated filters style into a fresh object. Compare values so projection
// of that object cannot feed back into another React render indefinitely.
export function sameContentStyle(a: ViewStyle | undefined, b: ViewStyle | undefined) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a) as (keyof ViewStyle)[];
  return keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && Object.is(a[key], b[key]));
}
