import type { VideoTransitionType } from '@/types/project';

export type TransitionPreset = {
  id: VideoTransitionType;
  name: string;
  description: string;
  durationMs: number;
};

export const VIDEO_TRANSITION_PRESETS: TransitionPreset[] = [
  { id: 'none', name: 'Clean cut', description: 'No transition', durationMs: 0 },
  { id: 'dip-black', name: 'Dip to black', description: 'Classic cinematic dip', durationMs: 500 },
  { id: 'dip-white', name: 'Dip to white', description: 'Bright clean dip', durationMs: 500 },
  { id: 'flash', name: 'Camera flash', description: 'Fast white burst', durationMs: 350 },
  { id: 'fade-dark', name: 'Soft dark fade', description: 'Gentler dark fade', durationMs: 800 },
  { id: 'wipe-left', name: 'Wipe left', description: 'Sweeps across to the left', durationMs: 600 },
  { id: 'wipe-right', name: 'Wipe right', description: 'Sweeps across to the right', durationMs: 600 },
  { id: 'wipe-up', name: 'Wipe up', description: 'Sweeps upward', durationMs: 600 },
  { id: 'wipe-down', name: 'Wipe down', description: 'Sweeps downward', durationMs: 600 },
  { id: 'slide-left', name: 'Slide left', description: 'Bold directional slide', durationMs: 550 },
  { id: 'slide-right', name: 'Slide right', description: 'Reverse directional slide', durationMs: 550 },
  { id: 'zoom-in', name: 'Zoom burst', description: 'Pushes through the cut', durationMs: 500 },
  { id: 'zoom-out', name: 'Zoom pullback', description: 'Pulls away from the cut', durationMs: 500 },
  { id: 'spin', name: 'Spin flash', description: 'Rotating radial flash', durationMs: 600 },
  { id: 'shutter', name: 'Shutter', description: 'Closing camera blades', durationMs: 500 },
  { id: 'glitch', name: 'RGB glitch', description: 'Color-channel slices', durationMs: 420 },
];
