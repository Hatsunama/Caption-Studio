import { requireNativeView } from 'expo';
import { Platform, View, type ViewProps } from 'react-native';

type RefractBackgroundProps = ViewProps & { active: boolean };

const NativeRefractBackground = Platform.OS === 'android'
  ? requireNativeView<RefractBackgroundProps>('CaptionRefract')
  : null;

export function RefractBackground({ active, ...props }: RefractBackgroundProps) {
  if (!NativeRefractBackground) {
    return <View {...props} pointerEvents="none" style={[{ backgroundColor: '#0A0B0E' }, props.style]} />;
  }
  return <NativeRefractBackground {...props} active={active} pointerEvents="none" />;
}
