export const VIDEO_TRANSITION_PRESETS = [
  { id: 'none', name: 'Clean cut', description: 'No transition', durationMs: 0 },
  { id: 'dip-black', name: 'Dip to black', description: 'Classic cinematic dip', durationMs: 500 },
  { id: 'dip-white', name: 'Dip to white', description: 'Bright clean dip', durationMs: 500 },
  { id: 'flash', name: 'Camera flash', description: 'Fast white burst', durationMs: 350 },
  { id: 'fade-dark', name: 'Soft dark fade', description: 'Gentler dark fade', durationMs: 800 },
  { id: 'crossfade', name: 'Cross dissolve', description: 'Smoothly blends both clips', durationMs: 650 },
  { id: 'wipe-left', name: 'Wipe left', description: 'Sweeps across to the left', durationMs: 600 },
  { id: 'wipe-right', name: 'Wipe right', description: 'Sweeps across to the right', durationMs: 600 },
  { id: 'wipe-up', name: 'Wipe up', description: 'Sweeps upward', durationMs: 600 },
  { id: 'wipe-down', name: 'Wipe down', description: 'Sweeps downward', durationMs: 600 },
  { id: 'wipe-diagonal-tl', name: 'Diagonal top left', description: 'Reveals from the top-left corner', durationMs: 650 },
  { id: 'wipe-diagonal-tr', name: 'Diagonal top right', description: 'Reveals from the top-right corner', durationMs: 650 },
  { id: 'wipe-diagonal-bl', name: 'Diagonal bottom left', description: 'Reveals from the bottom-left corner', durationMs: 650 },
  { id: 'wipe-diagonal-br', name: 'Diagonal bottom right', description: 'Reveals from the bottom-right corner', durationMs: 650 },
  { id: 'slide-left', name: 'Slide left', description: 'Bold directional slide', durationMs: 550 },
  { id: 'slide-right', name: 'Slide right', description: 'Reverse directional slide', durationMs: 550 },
  { id: 'slide-up', name: 'Slide up', description: 'Slides the next clip upward', durationMs: 550 },
  { id: 'slide-down', name: 'Slide down', description: 'Slides the next clip downward', durationMs: 550 },
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
  { id: 'blinds-horizontal', name: 'Horizontal blinds', description: 'Opens a row of horizontal blinds', durationMs: 700 },
  { id: 'blinds-vertical', name: 'Vertical blinds', description: 'Opens a row of vertical blinds', durationMs: 700 },
  { id: 'checkerboard', name: 'Checkerboard', description: 'Reveals alternating checker tiles', durationMs: 750 },
  { id: 'pixel-grid', name: 'Pixel grid', description: 'Builds the next clip from scattered tiles', durationMs: 800 },
  { id: 'radial-clock', name: 'Clock sweep', description: 'Sweeps the next clip around like a clock', durationMs: 750 },
  { id: 'stripes-diagonal', name: 'Diagonal stripes', description: 'Reveals with staggered angled bands', durationMs: 700 },
  { id: 'slice-shuffle', name: 'Slice shuffle', description: 'Alternating slices race across the cut', durationMs: 700 },
  { id: 'shutter', name: 'Shutter', description: 'Closing camera blades', durationMs: 500 },
  { id: 'glitch', name: 'RGB glitch', description: 'Color-channel slices', durationMs: 420 },
  { id: 'color-wash-cyan', name: 'Electric cyan wash', description: 'A bright cyan color wash bridges the cut', durationMs: 520 },
  { id: 'color-wash-magenta', name: 'Hot pink wash', description: 'A vivid magenta color wash bridges the cut', durationMs: 520 },
  { id: 'ripple-rings', name: 'Ripple rings', description: 'Expanding rings pulse across the cut', durationMs: 650 },
] as const;

export type TransitionPreset = (typeof VIDEO_TRANSITION_PRESETS)[number];
export type VideoTransitionType = TransitionPreset['id'];
export type VideoTransitionPreviewKind =
  | 'none'
  | 'cover'
  | 'crossfade'
  | 'directional'
  | 'diagonal'
  | 'zoom'
  | 'fold'
  | 'iris'
  | 'split'
  | 'blinds'
  | 'tiles'
  | 'radial'
  | 'stripes'
  | 'slices'
  | 'shutter'
  | 'glitch'
  | 'ripple';

const TRANSITION_PREVIEW_KINDS: Record<VideoTransitionType, VideoTransitionPreviewKind> = {
  none: 'none',
  'dip-black': 'cover',
  'dip-white': 'cover',
  flash: 'cover',
  'fade-dark': 'cover',
  crossfade: 'crossfade',
  'wipe-left': 'directional',
  'wipe-right': 'directional',
  'wipe-up': 'directional',
  'wipe-down': 'directional',
  'wipe-diagonal-tl': 'diagonal',
  'wipe-diagonal-tr': 'diagonal',
  'wipe-diagonal-bl': 'diagonal',
  'wipe-diagonal-br': 'diagonal',
  'slide-left': 'directional',
  'slide-right': 'directional',
  'slide-up': 'directional',
  'slide-down': 'directional',
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
  'blinds-horizontal': 'blinds',
  'blinds-vertical': 'blinds',
  checkerboard: 'tiles',
  'pixel-grid': 'tiles',
  'radial-clock': 'radial',
  'stripes-diagonal': 'stripes',
  'slice-shuffle': 'slices',
  shutter: 'shutter',
  glitch: 'glitch',
  'color-wash-cyan': 'cover',
  'color-wash-magenta': 'cover',
  'ripple-rings': 'ripple',
};

export function videoTransitionPreviewKind(type: VideoTransitionType) {
  return TRANSITION_PREVIEW_KINDS[type];
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

export const CLEAN_CUT_TRANSITION: VideoTransition = Object.freeze({ type: 'none', durationMs: 0 });

export function isVideoTransitionType(value: unknown): value is VideoTransitionType {
  return typeof value === 'string' && SUPPORTED_TRANSITION_TYPES.has(value);
}

export function hydrateVideoTransition(value: unknown): VideoTransition {
  if (value == null) return CLEAN_CUT_TRANSITION;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('A project video transition is invalid');
  const candidate = value as { type?: unknown; durationMs?: unknown };
  const type = candidate.type ?? 'none';
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
