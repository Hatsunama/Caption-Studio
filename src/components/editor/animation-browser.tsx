import Slider from '@react-native-community/slider';
import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { PersistedHorizontalScroll } from '@/components/editor/persisted-horizontal-scroll';
import { ANIMATION_PRESETS, CAPTION_ANIMATION_COUNT, type AnimationPreset } from '@/lib/animation-presets';
import {
  CAPTION_LINE_HEIGHT_MAX,
  CAPTION_LINE_HEIGHT_MIN,
  normalizeCaptionLineHeight,
} from '@/lib/caption-line-spacing';
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

function LineSpacingControl(props: { value: number; onStart: () => void; onChange: (value: number) => void; onEnd: () => void }) {
  const { onChange, onEnd, onStart, value } = props;
  const normalizedValue = normalizeCaptionLineHeight(value);
  return (
    <View style={{ gap: 7, paddingTop: 3 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Text style={{ color: chrome.text, fontSize: 11, fontWeight: '800' }}>LINE SPACING</Text>
        <Text style={{ color: chrome.accent, fontSize: 11, fontVariant: ['tabular-nums'], fontWeight: '800' }}>{normalizedValue.toFixed(2)}x</Text>
      </View>
      <Slider
        accessibilityLabel="Line spacing"
        value={normalizedValue}
        minimumValue={CAPTION_LINE_HEIGHT_MIN}
        maximumValue={CAPTION_LINE_HEIGHT_MAX}
        step={0.01}
        minimumTrackTintColor={chrome.accent}
        maximumTrackTintColor={chrome.fill}
        thumbTintColor={chrome.accent}
        onSlidingStart={onStart}
        onValueChange={(next) => onChange(normalizeCaptionLineHeight(next))}
        onSlidingComplete={onEnd}
        style={{ width: '100%', height: 34 }}
      />
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
