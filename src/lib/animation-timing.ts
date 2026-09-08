import { findAnimationPreset } from '@/lib/animation-presets';
import type { CaptionAnimationId } from '@/types/project';

export type CaptionAnimationClock = {
  entryProgress: number;
  phase: number;
};

export type CaptionAnimationState = {
  translateX: number;
  translateY: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity: number;
  glow: number;
};

const IDENTITY_STATE: CaptionAnimationState = {
  translateX: 0,
  translateY: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  opacity: 1,
  glow: 0,
};

export function captionAnimationClock(options: {
  currentMs: number;
  captionStartMs: number;
  captionEndMs: number;
  animationDurationMs: number;
}): CaptionAnimationClock {
  const captionDurationMs = Math.max(1, options.captionEndMs - options.captionStartMs);
  const cycleDurationMs = Math.max(1, options.animationDurationMs);
  const entryDurationMs = Math.min(captionDurationMs, cycleDurationMs);
  const elapsedMs = Math.max(0, options.currentMs - options.captionStartMs);
  return {
    entryProgress: clamp(elapsedMs / entryDurationMs, 0, 1),
    phase: elapsedMs / cycleDurationMs,
  };
}

export function realWordAnimationProgress(
  currentMs: number,
  activeWord?: { startMs: number; endMs: number },
) {
  if (
    !activeWord
    || !Number.isFinite(activeWord.startMs)
    || !Number.isFinite(activeWord.endMs)
    || activeWord.endMs <= activeWord.startMs
    || currentMs < activeWord.startMs
    || currentMs >= activeWord.endMs
  ) {
    return undefined;
  }
  return clamp((currentMs - activeWord.startMs) / (activeWord.endMs - activeWord.startMs), 0, 1);
}

export function isWordTimedAnimation(id: CaptionAnimationId) {
  return findAnimationPreset(id).timing === 'word';
}

export function isActiveWordHighlightAnimation(id: CaptionAnimationId) {
  return findAnimationPreset(id).colorBehavior === 'active-word';
}

