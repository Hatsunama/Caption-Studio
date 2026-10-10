import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, useWindowDimensions, type KeyboardEvent, type View } from 'react-native';
import { keyboardViewportOverlap, type KeyboardFrame, type ViewportFrame } from '@/lib/keyboard-viewport';

export function useKeyboardViewport(enabled = true) {
  const window = useWindowDimensions();
  const geometryKey = `${window.width}:${window.height}:${window.fontScale}`;
  const active = enabled && Platform.OS === 'android';
  const frameRef = useRef<View | null>(null);
  const measuredRef = useRef<ViewportFrame | undefined>(undefined);
  const keyboardRef = useRef<KeyboardFrame | undefined>(undefined);
  const lifetimeRef = useRef({ active: false, epoch: 0, measurement: 0, geometryKey: '' });
  const [reservation, setReservation] = useState({ overlap: 0, geometryKey: '' });
  const measure = useCallback(() => {
    const lifetime = lifetimeRef.current;
    if (!lifetime.active) return;
    const epoch = lifetime.epoch;
    const revision = ++lifetime.measurement;
    const key = lifetime.geometryKey;
    const view = frameRef.current;
    view?.measureInWindow((x, y, width, height) => {
      if (!lifetime.active || epoch !== lifetime.epoch || revision !== lifetime.measurement
        || view !== frameRef.current) return;
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;
      measuredRef.current = { x, y, width, height };
      const overlap = keyboardViewportOverlap(measuredRef.current, keyboardRef.current);
      setReservation((previous) => previous.overlap === overlap && previous.geometryKey === key
        ? previous : { overlap, geometryKey: key });
    });
  }, []);
  const attachFrame = useCallback((view: View | null) => {
    if (frameRef.current === view) return;
    frameRef.current = view;
    lifetimeRef.current.measurement++;
    measuredRef.current = undefined;
    if (view) measure();
  }, [measure]);

  useEffect(() => {
    const lifetime = lifetimeRef.current;
    const epoch = ++lifetime.epoch;
    lifetime.active = active;
    lifetime.geometryKey = geometryKey;
    lifetime.measurement++;
    measuredRef.current = undefined;
    if (!active) return;
    keyboardRef.current = Keyboard.isVisible() ? Keyboard.metrics() : undefined;
    const current = () => lifetime.active && lifetime.epoch === epoch;
    const change = (event: KeyboardEvent) => {
      if (!current()) return;
      keyboardRef.current = event.endCoordinates;
      if (measuredRef.current) {
        const overlap = keyboardViewportOverlap(measuredRef.current, keyboardRef.current);
        setReservation((previous) => previous.overlap === overlap && previous.geometryKey === geometryKey
          ? previous : { overlap, geometryKey });
      }
      measure();
    };
    const hide = () => {
      if (!current()) return;
      keyboardRef.current = undefined;
      setReservation((previous) => previous.overlap === 0 && previous.geometryKey === geometryKey
        ? previous : { overlap: 0, geometryKey });
      measure();
    };
    const shown = Keyboard.addListener('keyboardDidShow', change);
    const hidden = Keyboard.addListener('keyboardDidHide', hide);
    measure();
    return () => {
      if (lifetime.epoch === epoch) {
        lifetime.active = false;
        lifetime.epoch++;
        lifetime.measurement++;
      }
      shown.remove();
      hidden.remove();
    };
  }, [active, geometryKey, measure]);

  return {
    attachFrame,
    onLayout: measure,
    bottomOverlap: active ? Math.min(reservation.overlap, Math.max(0, window.height)) : 0,
    measurementPending: active && reservation.geometryKey !== geometryKey,
  };
}
