import type { BackgroundReplacement } from '@/types/project';

export type PersonMattePreset = Exclude<BackgroundReplacement['mask']['qualityPreset'], 'custom'>;

export const PERSON_MATTE_PRESETS: Record<PersonMattePreset, BackgroundReplacement['mask']> = {
  stable: { qualityPreset: 'stable', threshold: 0.46, softness: 0.14, temporalStability: 0.78, edgeFeather: 0.45 },
  balanced: { qualityPreset: 'balanced', threshold: 0.5, softness: 0.12, temporalStability: 0.64, edgeFeather: 0.36 },
  detailed: { qualityPreset: 'detailed', threshold: 0.54, softness: 0.1, temporalStability: 0.46, edgeFeather: 0.26 },
};
