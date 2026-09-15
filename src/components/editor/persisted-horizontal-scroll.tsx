import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { ScrollView, type StyleProp, type ViewStyle } from 'react-native';

const offsets = new Map<string, number>();
const PersistedScrollScope = createContext('application');

export function PersistedHorizontalScrollScope(props: { id: string; children: ReactNode }) {
  return <PersistedScrollScope.Provider value={props.id}>{props.children}</PersistedScrollScope.Provider>;
}

export function PersistedHorizontalScroll(props: {
  id: string;
  children: ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
}) {
  const ref = useRef<ScrollView>(null);
  const scope = useContext(PersistedScrollScope);
  const key = `${scope}:${props.id}`;
  useEffect(() => {
    const x = offsets.get(key) ?? 0;
    if (x <= 0) return;
    const frame = requestAnimationFrame(() => {
      ref.current?.scrollTo({ x, animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [key]);
  return (
    <ScrollView
      ref={ref}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={props.style}
      contentContainerStyle={props.contentContainerStyle}
      scrollEventThrottle={16}
      onScroll={(event) => {
        offsets.set(key, event.nativeEvent.contentOffset.x);
      }}>
      {props.children}
    </ScrollView>
  );
}
