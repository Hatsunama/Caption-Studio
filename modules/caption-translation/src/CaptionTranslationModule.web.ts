import { NativeModule, registerWebModule } from 'expo';

import type {
  NaturalCaptionTranslationProgress,
  NaturalCaptionTranslationRequest,
  NaturalCaptionTranslationResult,
} from './CaptionTranslation.types';

class CaptionTranslationModule extends NativeModule<Record<never, never>> {
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
