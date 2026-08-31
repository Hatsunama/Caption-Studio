import { Pressable, ScrollView, Text, View } from 'react-native';

import { ANIMATION_PRESETS } from '@/lib/animation-presets';
import { chrome } from '@/lib/ui-theme';
import type { CaptionAnimationId } from '@/types/project';

export function AnimationBrowser(props: {
  selected: CaptionAnimationId;
  textLayerSelected?: boolean;
  scope: 'caption' | 'all';
  hasSelectedCaption: boolean;
  onScopeChange: (scope: 'caption' | 'all') => void;
  onSelect: (id: CaptionAnimationId) => void;
}) {
  return (
    <View style={{ gap: 9 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: chrome.text, fontSize: 13, fontWeight: '700' }}>21 real animation styles</Text>
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
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 9, paddingRight: 18 }}>
        {ANIMATION_PRESETS.map((preset) => {
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
      </ScrollView>
    </View>
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
