import { createRef } from 'react';
import type { ScrollView } from 'react-native';
import { TimelineNativeScrollView } from '../../src/components/editor/timeline-native-gesture';

// Included by the required project typecheck, not by the application bundle.
// Both ref forms must expose the real native scrolling/measurement surface.
export const timelineScrollRefContract = <>
  <TimelineNativeScrollView ref={createRef<ScrollView>()} />
  <TimelineNativeScrollView ref={(view) => {
    view?.scrollTo({ x: 0, y: 0, animated: false });
    view?.getNativeScrollRef()?.measureInWindow(() => {});
  }} />
</>;
