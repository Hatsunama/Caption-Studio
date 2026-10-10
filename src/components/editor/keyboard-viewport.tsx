import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { useKeyboardViewport } from '@/hooks/use-keyboard-viewport';

export function KeyboardViewport(props: {
  children: ReactNode | ((insets: { safeAreaBottom: number }) => ReactNode);
  safeAreaBottom?: number;
  style?: StyleProp<ViewStyle>;
  enabled?: boolean;
  iosAvoidance?: boolean;
  keyboardVerticalOffset?: number;
}) {
  const enabled = props.enabled ?? true;
  const { attachFrame, onLayout, bottomOverlap, bottomInsetCovered } = useKeyboardViewport(enabled);
  const children = typeof props.children === 'function'
    ? props.children({ safeAreaBottom: bottomInsetCovered ? 0 : (props.safeAreaBottom ?? 0) })
    : props.children;
  return (
    <KeyboardAvoidingView
      enabled={enabled && (props.iosAvoidance ?? true)}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={props.keyboardVerticalOffset}
      style={props.style ?? { flex: 1, minHeight: 0 }}>
      <View ref={attachFrame} onLayout={onLayout}
        testID="keyboard-viewport-frame" style={{ flex: 1, minHeight: 0 }}>
        <View testID="keyboard-viewport-content"
          style={{ flex: 1, minHeight: 0, marginBottom: bottomOverlap }}>
          {children}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
