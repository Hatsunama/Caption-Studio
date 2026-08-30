import { Pressable, ScrollView, Text, View } from 'react-native';

import { PERSON_MATTE_PRESETS, type PersonMattePreset } from '@/lib/person-matte-presets';
import { chrome } from '@/lib/ui-theme';
import type { BackgroundReplacement } from '@/types/project';

export function BackgroundTools(props: {
  value: BackgroundReplacement;
  currentTimeMs: number;
  processingAllowed: boolean;
  onRequestProcessing: () => void;
  onChooseMedia: () => void;
  onChange: (next: BackgroundReplacement) => void;
  onAddKeyframe: () => void;
  onRemoveNearestKeyframe: () => void;
}) {
  const updateTransform = (patch: Partial<BackgroundReplacement['personTransform']>) => {
    props.onChange({ ...props.value, personTransform: { ...props.value.personTransform, ...patch } });
  };
  const transform = props.value.personTransform;
  const updateMask = (patch: Partial<BackgroundReplacement['mask']>) => {
    props.onChange({ ...props.value, mask: { ...props.value.mask, ...patch, qualityPreset: 'custom' } });
  };
  const applyPreset = (preset: PersonMattePreset) => props.onChange({
    ...props.value,
    mask: { ...PERSON_MATTE_PRESETS[preset] },
  });
  return (
    <View style={{ gap: 9, padding: 12, borderRadius: chrome.radius.lg, backgroundColor: chrome.surface }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: chrome.text, fontSize: 14, fontWeight: '700' }}>Remove video background</Text>
          <Text style={{ color: chrome.muted, fontSize: 11, marginTop: 2 }}>Runs privately on this phone. No green screen required.</Text>
        </View>
        <Chip
          label={props.value.enabled && props.processingAllowed ? 'On' : 'Off'}
          active={props.value.enabled && props.processingAllowed}
          onPress={() => {
            if (props.value.enabled && props.processingAllowed) {
              props.onChange({ ...props.value, enabled: false });
            } else {
              props.onRequestProcessing();
            }
          }}
        />
      </View>
      {props.value.enabled && !props.processingAllowed ? (
        <View style={{ gap: 7, padding: 11, borderRadius: chrome.radius.md, backgroundColor: chrome.warningFill }}>
          <Text style={{ color: '#FFE0A6', fontSize: 12, lineHeight: 17 }}>
            Background removal is paused until you review its on-device AI metrics disclosure.
          </Text>
          <Chip label="Review and enable" active onPress={props.onRequestProcessing} />
        </View>
      ) : null}
      {props.value.enabled && props.processingAllowed ? <>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          <Chip label={props.value.source ? `Background: ${props.value.source.displayName}` : 'Choose background'} active={Boolean(props.value.source)} onPress={props.onChooseMedia} />
          <Chip label="Clear background" onPress={() => props.onChange({ ...props.value, source: undefined })} />
        </ScrollView>
        <Text style={{ color: '#B8C1CC', fontSize: 11, fontWeight: '800' }}>HUMAN EDGE QUALITY</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          <Chip label="Stable" active={props.value.mask.qualityPreset === 'stable'} onPress={() => applyPreset('stable')} />
          <Chip label="Balanced" active={props.value.mask.qualityPreset === 'balanced'} onPress={() => applyPreset('balanced')} />
          <Chip label="Detailed" active={props.value.mask.qualityPreset === 'detailed'} onPress={() => applyPreset('detailed')} />
        </ScrollView>
        <Text style={{ color: '#939EAB', fontSize: 11 }}>
          Stable reduces flicker around fast hands and hair. Detailed preserves more fine edges. Balanced sits between them.
        </Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          <Chip label="Hold −" onPress={() => updateMask({ temporalStability: clamp(props.value.mask.temporalStability - 0.05, 0, 0.92) })} />
          <Chip label={`Hold ${Math.round(props.value.mask.temporalStability * 100)}%`} active />
          <Chip label="Hold +" onPress={() => updateMask({ temporalStability: clamp(props.value.mask.temporalStability + 0.05, 0, 0.92) })} />
          <Chip label="Feather −" onPress={() => updateMask({ edgeFeather: clamp(props.value.mask.edgeFeather - 0.05, 0, 1) })} />
          <Chip label={`Feather ${Math.round(props.value.mask.edgeFeather * 100)}%`} active />
          <Chip label="Feather +" onPress={() => updateMask({ edgeFeather: clamp(props.value.mask.edgeFeather + 0.05, 0, 1) })} />
          <Chip label="Less subject" onPress={() => updateMask({ threshold: clamp(props.value.mask.threshold + 0.05, 0, 1) })} />
          <Chip label="More subject" onPress={() => updateMask({ threshold: clamp(props.value.mask.threshold - 0.05, 0, 1) })} />
        </ScrollView>
        <Text style={{ color: '#B8C1CC', fontSize: 11, fontWeight: '800' }}>PERSON SIZE & POSITION</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          <Chip label="Smaller" onPress={() => updateTransform({ scale: clamp(transform.scale - 0.1, 0.05, 8) })} />
          <Chip label={`${Math.round(transform.scale * 100)}%`} active onPress={() => updateTransform({ scale: 1 })} />
          <Chip label="Larger" onPress={() => updateTransform({ scale: clamp(transform.scale + 0.1, 0.05, 8) })} />
          <Chip label="Left" onPress={() => updateTransform({ position: { ...transform.position, x: clamp(transform.position.x - 0.05, -1, 2) } })} />
          <Chip label="Right" onPress={() => updateTransform({ position: { ...transform.position, x: clamp(transform.position.x + 0.05, -1, 2) } })} />
          <Chip label="Up" onPress={() => updateTransform({ position: { ...transform.position, y: clamp(transform.position.y - 0.05, -1, 2) } })} />
          <Chip label="Down" onPress={() => updateTransform({ position: { ...transform.position, y: clamp(transform.position.y + 0.05, -1, 2) } })} />
          <Chip label="Rotate −5°" onPress={() => updateTransform({ rotation: transform.rotation - 5 })} />
          <Chip label="Rotate +5°" onPress={() => updateTransform({ rotation: transform.rotation + 5 })} />
        </ScrollView>
        <Text style={{ color: '#B8C1CC', fontSize: 11, fontWeight: '800' }}>MOTION PATH · {formatTime(props.currentTimeMs)}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          <Chip label="Add path point here" active onPress={props.onAddKeyframe} />
          <Chip label="Remove nearest point" onPress={props.onRemoveNearestKeyframe} />
          <Chip label={`${props.value.keyframes.length} path points`} />
        </ScrollView>
        <Text style={{ color: '#939EAB', fontSize: 11 }}>
          With no path points, the person stays put. Add points at different timeline positions to animate between them automatically.
        </Text>
      </> : null}
    </View>
  );
}

function Chip(props: { label: string; active?: boolean; onPress?: () => void }) {
  return <Pressable disabled={!props.onPress} onPress={props.onPress} style={{ minHeight: 42, justifyContent: 'center', paddingHorizontal: 13, borderRadius: chrome.radius.md, borderWidth: 1, borderColor: props.active ? chrome.accent : chrome.hairline, backgroundColor: props.active ? '#1A3A48' : chrome.surfaceRaised }}>
    <Text numberOfLines={1} style={{ maxWidth: 220, color: props.active ? chrome.accent : chrome.text, fontSize: 12, fontWeight: '700' }}>{props.label}</Text>
  </Pressable>;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatTime(ms: number) {
  const seconds = Math.max(0, ms) / 1000;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
}
