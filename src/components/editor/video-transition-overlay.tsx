import { View } from 'react-native';

import type { VideoTransitionType } from '@/types/project';

type Overlay = { type: VideoTransitionType; color: string; opacity: number; phase: number };

export function VideoTransitionOverlay({ overlay }: { overlay?: Overlay }) {
  if (!overlay) return null;
  const progress = overlay.phase <= 1 ? overlay.phase : 2 - overlay.phase;
  const outgoing = overlay.phase <= 1;
  const pct = `${Math.round(progress * 100)}%` as const;
  const inversePct = `${Math.round((1 - progress) * 100)}%` as const;
  const common = { position: 'absolute' as const, backgroundColor: overlay.color };

  if (overlay.type.startsWith('wipe-') || overlay.type.startsWith('slide-')) {
    const direction = overlay.type.endsWith('left') ? 'left' : overlay.type.endsWith('right') ? 'right' : overlay.type.endsWith('up') ? 'top' : 'bottom';
    const horizontal = direction === 'left' || direction === 'right';
    return (
      <View pointerEvents="none" style={{ position: 'absolute', inset: 0 }}>
        <View style={{ ...common, [direction]: 0, width: horizontal ? (outgoing ? pct : inversePct) : '100%', height: horizontal ? '100%' : (outgoing ? pct : inversePct), opacity: 0.96 }} />
      </View>
    );
  }
  if (overlay.type === 'shutter') {
    return <View pointerEvents="none" style={{ position: 'absolute', inset: 0, flexDirection: 'row' }}>{[0, 1, 2, 3, 4, 5].map((index) => <View key={index} style={{ flex: 1, backgroundColor: '#050608', opacity: index % 2 ? progress : Math.min(1, progress * 1.25) }} />)}</View>;
  }
  if (overlay.type === 'glitch') {
    return <View pointerEvents="none" style={{ position: 'absolute', inset: 0 }}>{['#FF1744', '#00E5FF', '#76FF03', '#651FFF', '#FFEA00'].map((color, index) => <View key={color} style={{ position: 'absolute', left: `${(index * 23 + progress * 31) % 85}%`, top: `${index * 19}%`, width: `${18 + index * 4}%`, height: '13%', backgroundColor: color, opacity: progress * 0.62, transform: [{ translateX: (index % 2 ? -1 : 1) * progress * 24 }] }} />)}</View>;
  }
  if (overlay.type === 'zoom-in' || overlay.type === 'zoom-out' || overlay.type === 'spin') {
    const scale = overlay.type === 'zoom-out' ? 1.8 - progress * 0.8 : 0.2 + progress * 0.8;
    return <View pointerEvents="none" style={{ position: 'absolute', inset: -80, borderWidth: 90, borderColor: overlay.color, opacity: progress, transform: [{ scale }, ...(overlay.type === 'spin' ? [{ rotate: `${progress * 210}deg` as const }] : [])] }} />;
  }
  return <View pointerEvents="none" style={{ position: 'absolute', inset: 0, backgroundColor: overlay.color, opacity: overlay.type === 'fade-dark' ? overlay.opacity * 0.75 : overlay.opacity }} />;
}
