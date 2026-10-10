import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { chrome } from '@/lib/ui-theme';
import { KeyboardViewport } from '@/components/editor/keyboard-viewport';
import { useFocusedInputReveal } from '@/hooks/use-focused-input-reveal';

const DialogInputContext = createContext<{
  compact: boolean;
  maxInputHeight: number;
  focus: (input: TextInput | null) => void;
  blur: (input: TextInput | null) => void;
} | null>(null);

export function AdaptiveDialogTextInput(props: TextInputProps) {
  const dialog = useContext(DialogInputContext);
  const inputRef = useRef<TextInput | null>(null);
  const focused = useRef(false);
  const height = dialog?.maxInputHeight ?? 110;
  return <TextInput {...props} ref={inputRef}
    scrollEnabled={props.multiline ? true : props.scrollEnabled}
    style={[props.style, props.multiline && dialog ? {
      minHeight: Math.min(110, height), maxHeight: height,
      ...(dialog.compact ? { height, padding: 8 } : {}),
    } : null]}
    onFocus={(event) => {
      focused.current = true;
      dialog?.focus(inputRef.current);
      props.onFocus?.(event);
    }}
    onBlur={(event) => {
      focused.current = false;
      dialog?.blur(inputRef.current);
      props.onBlur?.(event);
    }}
    onLayout={(event) => {
      if (focused.current) dialog?.focus(inputRef.current);
      props.onLayout?.(event);
    }}
    onContentSizeChange={(event) => {
      if (focused.current) dialog?.focus(inputRef.current);
      props.onContentSizeChange?.(event);
    }} />;
}

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
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [bodyHeight, setBodyHeight] = useState(0);
  const scrollRef = useRef<ScrollView | null>(null);
  const scrollToOffset = useCallback((offset: number) => {
    scrollRef.current?.scrollTo({ y: offset, animated: true });
  }, []);
  const [viewportRef, reveal] = useFocusedInputReveal(scrollToOffset);
  const compact = Boolean(props.keyboard && props.footer && !props.sheet
    && frame.width >= 600 && frame.height > 0 && frame.height < 260);
  const padding = compact ? 8 : props.padding ?? 22;
  const framePadding = props.sheet ? 0 : compact ? 8 : props.framePadding ?? 28;
  const gap = compact ? 8 : props.gap ?? 14;
  const top = Math.max(framePadding, insets.top);
  const bottom = props.sheet ? 0 : Math.max(framePadding, insets.bottom);
  return (
    <KeyboardViewport
      enabled={Boolean(props.keyboard)}
      style={{ flex: 1, minHeight: 0 }}>
      <View testID="adaptive-dialog-frame" onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setFrame(current => current.width === width && current.height === height ? current : { width, height });
      }} style={{
        flex: 1, minHeight: 0, alignItems: 'center',
        justifyContent: props.sheet ? 'flex-end' : 'center',
        paddingTop: top,
        paddingBottom: bottom,
        paddingLeft: Math.max(framePadding, insets.left),
        paddingRight: Math.max(framePadding, insets.right),
        backgroundColor: props.backgroundColor ?? chrome.overlay,
      }}>
        <Pressable onPress={(event) => event.stopPropagation()} style={[{
          width: '100%', maxWidth: props.maxWidth ?? (props.sheet || compact ? 640 : 380),
          maxHeight: '100%', minHeight: 0, flexShrink: 1,
          flexDirection: compact ? 'row' : 'column',
          height: compact ? Math.max(44, frame.height - top - bottom) : undefined,
          borderRadius: props.sheet ? 0 : chrome.radius.xl,
          borderTopLeftRadius: chrome.radius.xl, borderTopRightRadius: chrome.radius.xl,
          backgroundColor: chrome.surface,
        }, props.cardStyle]}>
          <View ref={viewportRef} collapsable={false}
            style={{ flexShrink: 1, minHeight: 0, ...(compact ? { flex: 1 } : {}) }}
            onLayout={(event) => {
              setBodyHeight(event.nativeEvent.layout.height);
              reveal.onViewportLayout();
            }}>
          <ScrollView ref={scrollRef} testID="adaptive-dialog-body" style={{ flexShrink: 1, minHeight: 0, ...(compact ? { flex: 1 } : {}) }}
            keyboardShouldPersistTaps="handled"
            onScroll={reveal.onScroll} onScrollBeginDrag={reveal.onScrollBeginDrag} scrollEventThrottle={16}
            contentContainerStyle={{
              paddingHorizontal: padding, paddingTop: padding,
              paddingBottom: props.footer ? gap : props.sheet ? Math.max(34, insets.bottom) : padding,
              gap,
            }}>
            <DialogInputContext.Provider value={{ compact,
              maxInputHeight: bodyHeight > 0 ? Math.max(44, bodyHeight - padding - (props.footer ? gap : padding)) : 110,
              focus: reveal.focus, blur: reveal.blur,
            }}>{props.children}</DialogInputContext.Provider>
          </ScrollView>
          </View>
          {props.footer ? <View testID="adaptive-dialog-footer" style={{
            paddingHorizontal: padding,
            paddingBottom: props.sheet ? Math.max(34, insets.bottom) : padding,
            ...(compact ? { flexShrink: 0, minHeight: 44, justifyContent: 'center', paddingTop: padding } : {}),
          }}>{props.footer}</View> : null}
        </Pressable>
      </View>
    </KeyboardViewport>
  );
}
