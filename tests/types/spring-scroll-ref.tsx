import { createRef, useEffect, useRef } from 'react';
import { FlatList, type ScrollView as NativeScrollView } from 'react-native';
import { SpringScrollView as ScrollView, renderSpringScrollView } from '../../src/components/spring-scroll-view';

export function SpringScrollRefContract() {
  const ref = useRef<ScrollView>(null);
  useEffect(() => {
    const native: NativeScrollView | null = ref.current;
    native?.scrollTo({ x: 1, y: 2, animated: false });
  }, []);
  return <>
    <ScrollView ref={ref} />
    <ScrollView ref={createRef<NativeScrollView>()} />
    <ScrollView ref={view => { view?.scrollToEnd(); view?.getNativeScrollRef()?.measureInWindow(() => {}); }} />
    <FlatList data={[1]} renderItem={() => null} renderScrollComponent={renderSpringScrollView} />
  </>;
}
