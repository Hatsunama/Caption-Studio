import type { ScrollView } from 'react-native';
import { dispatchCommand, type AnimatedRef } from 'react-native-reanimated';
import { scheduleOnUI } from 'react-native-worklets';

type ScrollCommandTarget = Pick<ScrollView, 'scrollTo' | 'scrollToEnd' | 'getNativeScrollRef'>;

/** RN 0.86.3 ScrollView.js:890-932 only normalizes and dispatches these leaves;
 * :1179-1200 also copies them to the public host. getScrollResponder (:856)
 * returns the component itself: keyboard measurement (:1059) calls its leaf.
 * Intercept both public surfaces, preserving descriptors/null checks/defaults.
 * Full responder/keyboard routines, prototypes and scroll caches stay untouched.
 */
export function interceptSpringScrollCommands(
  node: ScrollView,
  animatedRef: AnimatedRef<ScrollView>,
  epoch: () => number,
  invalidateAndDispatch: (generation: number, command: string, args: (number | boolean)[]) => void,
): (() => void) | undefined {
  const targets: ScrollCommandTarget[] = [node];
  if (typeof node.getScrollResponder === 'function') {
    const responder = node.getScrollResponder() as unknown as ScrollCommandTarget | null;
    if (!responder) return;
    if (responder !== node) targets.push(responder);
  }
  const originals: { target: ScrollCommandTarget; to: PropertyDescriptor; end: PropertyDescriptor }[] = [];
  // Validate every surface before modifying any: an unpatchable responder must
  // retain native scrolling while disabling decoration, not leave a partial guard.
  for (const target of targets) {
    const to = Object.getOwnPropertyDescriptor(target, 'scrollTo');
    const end = Object.getOwnPropertyDescriptor(target, 'scrollToEnd');
    if (!to?.writable || !end?.writable || typeof to.value !== 'function' || typeof end.value !== 'function' ||
      typeof target.getNativeScrollRef !== 'function') return;
    originals.push({ target, to, end });
  }
  let attached = true;
  const restores: (() => void)[] = [];
  try {
    for (const { target, to, end } of originals) {
      const send = (command: string, args: (number | boolean)[]) => {
        if (!attached || target.getNativeScrollRef() == null) return;
        scheduleOnUI(invalidateAndDispatch, epoch(), command, args);
      };
      const scrollTo: ScrollView['scrollTo'] = (...args) => {
        // Saved leaves outlive effect/ref bindings. Re-enter the current guard
        // before normalization, or use RN's original leaf after restoration.
        if (!attached) {
          const current = target.scrollTo;
          return (typeof current === 'function' && current !== scrollTo ? current : to.value)
            .apply(target, args);
        }
        const [options, deprecatedX, deprecatedAnimated] = args;
        let x: number | undefined, y: number | undefined, animated: boolean | undefined;
        if (typeof options === 'number') {
          console.warn('`scrollTo(y, x, animated)` is deprecated. Use `scrollTo({x: 5, y: 5, animated: true})` instead.');
          y = options; x = deprecatedX; animated = deprecatedAnimated;
        } else if (options) {
          ({ x, y, animated } = options);
        }
        send('scrollTo', [x || 0, y || 0, animated !== false]);
      };
      const scrollToEnd: ScrollView['scrollToEnd'] = (...args) => {
        if (!attached) {
          const current = target.scrollToEnd;
          return (typeof current === 'function' && current !== scrollToEnd ? current : end.value).apply(target, args);
        }
        const [options] = args;
        send('scrollToEnd', [(options && options.animated) !== false]);
      };
      Object.defineProperty(target, 'scrollTo', { ...to, value: scrollTo });
      restores.push(() => { if (target.scrollTo === scrollTo) Object.defineProperty(target, 'scrollTo', to); });
      Object.defineProperty(target, 'scrollToEnd', { ...end, value: scrollToEnd });
      restores.push(() => { if (target.scrollToEnd === scrollToEnd) Object.defineProperty(target, 'scrollToEnd', end); });
    }
  } catch {
    attached = false;
    for (const restore of restores.reverse()) restore();
    return;
  }
  // animatedRef is captured by the caller's UI worklet, never inspected here.
  void animatedRef;
  return () => {
    attached = false;
    for (const restore of restores.reverse()) restore();
  };
}

export function dispatchSpringScrollCommand(
  animatedRef: AnimatedRef<ScrollView>, command: string, args: (number | boolean)[],
) {
  'worklet';
  dispatchCommand(animatedRef, command, args);
}
