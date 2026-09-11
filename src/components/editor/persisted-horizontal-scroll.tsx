import { useEffect, useRef, type ReactNode } from 'react';
import { ScrollView, type StyleProp, type ViewStyle } from 'react-native';

const offsets = new Map<string, number>();

export function PersistedHorizontalScroll(props: {
  id: string;
  children: ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
}) {
  const ref = useRef<ScrollView>(null);
  useEffect(() => {
    const x = offsets.get(props.id) ?? 0;
    if (x <= 0) return;
    const frame = requestAnimationFrame(() => {
      ref.current?.scrollTo({ x, animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [props.id]);
  return (
    <ScrollView
      ref={ref}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={props.style}
      contentContainerStyle={props.contentContainerStyle}
      scrollEventThrottle={16}
      onScroll={(event) => {
        offsets.set(props.id, event.nativeEvent.contentOffset.x);
      }}>
      {props.children}
    </ScrollView>
  );
}
