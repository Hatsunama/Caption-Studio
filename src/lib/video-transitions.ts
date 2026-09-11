export const VIDEO_TRANSITION_PRESETS = [
  { id: 'none', name: 'Clean cut', description: 'No transition', durationMs: 0 },
  { id: 'dip-black', name: 'Dip to black', description: 'Classic cinematic dip', durationMs: 500 },
  { id: 'dip-white', name: 'Dip to white', description: 'Bright clean dip', durationMs: 500 },
  { id: 'flash', name: 'Camera flash', description: 'Fast white burst', durationMs: 350 },
  { id: 'fade-dark', name: 'Soft dark fade', description: 'Gentler dark fade', durationMs: 800 },
  { id: 'crossfade', name: 'Cross dissolve', description: 'Smoothly blends both clips', durationMs: 650 },
  { id: 'push-left', name: 'Push left', description: 'The next clip pushes the current clip left', durationMs: 600 },
  { id: 'push-right', name: 'Push right', description: 'The next clip pushes the current clip right', durationMs: 600 },
  { id: 'push-up', name: 'Push up', description: 'The next clip pushes the current clip upward', durationMs: 600 },
  { id: 'push-down', name: 'Push down', description: 'The next clip pushes the current clip downward', durationMs: 600 },
  { id: 'zoom-in', name: 'Zoom burst', description: 'Pushes through the cut', durationMs: 500 },
  { id: 'zoom-out', name: 'Zoom pullback', description: 'Pulls away from the cut', durationMs: 500 },
  { id: 'spin', name: 'Spin flash', description: 'Rotating radial flash', durationMs: 600 },
  { id: 'fold-horizontal', name: 'Horizontal fold', description: 'Unfolds the next clip from the center', durationMs: 650 },
  { id: 'fold-vertical', name: 'Vertical fold', description: 'Unfolds the next clip from the center', durationMs: 650 },
  { id: 'iris-circle', name: 'Circle iris', description: 'Opens the next clip through a circle', durationMs: 700 },
  { id: 'iris-diamond', name: 'Diamond iris', description: 'Opens the next clip through a diamond', durationMs: 700 },
  { id: 'split-horizontal', name: 'Horizontal split', description: 'Opens outward from a horizontal seam', durationMs: 650 },
  { id: 'split-vertical', name: 'Vertical split', description: 'Opens outward from a vertical seam', durationMs: 650 },
  { id: 'shutter', name: 'Shutter', description: 'Closing camera blades', durationMs: 500 },
  { id: 'color-wash-cyan', name: 'Electric cyan wash', description: 'A bright cyan color wash bridges the cut', durationMs: 520 },
  { id: 'color-wash-magenta', name: 'Hot pink wash', description: 'A vivid magenta color wash bridges the cut', durationMs: 520 },
] as const;

export type TransitionPreset = (typeof VIDEO_TRANSITION_PRESETS)[number];
export type VideoTransitionType = TransitionPreset['id'];
export type VideoTransitionPreviewKind =
  | 'none'
  | 'cover'
  | 'crossfade'
  | 'directional'
  | 'zoom'
  | 'fold'
  | 'iris'
  | 'split'
  | 'shutter';

const TRANSITION_PREVIEW_KINDS: Record<VideoTransitionType, VideoTransitionPreviewKind> = {
  none: 'none',
  'dip-black': 'cover',
  'dip-white': 'cover',
  flash: 'cover',
  'fade-dark': 'cover',
  crossfade: 'crossfade',
  'push-left': 'directional',
  'push-right': 'directional',
  'push-up': 'directional',
  'push-down': 'directional',
  'zoom-in': 'zoom',
  'zoom-out': 'zoom',
  spin: 'zoom',
  'fold-horizontal': 'fold',
  'fold-vertical': 'fold',
  'iris-circle': 'iris',
  'iris-diamond': 'iris',
  'split-horizontal': 'split',
  'split-vertical': 'split',
  shutter: 'shutter',
  'color-wash-cyan': 'cover',
  'color-wash-magenta': 'cover',
};

export function videoTransitionPreviewKind(type: VideoTransitionType) {
  return TRANSITION_PREVIEW_KINDS[type];
}

export function videoTransitionUsesCompositeMedia(type: VideoTransitionType) {
  const kind = videoTransitionPreviewKind(type);
  return kind !== 'none' && kind !== 'cover' && kind !== 'shutter';
}

export type VideoTransition = {
  type: VideoTransitionType;
  durationMs: number;
};

type TransitionClip = {
  gapBeforeMs: number;
  gapAfterMs: number;
  transitionAfter?: VideoTransition;
};

