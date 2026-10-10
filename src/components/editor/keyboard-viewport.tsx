import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { useKeyboardViewport } from '@/hooks/use-keyboard-viewport';

export function KeyboardViewport(props: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  enabled?: boolean;
  iosAvoidance?: boolean;
  keyboardVerticalOffset?: number;
}) {
  const enabled = props.enabled ?? true;
  const viewport = useKeyboardViewport(enabled);
  return (
    <KeyboardAvoidingView
      enabled={enabled && (props.iosAvoidance ?? true)}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={props.keyboardVerticalOffset}
      style={props.style ?? { flex: 1, minHeight: 0 }}>
      <View ref={viewport.frameRef} onLayout={viewport.onLayout}
        testID="keyboard-viewport-frame" style={{ flex: 1, minHeight: 0 }}>
        <View testID="keyboard-viewport-content"
          style={{ flex: 1, minHeight: 0, marginBottom: viewport.bottomOverlap }}>
          {props.children}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