export function captionAnimationState(
  id: CaptionAnimationId,
  clock: CaptionAnimationClock,
  rawIntensity: number,
): CaptionAnimationState {
  const entry = clamp(clock.entryProgress, 0, 1);
  const phase = Math.max(0, clock.phase);
  const intensity = clamp(rawIntensity, 0, 1);
  const eased = 1 - Math.pow(1 - entry, 3);
  switch (id) {
    case 'fade-in':
      return { ...IDENTITY_STATE, opacity: eased };
    case 'drop-in':
      return { ...IDENTITY_STATE, opacity: entry, translateY: (1 - eased) * -(45 + intensity * 100) };
    case 'swing':
      return { ...IDENTITY_STATE, opacity: entry, rotation: Math.sin((1 - entry) * Math.PI * 3) * (10 + intensity * 30) };
    case 'heartbeat': {
      const beat = Math.pow(Math.max(0, Math.sin(phase * Math.PI * 4)), 4);
      const scale = 1 + beat * (0.08 + intensity * 0.16);
      return { ...IDENTITY_STATE, scaleX: scale, scaleY: scale };
    }
    case 'flicker':
      return { ...IDENTITY_STATE, opacity: entry < 0.9 && Math.sin(entry * Math.PI * 9) <= -0.15 ? 0.18 : 1 };
    case 'tilt-in':
      return {
        ...IDENTITY_STATE,
        opacity: entry,
        translateX: (1 - eased) * (40 + intensity * 80),
        rotation: (1 - eased) * (20 + intensity * 35),
      };
    case 'squash':
      return { ...IDENTITY_STATE, opacity: entry, scaleX: 0.55 + eased * 0.45, scaleY: 1.55 - eased * 0.55 };
    case 'stretch':
      return { ...IDENTITY_STATE, opacity: entry, scaleX: 1.45 - eased * 0.45, scaleY: 0.35 + eased * 0.65 };
    case 'slide-up':
      return { ...IDENTITY_STATE, opacity: entry, translateY: (1 - eased) * (35 + intensity * 80) };
    case 'slide-left':
      return { ...IDENTITY_STATE, opacity: entry, translateX: (1 - eased) * -(55 + intensity * 120) };
    case 'slide-right':
      return { ...IDENTITY_STATE, opacity: entry, translateX: (1 - eased) * (55 + intensity * 120) };
    case 'zoom-in': {
      const scale = 0.15 + eased * 0.85;
      return { ...IDENTITY_STATE, opacity: entry, scaleX: scale, scaleY: scale };
    }
    case 'zoom-out': {
      const scale = 1 + (1 - eased) * (0.7 + intensity * 0.8);
      return { ...IDENTITY_STATE, opacity: entry, scaleX: scale, scaleY: scale };
    }
    case 'spin-in': {
      const scale = 0.5 + eased * 0.5;
      return { ...IDENTITY_STATE, opacity: entry, rotation: (1 - eased) * -270, scaleX: scale, scaleY: scale };
    }
    case 'roll-in':
      return {
        ...IDENTITY_STATE,
        opacity: entry,
        translateX: (1 - eased) * -(70 + intensity * 130),
        rotation: (1 - eased) * -(180 + intensity * 180),
      };
    case 'spiral-in': {
      const radius = (1 - eased) * (45 + intensity * 75);
      const angle = (1 - eased) * Math.PI * 2;
      const scale = 0.25 + eased * 0.75;
      return {
        ...IDENTITY_STATE,
        opacity: entry,
        translateX: Math.cos(angle) * radius,
        translateY: Math.sin(angle) * radius,
        rotation: (1 - eased) * 360,
        scaleX: scale,
        scaleY: scale,
      };
    }
    case 'snap-in': {
      const wobble = Math.sin(entry * Math.PI * 3) * (1 - entry);
      const scale = 1 + wobble * (0.16 + intensity * 0.18);
      return { ...IDENTITY_STATE, opacity: Math.min(1, entry * 3), scaleX: scale, scaleY: scale };
    }
    case 'recoil': {
      const recoil = Math.sin(entry * Math.PI * 4) * (1 - entry);
      return {
        ...IDENTITY_STATE,
        opacity: Math.min(1, entry * 4),
        translateX: -recoil * (12 + intensity * 32),
        scaleX: 1 + recoil * (0.08 + intensity * 0.12),
        scaleY: 1 - recoil * 0.06,
        rotation: recoil * (4 + intensity * 8),
      };
    }
    case 'shake':
      return {
        ...IDENTITY_STATE,
        translateX: Math.sin(phase * Math.PI * 12) * (4 + intensity * 16),
        rotation: Math.sin(phase * Math.PI * 9) * 2,
      };
    case 'glow-pulse': {
      const pulse = Math.sin(phase * Math.PI * 2);
      const scale = 1 + pulse * (0.02 + intensity * 0.06);
      return { ...IDENTITY_STATE, scaleX: scale, scaleY: scale, glow: Math.abs(pulse) };
    }
    case 'breathe': {
      const pulse = Math.sin(phase * Math.PI * 2);
      const scale = 1 + pulse * (0.025 + intensity * 0.055);
      return { ...IDENTITY_STATE, scaleX: scale, scaleY: scale };
    }
    case 'float': {
      const angle = phase * Math.PI * 2;
      return {
        ...IDENTITY_STATE,
        translateX: Math.cos(angle) * (2 + intensity * 6),
        translateY: Math.sin(angle) * (4 + intensity * 10),
      };
    }
    case 'wobble':
      return { ...IDENTITY_STATE, rotation: Math.sin(phase * Math.PI * 2) * (2 + intensity * 9) };
    case 'drift':
      return {
        ...IDENTITY_STATE,
        translateX: Math.sin(phase * Math.PI * 2) * (4 + intensity * 14),
        translateY: Math.cos(phase * Math.PI * 1.5) * (3 + intensity * 8),
      };
    case 'pulse': {
      const beat = Math.abs(Math.sin(phase * Math.PI * 2));
      const scale = 1 + beat * (0.04 + intensity * 0.1);
      return { ...IDENTITY_STATE, scaleX: scale, scaleY: scale };
    }
    case 'elastic': {
      const wobble = Math.sin(entry * Math.PI * 5) * (1 - entry);
      return {
        ...IDENTITY_STATE,
        opacity: Math.min(1, entry * 2.5),
        scaleX: 1 + wobble * (0.35 + intensity),
        scaleY: 1 - wobble * 0.18,
      };
    }
    case 'flip':
      return {
        ...IDENTITY_STATE,
        opacity: entry,
        scaleX: Math.max(0.03, Math.abs(Math.cos((1 - eased) * 95 * Math.PI / 180))),
      };
    case 'stomp': {
      const scale = 1 + Math.sin(entry * Math.PI) * intensity * 0.35;
      return {
        ...IDENTITY_STATE,
        opacity: entry,
        translateY: (1 - eased) * -(50 + intensity * 100),
        scaleX: scale,
        scaleY: scale,
      };
    }
    case 'lean-in':
      return {
        ...IDENTITY_STATE,
        opacity: entry,
        translateX: (1 - eased) * -(35 + intensity * 85),
        rotation: (1 - eased) * -(12 + intensity * 24),
      };
    case 'rise-spin':
      return {
        ...IDENTITY_STATE,
        opacity: entry,
        translateY: (1 - eased) * (45 + intensity * 90),
        rotation: (1 - eased) * (110 + intensity * 170),
      };
    case 'soft-land': {
      const landing = Math.sin(entry * Math.PI * 2) * (1 - entry);
      return {
        ...IDENTITY_STATE,
        opacity: entry,
        translateY: (1 - eased) * (24 + intensity * 50) - landing * (8 + intensity * 14),
        scaleX: 1 + landing * 0.04,
        scaleY: 1 - landing * (0.05 + intensity * 0.08),
      };
    }
    case 'rubber-drop': {
      const spring = Math.sin(entry * Math.PI * 4) * (1 - entry);
      return {
        ...IDENTITY_STATE,
        opacity: Math.min(1, entry * 3),
        translateY: (1 - eased) * -(60 + intensity * 120),
        scaleX: 1 + spring * (0.16 + intensity * 0.18),
        scaleY: 1 - spring * (0.12 + intensity * 0.12),
      };
    }
    case 'cinema-fade': {
      const scale = 0.92 + eased * 0.08;
      return {
        ...IDENTITY_STATE,
        opacity: eased,
        translateY: (1 - eased) * (10 + intensity * 18),
        scaleX: scale,
        scaleY: scale,
      };
    }
    default:
      return { ...IDENTITY_STATE };
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
