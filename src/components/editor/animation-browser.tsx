import { useCallback, useMemo, useState } from 'react';
import { PanResponder, Pressable, Text, View } from 'react-native';

import { PersistedHorizontalScroll } from '@/components/editor/persisted-horizontal-scroll';
import { ANIMATION_PRESETS, CAPTION_ANIMATION_COUNT, type AnimationPreset } from '@/lib/animation-presets';
import { chrome } from '@/lib/ui-theme';
import type { CaptionAnimationId } from '@/types/project';

export function AnimationBrowser(props: {
  selected: CaptionAnimationId;
  textLayerSelected?: boolean;
  scope: 'caption' | 'all';
  hasSelectedCaption: boolean;
  lineHeight: number;
  onScopeChange: (scope: 'caption' | 'all') => void;
  onSelect: (id: CaptionAnimationId) => void;
  onLineHeightStart: () => void;
  onLineHeightChange: (lineHeight: number) => void;
  onLineHeightEnd: () => void;
}) {
  const [filter, setFilter] = useState<'all' | AnimationPreset['group']>('all');
  const visiblePresets = useMemo(
    () => filter === 'all' ? ANIMATION_PRESETS : ANIMATION_PRESETS.filter((preset) => preset.group === filter),
    [filter],
  );

  return (
    <View style={{ gap: 9 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: chrome.text, fontSize: 13, fontWeight: '700' }}>{CAPTION_ANIMATION_COUNT} motion styles + Classic</Text>
        {props.textLayerSelected ? (
          <View style={{ paddingHorizontal: 9, paddingVertical: 6, borderRadius: chrome.radius.pill, backgroundColor: chrome.purple }}>
            <Text style={{ color: '#150D22', fontSize: 9, fontWeight: '700' }}>THIS TEXT LAYER</Text>
          </View>
        ) : (
          <View style={{ flexDirection: 'row', padding: 3, borderRadius: chrome.radius.md, backgroundColor: chrome.surface }}>
            <ScopeButton
              label="This caption"
              active={props.scope === 'caption'}
              disabled={!props.hasSelectedCaption}
              onPress={() => props.onScopeChange('caption')}
            />
            <ScopeButton label="All captions" active={props.scope === 'all'} onPress={() => props.onScopeChange('all')} />
          </View>
        )}
      </View>
      <PersistedHorizontalScroll id="tool:animate:filters" contentContainerStyle={{ gap: 7, paddingRight: 18 }}>
        <FilterChip label="All" active={filter === 'all'} onPress={() => setFilter('all')} />
        <FilterChip label="Entrances" active={filter === 'entry'} onPress={() => setFilter('entry')} />
        <FilterChip label="Loops" active={filter === 'loop'} onPress={() => setFilter('loop')} />
        <FilterChip label="Words" active={filter === 'word'} onPress={() => setFilter('word')} />
        <FilterChip label="Emoji" active={filter === 'emoji'} onPress={() => setFilter('emoji')} />
      </PersistedHorizontalScroll>
      <PersistedHorizontalScroll id="tool:animate:presets" contentContainerStyle={{ gap: 9, paddingRight: 18 }}>
        {visiblePresets.map((preset) => {
          const active = props.selected === preset.id;
          return (
            <Pressable
              key={preset.id}
              accessibilityRole="button"
              accessibilityLabel={`${preset.name}: ${preset.description}`}
              onPress={() => props.onSelect(preset.id)}
              style={{
                width: 116,
                minHeight: 92,
                padding: 10,
                gap: 4,
                borderRadius: chrome.radius.md,
                borderWidth: active ? 2 : 1,
                borderColor: active ? preset.accent : chrome.hairline,
                backgroundColor: active ? chrome.surfaceRaised : chrome.surface,
              }}>
              <Text style={{ color: preset.accent, fontSize: 22, fontWeight: '700' }}>{preset.icon}</Text>
              <Text style={{ color: chrome.text, fontSize: 12, fontWeight: '700' }}>{preset.name}</Text>
              <Text numberOfLines={2} style={{ color: chrome.muted, fontSize: 9, lineHeight: 12 }}>{preset.description}</Text>
            </Pressable>
          );
        })}
      </PersistedHorizontalScroll>
      <LineSpacingControl
        value={props.lineHeight}
        onStart={props.onLineHeightStart}
        onChange={props.onLineHeightChange}
        onEnd={props.onLineHeightEnd}
      />
    </View>
  );
}

