import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Platform, useWindowDimensions, type KeyboardEvent, type View } from 'react-native';
import { keyboardViewportBottomGap, keyboardViewportOverlap, type KeyboardFrame, type ViewportFrame } from '@/lib/keyboard-viewport';

export function useKeyboardViewport(enabled = true, safeAreaBottom = 0) {
  const window = useWindowDimensions();
  const geometryKey = `${window.width}:${window.height}:${window.fontScale}`;
  const active = enabled && Platform.OS === 'android';
  const configuration = useMemo(() => ({ active, geometryKey }), [active, geometryKey]);
  const frameRef = useRef<View | null>(null);
  const measuredRef = useRef<ViewportFrame | undefined>(undefined);
  const keyboardRef = useRef<KeyboardFrame | undefined>(undefined);
  const lifetimeRef = useRef({ active: false, epoch: 0, measurement: 0, coverageValid: false, geometryKey: '', configuration: undefined as typeof configuration | undefined });
  const [reservation, setReservation] = useState<{ overlap: number; bottomInsetGap: number | undefined; geometryKey: string; configuration?: typeof configuration }>({ overlap: 0, bottomInsetGap: undefined, geometryKey: '' });
  const invalidateCoverage = useCallback(() => {
    // Preserve the bounded last overlap while fresh geometry is unavailable.
    lifetimeRef.current.coverageValid = false;
    setReservation((previous) => previous.bottomInsetGap !== undefined
      ? { ...previous, bottomInsetGap: undefined } : previous);
  }, []);
  const reserve = useCallback((frame: ViewportFrame, keyboard: KeyboardFrame | undefined, config: typeof configuration) => {
    const overlap = keyboardViewportOverlap(frame, keyboard);
    const bottomInsetGap = lifetimeRef.current.coverageValid ? keyboardViewportBottomGap(frame, keyboard) : undefined;
    setReservation((previous) => previous.overlap === overlap
      && previous.bottomInsetGap === bottomInsetGap && previous.configuration === config
      ? previous : { overlap, bottomInsetGap, geometryKey: config.geometryKey, configuration: config });
  }, []);
  const measure = useCallback(() => {
    const lifetime = lifetimeRef.current;
    if (!lifetime.active) return;
    const epoch = lifetime.epoch;
    const revision = ++lifetime.measurement;
    const config = lifetime.configuration;
    if (!config) return;
    const view = frameRef.current;
    view?.measureInWindow((x, y, width, height) => {
      if (!lifetime.active || epoch !== lifetime.epoch || revision !== lifetime.measurement
        || view !== frameRef.current) return;
      if (![x, y, width, height, x + width, y + height].every(Number.isFinite) || width <= 0 || height <= 0) {
        invalidateCoverage();
        return;
      }
      measuredRef.current = { x, y, width, height };
      lifetime.coverageValid = true;
      reserve(measuredRef.current, keyboardRef.current, config);
    });
  }, [invalidateCoverage, reserve]);
  const attachFrame = useCallback((view: View | null) => {
    if (frameRef.current === view) return;
    frameRef.current = view;
    lifetimeRef.current.measurement++;
    measuredRef.current = undefined;
    invalidateCoverage();
    if (view) measure();
  }, [invalidateCoverage, measure]);
  const onLayout = useCallback(() => {
    invalidateCoverage();
    measure();
  }, [invalidateCoverage, measure]);

  useEffect(() => {
    const lifetime = lifetimeRef.current;
    const epoch = ++lifetime.epoch;
    lifetime.active = active;
    lifetime.geometryKey = geometryKey;
    lifetime.configuration = configuration;
    lifetime.measurement++;
    measuredRef.current = undefined;
    lifetime.coverageValid = false;
    if (!active) {
      keyboardRef.current = undefined;
      return;
    }
    keyboardRef.current = Keyboard.isVisible() ? Keyboard.metrics() : undefined;
    const current = () => lifetime.active && lifetime.epoch === epoch;
    const change = (event: KeyboardEvent) => {
      if (!current()) return;
      keyboardRef.current = event.endCoordinates;
      if (measuredRef.current) {
        reserve(measuredRef.current, keyboardRef.current, configuration);
      }
      measure();
    };
    const hide = () => {
      if (!current()) return;
      keyboardRef.current = undefined;
      setReservation((previous) => previous.overlap === 0 && previous.bottomInsetGap === undefined
        && previous.configuration === configuration
        ? previous : { overlap: 0, bottomInsetGap: undefined, geometryKey, configuration });
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
  }, [active, configuration, geometryKey, measure, reserve]);

  return {
    attachFrame,
    onLayout,
    bottomOverlap: active ? Math.min(reservation.overlap, Math.max(0, window.height)) : 0,
    bottomInsetCovered: active && reservation.configuration === configuration
      && Number.isFinite(safeAreaBottom) && safeAreaBottom >= 0
      && reservation.bottomInsetGap !== undefined && reservation.bottomInsetGap <= safeAreaBottom,
    measurementPending: active && reservation.configuration !== configuration,
  };
}
