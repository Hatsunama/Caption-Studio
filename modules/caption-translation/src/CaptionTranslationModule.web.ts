import { NativeModule, registerWebModule } from 'expo';

import type {
  NaturalCaptionTranslationLimits,
  NaturalCaptionTranslationProgress,
  NaturalCaptionTranslationRequest,
  NaturalCaptionTranslationResult,
} from './CaptionTranslation.types';

class CaptionTranslationModule extends NativeModule<Record<never, never>> {
  readonly limits: NaturalCaptionTranslationLimits = {
    maxCaptionsPerBatch: 32,
    maxOperationsPerSession: 8,
    maxBatchesPerSession: 1_024,
    maxCaptionsPerSession: 3_072,
    maxCharactersPerCaption: 1_000,
    maxCaptionCharactersPerBatch: 8_000,
    maxCaptionCharactersPerSession: 256_000,
  };

  async translateNaturalCaptions(
    _modelFile: string,
    _request: NaturalCaptionTranslationRequest,
  ): Promise<NaturalCaptionTranslationResult> {
    throw new Error('Natural caption translation is available only in the Android app.');
  }

  async cancelNaturalCaptionTranslation(): Promise<void> {}

  async getNaturalCaptionTranslationProgress(): Promise<NaturalCaptionTranslationProgress> {
    return {
      stage: 'idle',
      percent: null,
      processedItems: 0,
      totalItems: 0,
      completedBatches: 0,
      totalBatches: 0,
    };
  }
}

export default registerWebModule(CaptionTranslationModule, 'CaptionTranslation');
