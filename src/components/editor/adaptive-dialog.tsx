import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { chrome } from '@/lib/ui-theme';

export function AdaptiveDialog(props: {
  children: ReactNode;
  footer?: ReactNode;
  sheet?: boolean;
  keyboard?: boolean;
  maxWidth?: number;
  padding?: number;
  gap?: number;
  framePadding?: number;
  backgroundColor?: string;
  cardStyle?: StyleProp<ViewStyle>;
}) {
  const insets = useSafeAreaInsets();
  const padding = props.padding ?? 22;
  const framePadding = props.sheet ? 0 : props.framePadding ?? 28;
  const gap = props.gap ?? 14;
  return (
    <KeyboardAvoidingView
      enabled={Boolean(props.keyboard)}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, minHeight: 0 }}>
      <View testID="adaptive-dialog-frame" style={{
        flex: 1, minHeight: 0, alignItems: 'center',
        justifyContent: props.sheet ? 'flex-end' : 'center',
        paddingTop: Math.max(framePadding, insets.top),
        paddingBottom: props.sheet ? 0 : Math.max(framePadding, insets.bottom),
        paddingLeft: Math.max(framePadding, insets.left),
        paddingRight: Math.max(framePadding, insets.right),
        backgroundColor: props.backgroundColor ?? chrome.overlay,
      }}>
        <Pressable onPress={(event) => event.stopPropagation()} style={[{
          width: '100%', maxWidth: props.maxWidth ?? (props.sheet ? 640 : 380),
          maxHeight: '100%', minHeight: 0, flexShrink: 1,
          borderRadius: props.sheet ? 0 : chrome.radius.xl,
          borderTopLeftRadius: chrome.radius.xl, borderTopRightRadius: chrome.radius.xl,
          backgroundColor: chrome.surface,
        }, props.cardStyle]}>
          <ScrollView testID="adaptive-dialog-body" style={{ flexShrink: 1, minHeight: 0 }}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              paddingHorizontal: padding, paddingTop: padding,
              paddingBottom: props.footer ? gap : props.sheet ? Math.max(34, insets.bottom) : padding,
              gap,
            }}>
            {props.children}
          </ScrollView>
          {props.footer ? <View testID="adaptive-dialog-footer" style={{
            paddingHorizontal: padding,
            paddingBottom: props.sheet ? Math.max(34, insets.bottom) : padding,
          }}>{props.footer}</View> : null}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
