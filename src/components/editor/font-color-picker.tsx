import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View, type GestureResponderEvent } from 'react-native';
import { fontChoicePatch, type FontChoice, type FontColors } from '@/lib/font-style-choice';
import { chrome } from '@/lib/ui-theme';

type HSV = { h: number; s: number; v: number };
const SIZE = 224;
const RADIUS = SIZE / 2;
const clamp = (value: number) => Math.max(0, Math.min(1, value));

function hex({ h, s, v }: HSV) {
  const channel = (offset: number) => {
    const k = (offset + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))).toString(16).padStart(2, '0');
  };
  return `#${channel(5)}${channel(3)}${channel(1)}`.toUpperCase();
}

function hsv(color: string): HSV {
  const [r, g, b] = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const h = delta === 0 ? 0 : max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { h: h * 60, s: max === 0 ? 0 : delta / max, v: max };
}

export function FontColorPicker(props: {
  choice: FontChoice;
  previewText: string;
  onBack: () => void;
  onSave: (colors: FontColors) => void;
}) {
  const [colors, setColors] = useState<FontColors>(() => {
    const patch = fontChoicePatch(props.choice);
    return { primary: patch.textColor!, secondary: patch.secondaryTextColor! };
  });
  const [tab, setTab] = useState<keyof FontColors>('primary');
  const dual = props.choice.treatment !== 'solid';
  return (
    <View accessibilityViewIsModal style={{ position: 'absolute', inset: 0, backgroundColor: '#00000099', justifyContent: 'center', padding: 16 }}>
      <View style={{ maxHeight: '100%', backgroundColor: chrome.surface, borderRadius: chrome.radius.lg, padding: 18, gap: 14 }}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 14, alignItems: 'center' }}>
          <Text style={{ color: chrome.text, fontSize: 22, fontWeight: '700' }}>{props.choice.name}</Text>
          <View style={{ minHeight: 46, width: '100%', justifyContent: 'center' }}>
            {dual ? <Text numberOfLines={1} style={{ position: 'absolute', left: 2, right: -2, top: 4, color: colors.secondary, fontFamily: props.choice.font.family, fontSize: 28 }}>{props.previewText}</Text> : null}
            <Text numberOfLines={1} style={{ color: colors.primary, fontFamily: props.choice.font.family, fontSize: 28 }}>{props.previewText}</Text>
          </View>
          {dual ? <View accessibilityRole="tablist" style={{ flexDirection: 'row', gap: 12 }}>
            {(['primary', 'secondary'] as const).map((key, index) => (
              <Pressable key={key} accessibilityRole="tab" accessibilityState={{ selected: tab === key }} onPress={() => setTab(key)} style={{ padding: 12, borderRadius: 12, backgroundColor: tab === key ? chrome.surfaceRaised : chrome.background }}>
                <Text style={{ color: chrome.text }}>Color {index + 1}</Text>
                <View style={{ height: 5, marginTop: 6, backgroundColor: colors[key] }} />
              </Pressable>
            ))}
          </View> : <Text style={{ color: chrome.text }}>Color</Text>}
          <ColorWheel key={tab} color={colors[tab]} onChange={(color) => setColors((current) => ({ ...current, [tab]: color }))} />
        </ScrollView>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <Pressable accessibilityRole="button" onPress={props.onBack} style={{ flex: 1, padding: 16, alignItems: 'center', borderRadius: 12, backgroundColor: chrome.surfaceRaised }}>
            <Text style={{ color: chrome.text, fontWeight: '700' }}>Back</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => props.onSave(colors)} style={{ flex: 1, padding: 16, alignItems: 'center', borderRadius: 12, backgroundColor: chrome.accent }}>
            <Text style={{ color: chrome.accentInk, fontWeight: '700' }}>Save</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function ColorWheel(props: { color: string; onChange: (color: string) => void }) {
  const [value, setValue] = useState(() => hsv(props.color));
  const [input, setInput] = useState(props.color);
  const update = (next: HSV) => {
    setValue(next);
    const color = hex(next);
    setInput(color);
    props.onChange(color);
  };
  const wheelTouch = (event: GestureResponderEvent) => {
    const x = event.nativeEvent.locationX - RADIUS, y = event.nativeEvent.locationY - RADIUS;
    update({ ...value, h: (Math.atan2(x, -y) * 180 / Math.PI + 360) % 360, s: clamp(Math.hypot(x, y) / RADIUS) });
  };
  const brightnessTouch = (event: GestureResponderEvent) => update({ ...value, v: clamp(event.nativeEvent.locationX / SIZE) });
  return (
    <View style={{ alignItems: 'center', gap: 14 }}>
      <View accessibilityLabel="Color wheel" onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true} onResponderGrant={wheelTouch} onResponderMove={wheelTouch} style={{ width: SIZE, height: SIZE, borderRadius: RADIUS, overflow: 'hidden', backgroundColor: '#FFFFFF' }}>
        <View pointerEvents="none" style={{ position: 'absolute', inset: 0 }}>
          {Array.from({ length: 72 }, (_, i) => <View key={i} style={{ position: 'absolute', inset: 0, transform: [{ rotate: `${i * 5}deg` }] }}>
            <View style={{ position: 'absolute', left: RADIUS - 6, borderLeftWidth: 6, borderRightWidth: 6, borderTopWidth: RADIUS, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: hex({ h: i * 5, s: 1, v: 1 }) }} />
          </View>)}
          {Array.from({ length: 16 }, (_, i) => <View key={i} style={{ position: 'absolute', inset: i * 7, borderRadius: RADIUS, borderWidth: 7, borderColor: `rgba(255,255,255,${(i + 0.5) / 16})` }} />)}
          <View style={{ position: 'absolute', inset: 0, backgroundColor: '#000000', opacity: 1 - value.v }} />
          <View style={{ position: 'absolute', left: RADIUS + Math.sin(value.h * Math.PI / 180) * value.s * (RADIUS - 7) - 7, top: RADIUS - Math.cos(value.h * Math.PI / 180) * value.s * (RADIUS - 7) - 7, width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: '#FFFFFF', backgroundColor: props.color }} />
        </View>
      </View>
      <Text style={{ color: chrome.muted }}>Brightness</Text>
      <View accessibilityRole="adjustable" accessibilityLabel="Brightness" accessibilityValue={{ min: 0, max: 100, now: Math.round(value.v * 100) }} accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]} onAccessibilityAction={(event) => update({ ...value, v: clamp(value.v + (event.nativeEvent.actionName === 'increment' ? 0.05 : -0.05)) })} onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true} onResponderGrant={brightnessTouch} onResponderMove={brightnessTouch} style={{ width: SIZE, height: 32 }}>
        <View pointerEvents="none" style={{ flexDirection: 'row', flex: 1 }}>
          {Array.from({ length: 32 }, (_, i) => <View key={i} style={{ flex: 1, backgroundColor: hex({ ...value, v: i / 31 }) }} />)}
          <View style={{ position: 'absolute', left: value.v * (SIZE - 4), top: 0, bottom: 0, width: 4, backgroundColor: '#FFFFFF' }} />
        </View>
      </View>
      <TextInput accessibilityLabel="Hex color" value={input} autoCapitalize="characters" autoCorrect={false} maxLength={7} onChangeText={(text) => {
        setInput(text);
        if (/^#[0-9a-f]{6}$/i.test(text)) { setValue(hsv(text)); props.onChange(text.toUpperCase()); }
      }} onBlur={() => setInput(props.color)} style={{ color: chrome.text, backgroundColor: chrome.background, borderRadius: 12, padding: 12, width: SIZE, textAlign: 'center' }} />
    </View>
  );
}
