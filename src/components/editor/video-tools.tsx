import { useMemo, useRef, useState } from 'react';
import { type GestureResponderEvent, Modal, PanResponder, Pressable, ScrollView, Text, View } from 'react-native';

import type { CaptionProject, VideoTransform } from '@/types/project';

const presets: { id: CaptionProject['canvas']['preset']; label: string }[] = [
  { id: 'source', label: 'Original' },
  { id: '9:16', label: '9:16 TikTok' },
  { id: '16:9', label: '16:9' },
  { id: '1:1', label: '1:1' },
  { id: '4:5', label: '4:5' },
];

export function VideoTools(props: {
  canvas: CaptionProject['canvas'];
  transform: VideoTransform;
  onCanvasPreset: (preset: CaptionProject['canvas']['preset']) => void;
  onFit: (fit: CaptionProject['videoTransform']['fit']) => void;
  onScale: (scale: number) => void;
  onRotation: (degrees: number) => void;
  onReset: () => void;
  onTransformEnd: () => void;
}) {
  const [rotationOpen, setRotationOpen] = useState(false);
  const scalePercent = Math.round(props.transform.scale * 100);

  return (
    <View style={{ gap: 8 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {presets.map((preset) => (
          <ToolChip
            key={preset.id}
            label={preset.label}
            active={props.canvas.preset === preset.id}
            onPress={() => props.onCanvasPreset(preset.id)}
          />
        ))}
      </ScrollView>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        <ToolChip label="Fit" active={props.transform.fit === 'fit'} onPress={() => props.onFit('fit')} />
        <ToolChip label="Fill screen" active={props.transform.fit === 'fill'} onPress={() => props.onFit('fill')} />
        <ToolChip
          label="− Size"
          onPress={() => {
            props.onScale(clamp(props.transform.scale - 0.1, 0.2, 5));
            props.onTransformEnd();
          }}
        />
        <ToolChip label={`${scalePercent}%`} active={scalePercent !== 100} onPress={() => { props.onScale(1); props.onTransformEnd(); }} />
        <ToolChip
          label="+ Size"
          onPress={() => {
            props.onScale(clamp(props.transform.scale + 0.1, 0.2, 5));
            props.onTransformEnd();
          }}
        />
        <ToolChip
          label="Rotate 90°"
          onPress={() => {
            props.onRotation(normalizeDegrees(props.transform.rotation + 90));
            props.onTransformEnd();
          }}
        />
        <ToolChip label={`Angle ${Math.round(props.transform.rotation)}°`} onPress={() => setRotationOpen(true)} />
        <ToolChip label="Reset video" onPress={props.onReset} />
      </ScrollView>

      <Text style={{ color: '#929CAA', fontSize: 11 }}>
        On the preview: drag to move, pinch to resize, and twist with two fingers to rotate.
      </Text>

      <RotationModal
        visible={rotationOpen}
        value={props.transform.rotation}
        onChange={props.onRotation}
        onChangeEnd={props.onTransformEnd}
        onClose={() => {
          props.onTransformEnd();
          setRotationOpen(false);
        }}
      />
    </View>
  );
}

function RotationModal(props: {
  visible: boolean;
  value: number;
  onChange: (degrees: number) => void;
  onChangeEnd: () => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.66)' }}>
        <View style={{ gap: 18, padding: 22, paddingBottom: 34, borderTopLeftRadius: 26, borderTopRightRadius: 26, backgroundColor: '#171C22' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View>
              <Text style={{ color: '#F7F8FA', fontSize: 21, fontWeight: '800' }}>Free video rotation</Text>
              <Text style={{ color: '#939EAB', marginTop: 3 }}>Slide anywhere on the wide angle bar</Text>
            </View>
            <Pressable onPress={props.onClose} hitSlop={12}>
              <Text style={{ color: '#DFFF35', fontWeight: '800' }}>Done</Text>
            </Pressable>
          </View>

          <AngleScrubber value={props.value} onChange={props.onChange} onEnd={props.onChangeEnd} />

          <Text style={{ color: '#F7F8FA', textAlign: 'center', fontSize: 28, fontWeight: '900', fontVariant: ['tabular-nums'] }}>
            {Math.round(props.value)}°
          </Text>

          <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 8 }}>
            <ToolChip label="−1°" onPress={() => { props.onChange(normalizeDegrees(props.value - 1)); props.onChangeEnd(); }} />
            <ToolChip label="0°" active={Math.round(props.value) === 0} onPress={() => { props.onChange(0); props.onChangeEnd(); }} />
            <ToolChip label="+1°" onPress={() => { props.onChange(normalizeDegrees(props.value + 1)); props.onChangeEnd(); }} />
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 8 }}>
            {[-180, -90, 90, 180].map((degrees) => (
              <ToolChip
                key={degrees}
                label={`${degrees}°`}
                active={Math.round(props.value) === degrees}
                onPress={() => {
                  props.onChange(degrees);
                  props.onChangeEnd();
                }}
              />
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}

function AngleScrubber(props: { value: number; onChange: (value: number) => void; onEnd: () => void }) {
  const trackRef = useRef<View>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const layout = useRef({ pageX: 0, width: 1 });
  const update = (event: GestureResponderEvent) => {
    const touch = event.nativeEvent.touches[0] ?? event.nativeEvent.changedTouches[0];
    const pageX = touch?.pageX ?? event.nativeEvent.pageX;
    const ratio = clamp((pageX - layout.current.pageX) / layout.current.width, 0, 1);
    propsRef.current.onChange(normalizeDegrees(-180 + ratio * 360));
  };
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: update,
        onPanResponderMove: update,
        onPanResponderRelease: () => propsRef.current.onEnd(),
        onPanResponderTerminate: () => propsRef.current.onEnd(),
      }),
    [],
  );

  const percent = ((normalizeDegrees(props.value) + 180) / 360) * 100;
  return (
    <View
      ref={trackRef}
      collapsable={false}
      {...responder.panHandlers}
      onLayout={({ nativeEvent }) => {
        layout.current.width = Math.max(1, nativeEvent.layout.width);
        trackRef.current?.measureInWindow((pageX, _pageY, width) => {
          layout.current = { pageX, width: Math.max(1, width) };
        });
      }}
      style={{ height: 64, justifyContent: 'center' }}>
      <View pointerEvents="none" style={{ height: 10, borderRadius: 5, backgroundColor: '#303842' }}>
        <View style={{ width: `${percent}%`, height: '100%', borderRadius: 5, backgroundColor: '#9CB328' }} />
      </View>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: `${percent}%`,
          width: 34,
          height: 34,
          marginLeft: -17,
          borderRadius: 17,
          borderWidth: 3,
          borderColor: '#11140C',
          backgroundColor: '#DFFF35',
        }}
      />
    </View>
  );
}

function ToolChip(props: { label: string; active?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={props.onPress}
      hitSlop={4}
      style={{
        minHeight: 44,
        justifyContent: 'center',
        paddingHorizontal: 14,
        borderRadius: 13,
        borderWidth: 1,
        borderColor: props.active ? '#DFFF35' : '#303842',
        backgroundColor: props.active ? '#29331D' : '#20262E',
      }}>
      <Text style={{ color: props.active ? '#DFFF35' : '#F7F8FA', fontSize: 12, fontWeight: '700' }}>{props.label}</Text>
    </Pressable>
  );
}

function normalizeDegrees(value: number) {
  let result = value % 360;
  if (result > 180) result -= 360;
  if (result < -180) result += 360;
  return result;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
