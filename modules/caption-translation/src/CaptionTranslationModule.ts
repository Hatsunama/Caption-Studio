import { NativeModule, requireNativeModule } from 'expo';

import type {
  NaturalCaptionTranslationProgress,
  NaturalCaptionTranslationRequest,
  NaturalCaptionTranslationResult,
} from './CaptionTranslation.types';

declare class CaptionTranslationModule extends NativeModule<Record<never, never>> {
  translateNaturalCaptions(
    modelFile: string,
    request: NaturalCaptionTranslationRequest,
  ): Promise<NaturalCaptionTranslationResult>;
  cancelNaturalCaptionTranslation(): Promise<void>;
  getNaturalCaptionTranslationProgress(): Promise<NaturalCaptionTranslationProgress>;
}

export default requireNativeModule<CaptionTranslationModule>('CaptionTranslation');
