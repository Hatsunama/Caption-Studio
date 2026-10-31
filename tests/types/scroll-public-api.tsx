import { createRef, useContext } from 'react';
import { FlatList, type ModalProps, type ScrollView, type ScrollViewProps } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import type { SharedValue } from 'react-native-reanimated';
import {
  SpringScrollView, SpringScrollModal, renderSpringScrollView,
  SpringScrollGestureContext, type SpringScrollViewProps,
} from '../../src/scroll';

declare const offset: SharedValue<number>;
const nativeProps: ScrollViewProps = { horizontal: true, scrollEnabled: false };
const props: SpringScrollViewProps = {
  ...nativeProps, ref: createRef<ScrollView>(), nativeGesture: Gesture.Native(),
  springOffset: offset, springOwner: false,
  onScroll: event => { const position: number = event.nativeEvent.contentOffset.x; void position; },
};
const modal: ModalProps = { visible: true, onRequestClose() {}, transparent: true };

export function PublicSurface() {
  const ancestors = useContext(SpringScrollGestureContext);
  const pan = Gesture.Pan().blocksExternalGesture(...ancestors);
  return <>
    <SpringScrollView {...props} />
    <SpringScrollView ref={view => {
      view?.scrollTo({ x: 2, y: 4, animated: false });
      view?.scrollToEnd();
      view?.getScrollResponder();
      return () => {};
    }} />
    <FlatList data={[1]} renderItem={() => null} renderScrollComponent={renderSpringScrollView} />
    <SpringScrollModal {...modal}><SpringScrollView /></SpringScrollModal>
    <GestureDetector gesture={pan}><SpringScrollView /></GestureDetector>
  </>;
}

// These must remain errors, so type widening cannot silently erase the contract.
// @ts-expect-error A native ScrollView ref cannot point to a number.
const invalidRef = <SpringScrollView ref={createRef<number>()} />;
// @ts-expect-error The public Native relation must not accept a Pan.
const invalidGesture = <SpringScrollView nativeGesture={Gesture.Pan()} />;
// @ts-expect-error Owner is a boolean, not an arbitrary value.
const invalidOwner = <SpringScrollView springOwner="yes" />;
// @ts-expect-error Unknown props are not part of the native surface.
const invalidProp = <SpringScrollView inventedScrollMode />;
void [invalidRef, invalidGesture, invalidOwner, invalidProp];