type PersistedTransitionClip = Omit<TransitionClip, 'transitionAfter'> & {
  transitionAfter?: unknown;
};

const SUPPORTED_TRANSITION_TYPES = new Set<string>(
  VIDEO_TRANSITION_PRESETS.map((preset) => preset.id),
);

const RETIRED_TRANSITION_TYPES = new Map<string, VideoTransitionType>([
  ['glitch', 'dip-black'],
  ['wipe-left', 'push-left'],
  ['wipe-right', 'push-right'],
  ['wipe-up', 'push-up'],
  ['wipe-down', 'push-down'],
  ['slide-left', 'push-left'],
  ['slide-right', 'push-right'],
  ['slide-up', 'push-up'],
  ['slide-down', 'push-down'],
  ['wipe-diagonal-tl', 'crossfade'],
  ['wipe-diagonal-tr', 'crossfade'],
  ['wipe-diagonal-bl', 'crossfade'],
  ['wipe-diagonal-br', 'crossfade'],
  ['blinds-horizontal', 'crossfade'],
  ['blinds-vertical', 'crossfade'],
  ['checkerboard', 'crossfade'],
  ['pixel-grid', 'crossfade'],
  ['radial-clock', 'crossfade'],
  ['stripes-diagonal', 'crossfade'],
  ['slice-shuffle', 'crossfade'],
  ['ripple-rings', 'crossfade'],
]);

export const CLEAN_CUT_TRANSITION: VideoTransition = Object.freeze({ type: 'none', durationMs: 0 });

export function isVideoTransitionType(value: unknown): value is VideoTransitionType {
  return typeof value === 'string' && SUPPORTED_TRANSITION_TYPES.has(value);
}

export function hydrateVideoTransition(value: unknown): VideoTransition {
  if (value == null) return CLEAN_CUT_TRANSITION;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('A project video transition is invalid');
  const candidate = value as { type?: unknown; durationMs?: unknown };
  const persistedType = candidate.type ?? 'none';
  const type = typeof persistedType === 'string' && RETIRED_TRANSITION_TYPES.has(persistedType)
    ? RETIRED_TRANSITION_TYPES.get(persistedType)!
    : persistedType;
  if (!isVideoTransitionType(type)) throw new Error('A project video transition is invalid');
  if (type === 'none') return CLEAN_CUT_TRANSITION;
  const durationMs = candidate.durationMs ?? 500;
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 2_000) {
    throw new Error('A project video transition duration is invalid');
  }
  return { type, durationMs };
}

export function hydrateVideoTransitionBoundaries<T extends PersistedTransitionClip>(
  clips: readonly T[],
): (Omit<T, 'transitionAfter'> & { transitionAfter: VideoTransition })[] {
  const hydrated = clips.map((clip) => ({
    ...clip,
    transitionAfter: hydrateVideoTransition(clip.transitionAfter),
  }));
  return normalizeVideoTransitionBoundaries(hydrated);
}

export function canApplyVideoTransition(clips: readonly TransitionClip[], clipIndex: number): boolean {
  return canTransitionBetween(clips[clipIndex], clips[clipIndex + 1]);
}

export function canTransitionBetween(current: TransitionClip | undefined, next: TransitionClip | undefined): boolean {
  return Boolean(
    current
    && next
    && isZeroGap(current.gapAfterMs)
    && isZeroGap(next.gapBeforeMs),
  );
}

export function effectiveVideoTransition(
  current: TransitionClip | undefined,
  next: TransitionClip | undefined,
): VideoTransition {
  if (!canTransitionBetween(current, next)) return CLEAN_CUT_TRANSITION;
  const transition = current?.transitionAfter;
  if (
    !transition
    || !isVideoTransitionType(transition.type)
    || transition.type === 'none'
    || !Number.isFinite(transition.durationMs)
    || transition.durationMs <= 0
  ) return CLEAN_CUT_TRANSITION;
  return transition;
}

export function normalizeVideoTransitionBoundaries<T extends TransitionClip>(
  clips: readonly T[],
): (T & { transitionAfter: VideoTransition })[] {
  return clips.map((clip, index) => {
    const effective = effectiveVideoTransition(clip, clips[index + 1]);
    const transition = clip.transitionAfter;
    if (transition && effective.type === transition.type && effective.durationMs === transition.durationMs) {
      return clip as T & { transitionAfter: VideoTransition };
    }
    return { ...clip, transitionAfter: effective };
  });
}

function isZeroGap(value: number) {
  return Number.isFinite(value) && value === 0;
}
