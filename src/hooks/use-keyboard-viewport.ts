import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, useWindowDimensions, type KeyboardEvent, type View } from 'react-native';
import { keyboardViewportOverlap, type KeyboardFrame, type ViewportFrame } from '@/lib/keyboard-viewport';

export function useKeyboardViewport(enabled = true) {
  const window = useWindowDimensions();
  const frameRef = useRef<View>(null);
  const measuredRef = useRef<ViewportFrame | undefined>(undefined);
  const keyboardRef = useRef<KeyboardFrame | undefined>(undefined);
  const lifetimeRef = useRef({ active: false, revision: 0 });
  const [bottomOverlap, setBottomOverlap] = useState(0);
  const measure = useCallback(() => {
    const lifetime = lifetimeRef.current;
    if (!lifetime.active) return;
    const revision = ++lifetime.revision;
    const view = frameRef.current;
    view?.measureInWindow((x, y, width, height) => {
      if (!lifetime.active || revision !== lifetime.revision || view !== frameRef.current) return;
      measuredRef.current = { x, y, width, height };
      setBottomOverlap(keyboardViewportOverlap(measuredRef.current, keyboardRef.current));
    });
  }, []);
  useEffect(() => {
    const lifetime = lifetimeRef.current;
    lifetime.active = enabled && Platform.OS === 'android';
    lifetime.revision++;
    measuredRef.current = undefined;
    setBottomOverlap(0);
    if (!lifetime.active) return;
    keyboardRef.current = Keyboard.isVisible() ? Keyboard.metrics() : undefined;
    const change = (event: KeyboardEvent) => {
      keyboardRef.current = event.endCoordinates;
      setBottomOverlap(keyboardViewportOverlap(measuredRef.current, keyboardRef.current));
      measure();
    };
    const hide = () => {
      keyboardRef.current = undefined;
      setBottomOverlap(0);
      measure();
    };
    const shown = Keyboard.addListener('keyboardDidShow', change);
    const changed = Keyboard.addListener('keyboardDidChangeFrame', change);
    const hidden = Keyboard.addListener('keyboardDidHide', hide);
    measure();
    return () => {
      lifetime.active = false;
      lifetime.revision++;
      shown.remove();
      changed.remove();
      hidden.remove();
    };
  }, [enabled, window.width, window.height, window.fontScale, measure]);
  return { frameRef, onLayout: measure, bottomOverlap };
}
