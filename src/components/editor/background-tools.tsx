import { Pressable, ScrollView, Text, View } from 'react-native';

import type { BackgroundReplacement } from '@/types/project';

export function BackgroundTools(props: {
  value: BackgroundReplacement;
  currentTimeMs: number;
  onChooseMedia: () => void;
  onChange: (next: BackgroundReplacement) => void;
  onAddKeyframe: () => void;
  onRemoveNearestKeyframe: () => void;
}) {
  const updateTransform = (patch: Partial<BackgroundReplacement['personTransform']>) => {
    props.onChange({ ...props.value, personTransform: { ...props.value.personTransform, ...patch } });
  };
  const transform = props.value.personTransform;
  return (
    <View style={{ gap: 9, padding: 12, borderRadius: 16, backgroundColor: '#151A20' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: '#F7F8FA', fontSize: 14, fontWeight: '900' }}>Remove video background</Text>
          <Text style={{ color: '#939EAB', fontSize: 11, marginTop: 2 }}>Runs privately on this phone. No green screen required.</Text>
        </View>
        <Chip label={props.value.enabled ? 'On' : 'Off'} active={props.value.enabled} onPress={() => props.onChange({ ...props.value, enabled: !props.value.enabled })} />
      </View>
      {props.value.enabled ? <>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          <Chip label={props.value.source ? `Background: ${props.value.source.displayName}` : 'Choose background'} active={Boolean(props.value.source)} onPress={props.onChooseMedia} />
          <Chip label="Clear background" onPress={() => props.onChange({ ...props.value, source: undefined })} />
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
          <Chip label={`${props.value.keyframes.length} path points`} onPress={() => {}} />
        </ScrollView>
        <Text style={{ color: '#939EAB', fontSize: 11 }}>
          With no path points, the person stays put. Add points at different timeline positions to animate between them automatically.
        </Text>
      </> : null}
    </View>
  );
}

function Chip(props: { label: string; active?: boolean; onPress: () => void }) {
  return <Pressable onPress={props.onPress} style={{ minHeight: 42, justifyContent: 'center', paddingHorizontal: 13, borderRadius: 12, borderWidth: 1, borderColor: props.active ? '#DFFF35' : '#303842', backgroundColor: props.active ? '#29331D' : '#20262E' }}>
    <Text numberOfLines={1} style={{ maxWidth: 220, color: props.active ? '#DFFF35' : '#F7F8FA', fontSize: 12, fontWeight: '800' }}>{props.label}</Text>
  </Pressable>;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatTime(ms: number) {
  const seconds = Math.max(0, ms) / 1000;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
}
