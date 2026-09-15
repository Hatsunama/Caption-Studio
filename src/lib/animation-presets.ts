import type { CaptionAnimationId } from '@/types/project';
export { reactionEmojis } from '@/lib/emoji-reactions';

export type AnimationPreset = {
  id: CaptionAnimationId;
  name: string;
  icon: string;
  description: string;
  intensity: number;
  durationMs: number;
  accent: string;
  group: 'classic' | 'entry' | 'loop' | 'word' | 'emoji';
  timing: 'phrase' | 'word' | 'cue';
  colorBehavior: 'unchanged' | 'active-word';
};

function phrase(
  id: CaptionAnimationId,
  name: string,
  icon: string,
  description: string,
  intensity: number,
  durationMs: number,
  accent: string,
  group: 'classic' | 'entry' | 'loop',
): AnimationPreset {
  return { id, name, icon, description, intensity, durationMs, accent, group, timing: 'phrase', colorBehavior: 'unchanged' };
}

function word(
  id: CaptionAnimationId,
  name: string,
  icon: string,
  description: string,
  intensity: number,
  durationMs: number,
  accent: string,
  group: 'word' | 'emoji' = 'word',
  colorBehavior: AnimationPreset['colorBehavior'] = 'unchanged',
): AnimationPreset {
  return { id, name, icon, description, intensity, durationMs, accent, group, timing: group === 'emoji' ? 'cue' : 'word', colorBehavior };
}