const MIN_LINE_HEIGHT = 0.72;
const MAX_LINE_HEIGHT = 2.2;

function LineSpacingControl(props: { value: number; onStart: () => void; onChange: (value: number) => void; onEnd: () => void }) {
  const { onChange, onEnd, onStart, value } = props;
  const [trackWidth, setTrackWidth] = useState(1);
  const valueForX = useCallback((x: number) => {
    const progress = Math.max(0, Math.min(1, x / trackWidth));
    return Number((MIN_LINE_HEIGHT + (MAX_LINE_HEIGHT - MIN_LINE_HEIGHT) * progress).toFixed(2));
  }, [trackWidth]);
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (event) => {
      onStart();
      onChange(valueForX(event.nativeEvent.locationX));
    },
    onPanResponderMove: (event) => onChange(valueForX(event.nativeEvent.locationX)),
    onPanResponderRelease: onEnd,
    onPanResponderTerminate: onEnd,
  }), [onChange, onEnd, onStart, valueForX]);
  const progress = Math.max(0, Math.min(1, (value - MIN_LINE_HEIGHT) / (MAX_LINE_HEIGHT - MIN_LINE_HEIGHT)));
  return (
    <View style={{ gap: 7, paddingTop: 3 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Text style={{ color: chrome.text, fontSize: 11, fontWeight: '800' }}>LINE SPACING</Text>
        <Text style={{ color: chrome.accent, fontSize: 11, fontVariant: ['tabular-nums'], fontWeight: '800' }}>{value.toFixed(2)}x</Text>
      </View>
      <View
        {...responder.panHandlers}
        accessibilityRole="adjustable"
        accessibilityLabel="Line spacing"
        accessibilityValue={{ min: MIN_LINE_HEIGHT, max: MAX_LINE_HEIGHT, now: value }}
        onLayout={(event) => setTrackWidth(Math.max(1, event.nativeEvent.layout.width))}
        style={{ height: 34, justifyContent: 'center' }}>
        <View pointerEvents="none" style={{ height: 5, borderRadius: 3, backgroundColor: chrome.fill }}>
          <View style={{ width: `${progress * 100}%`, height: '100%', borderRadius: 3, backgroundColor: chrome.accent }} />
        </View>
        <View pointerEvents="none" style={{ position: 'absolute', left: `${progress * 100}%`, marginLeft: -11, width: 22, height: 22, borderRadius: 11, borderWidth: 3, borderColor: chrome.accent, backgroundColor: chrome.surface }} />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ color: chrome.muted, fontSize: 9, fontWeight: '700' }}>CLOSER</Text>
        <Text style={{ color: chrome.muted, fontSize: 9, fontWeight: '700' }}>FARTHER</Text>
      </View>
    </View>
  );
}

function FilterChip(props: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.active }}
      onPress={props.onPress}
      style={{ paddingHorizontal: 11, paddingVertical: 7, borderRadius: chrome.radius.pill, backgroundColor: props.active ? chrome.accent : chrome.surfaceRaised }}>
      <Text style={{ color: props.active ? chrome.accentInk : chrome.text, fontSize: 10, fontWeight: '700' }}>{props.label}</Text>
    </Pressable>
  );
}

function ScopeButton(props: { label: string; active: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: chrome.radius.pill, opacity: props.disabled ? 0.35 : 1, backgroundColor: props.active ? chrome.accent : 'transparent' }}>
      <Text style={{ color: props.active ? chrome.accentInk : chrome.muted, fontSize: 11, fontWeight: '600' }}>{props.label}</Text>
    </Pressable>
  );
}