export const ANIMATION_PRESETS: AnimationPreset[] = [
  phrase('none', 'Classic', 'Aa', 'Clean and steady', 0, 1, '#F7F8FA', 'classic'),
  word('active-word', 'Spotlight', '●', 'Spoken word lights up', 0.12, 160, '#64D2FF', 'word', 'active-word'),
  word('karaoke', 'Karaoke', '▰', 'Color sweeps forward', 0.16, 180, '#FFC247', 'word', 'active-word'),
  word('single-word', 'One Word', 'ONE', 'One word at a time', 0.2, 140, '#67E8F9'),
  word('pop', 'Bubble Pop', 'POP', 'Words spring into view', 0.24, 240, '#FF70C8'),
  word('bounce', 'Bounce', '↟', 'Each word hops', 0.28, 320, '#7DFFB2'),
  word('punch', 'Punch', 'BAM', 'Hard word impact', 0.36, 180, '#FF5267'),
  word('typewriter', 'Typewriter', '⌨', 'Builds word by word', 0.16, 120, '#E2E8F0'),
  phrase('slide-up', 'Lift Off', '↑', 'Rises from below', 0.3, 420, '#A985F8', 'entry'),
  phrase('slide-left', 'Side Swipe', '←', 'Rushes in from the left', 0.36, 420, '#46D5FF', 'entry'),
  phrase('slide-right', 'Right Swipe', '→', 'Rushes in from the right', 0.36, 420, '#55E6B5', 'entry'),
  phrase('zoom-in', 'Mega Zoom', '◎', 'Zooms up from tiny', 0.42, 360, '#FFE566', 'entry'),
  phrase('zoom-out', 'Zoom Back', '◉', 'Settles down from oversized', 0.38, 380, '#FFB66E', 'entry'),
  phrase('spin-in', 'Spin In', '↻', 'Twists into place', 0.5, 420, '#FF8A5C', 'entry'),
  phrase('roll-in', 'Barrel Roll', '↺', 'Rolls in from the side', 0.46, 520, '#77D6FF', 'entry'),
  phrase('spiral-in', 'Spiral In', '◌', 'Circles inward to a landing', 0.48, 620, '#F29DFF', 'entry'),
  phrase('snap-in', 'Quick Snap', 'SNAP', 'Snaps past full size and settles', 0.36, 300, '#FFF04D', 'entry'),
  phrase('recoil', 'Recoil', '↤', 'Kicks back before locking in', 0.4, 360, '#FF7A8A', 'entry'),
  phrase('fade-in', 'Soft Fade', '◌', 'Gently fades into view', 0.18, 520, '#B8C5FF', 'entry'),
  phrase('cinema-fade', 'Cinema Fade', 'FILM', 'Slow fade with a subtle push', 0.22, 760, '#D8D6CA', 'entry'),
  phrase('drop-in', 'Sky Drop', '↓', 'Falls in from above', 0.4, 420, '#6EE7FF', 'entry'),
  phrase('soft-land', 'Soft Landing', '⌄', 'Glides in and cushions the stop', 0.28, 480, '#8DE6C8', 'entry'),
  phrase('rubber-drop', 'Rubber Drop', 'BOING', 'Drops with a springy stretch', 0.44, 620, '#FFB86B', 'entry'),
  phrase('tilt-in', 'Tilt Toss', '◩', 'Tosses in at an angle', 0.48, 420, '#A989FF', 'entry'),
  phrase('lean-in', 'Lean In', '／', 'Slides in on a sharp lean', 0.34, 440, '#82DAFF', 'entry'),
  phrase('rise-spin', 'Corkscrew Rise', '⤴', 'Rises while unwinding', 0.45, 520, '#FF9E78', 'entry'),
  phrase('elastic', 'Rubber Band', '↔', 'Stretchy overshoot', 0.4, 500, '#64D2FF', 'entry'),
  phrase('flip', 'Card Flip', '◩', '3D flip reveal', 0.42, 420, '#C4A7FF', 'entry'),
  phrase('stomp', 'Stomp', '▼', 'Drops with heavy impact', 0.48, 320, '#FFB347', 'entry'),
  phrase('squash', 'Squash', '▰', 'Compresses then rebounds', 0.4, 420, '#65F0B5', 'entry'),
  phrase('stretch', 'Tall Stretch', '↕', 'Stretches upward into place', 0.4, 440, '#F29DFF', 'entry'),
  phrase('shake', 'Quake', '≋', 'Rapid energetic shake', 0.32, 260, '#FF5D5D', 'loop'),
  phrase('glow-pulse', 'Neon Pulse', '✦', 'Breathing glow without changing fill', 0.3, 720, '#5CFFFA', 'loop'),
  phrase('swing', 'Pendulum', '⌁', 'Swings from its corner', 0.42, 620, '#FFD36E', 'entry'),
  phrase('heartbeat', 'Heartbeat', '♥', 'Pulses with the speech', 0.3, 520, '#FF5470', 'loop'),
  phrase('flicker', 'Flicker', 'ϟ', 'Sharp strobing reveal', 0.36, 460, '#FFF56E', 'entry'),
  phrase('breathe', 'Breathe', '○', 'Slow, gentle breathing scale', 0.24, 1000, '#A9E6FF', 'loop'),
  phrase('float', 'Float', '⌁', 'Drifts lightly in place', 0.24, 1200, '#9FF0D3', 'loop'),
  phrase('wobble', 'Wobble', '≈', 'Rocks from side to side', 0.32, 760, '#FFD18C', 'loop'),
  phrase('drift', 'Drift', '↝', 'Wanders on a smooth path', 0.25, 1400, '#AFC9FF', 'loop'),
  phrase('pulse', 'Pulse', '◎', 'Even rhythmic size pulse', 0.25, 700, '#FFB2C8', 'loop'),
  word('wave', 'Word Wave', '〰', 'Words ripple independently', 0.28, 620, '#45F0D1'),
  word('word-spin', 'Word Twirl', '⟳', 'Spoken words twirl', 0.44, 380, '#FF8D66'),
  word('word-slide', 'Word Rush', '⇢', 'Each word rushes in', 0.42, 340, '#52D6FF'),
  word('word-flash', 'Word Flash', '✺', 'Spoken words flash the accent color', 0.4, 260, '#FFF04D', 'word', 'active-word'),
  word('word-jitter', 'Word Jitter', '≋', 'Spoken words vibrate', 0.42, 300, '#FF5CB8'),
  word('word-rise', 'Word Rise', '↑', 'Each spoken word rises in', 0.32, 320, '#7EE7C4'),
  word('word-drop', 'Word Drop', '↓', 'Each spoken word drops in', 0.32, 320, '#79CFFF'),
  word('word-zoom', 'Word Zoom', '◎', 'Each spoken word grows into place', 0.36, 300, '#FFD36E'),
  word('word-tilt', 'Word Tilt', '／', 'Each spoken word straightens up', 0.34, 340, '#D5B4FF'),
  word('word-wobble', 'Word Wobble', '≈', 'Each spoken word wobbles and settles', 0.34, 460, '#FFAA8A'),
  word('word-squash', 'Word Squash', '▬', 'Each spoken word rebounds from wide', 0.38, 360, '#75E8B1'),
  word('word-stretch', 'Word Stretch', '↕', 'Each spoken word rebounds from tall', 0.38, 360, '#F0A8FF'),
  word('word-fade', 'Word Fade', '◌', 'Each spoken word fades in cleanly', 0.2, 360, '#CBD5E1'),
  word('word-drift', 'Word Drift', '↝', 'Each spoken word glides into place', 0.3, 420, '#8BD8FF'),
  word('word-kick', 'Word Kick', 'KICK', 'Each spoken word kicks upward', 0.4, 340, '#FF9978'),
  word('word-breathe', 'Word Breathe', '○', 'Each spoken word breathes once', 0.24, 480, '#9FE0D0'),
  word('emoji-burst', 'Emoji Burst', '💥', 'Reactions explode outward', 0.5, 680, '#FFDA57', 'emoji'),
  word('emoji-orbit', 'Emoji Orbit', '😍', 'Reactions circle the words', 0.44, 1100, '#FF70C8', 'emoji'),
  word('emoji-rain', 'Emoji Rain', '🔥', 'Reactions fall across screen', 0.52, 900, '#FF7A3D', 'emoji'),
];

export const CAPTION_ANIMATION_COUNT = ANIMATION_PRESETS.filter((preset) => preset.id !== 'none').length;

export function findAnimationPreset(id: CaptionAnimationId) {
  return ANIMATION_PRESETS.find((preset) => preset.id === id) ?? ANIMATION_PRESETS[0];
}
