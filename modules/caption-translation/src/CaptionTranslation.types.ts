export type NaturalCaptionLanguage = 'en' | 'zh-Hans' | 'zh-Hant';

export type NaturalCaptionTranslationInput = {
  id: string;
  text: string;
};

export type NaturalCaptionTranslationBatch = {
  captions: NaturalCaptionTranslationInput[];
  contextBefore?: string;
  contextAfter?: string;
};

export type NaturalCaptionTranslationOperation = {
  id: string;
  sourceLanguage: NaturalCaptionLanguage;
  targetLanguage: NaturalCaptionLanguage;
  batches: NaturalCaptionTranslationBatch[];
};

export type NaturalCaptionTranslationRequest = {
  operations: NaturalCaptionTranslationOperation[];
};

export type NaturalCaptionTranslationOutput = {
  id: string;
  text: string;
};

export type NaturalCaptionTranslationOperationResult = {
  id: string;
  sourceLanguage: NaturalCaptionLanguage;
  targetLanguage: NaturalCaptionLanguage;
  captionCount: number;
  batchCount: number;
};

export type NaturalCaptionTranslationResult = {
  captions: NaturalCaptionTranslationOutput[];
  operations: NaturalCaptionTranslationOperationResult[];
  durationMs: number;
  backend: 'cpu';
  offline: true;
  modelId: 'qwen2.5-1.5b-q8';
  promptContract: 'qwen2.5-caption-json-v1';
  batchCount: number;
};

export type NaturalCaptionTranslationStage =
  | 'idle'
  | 'validating'
  | 'verifying-model'
  | 'loading-model'
  | 'translating'
  | 'validating-output'
  | 'completed'
  | 'cancelling'
  | 'cancelled'
  | 'failed';

export type NaturalCaptionTranslationProgress = {
  stage: NaturalCaptionTranslationStage;
  percent: number | null;
  processedItems: number;
  totalItems: number;
  completedBatches: number;
  totalBatches: number;
};

export type NaturalCaptionTranslationErrorCode =
  | 'E_TRANSLATION_INVALID_REQUEST'
  | 'E_TRANSLATION_BUSY'
  | 'E_TRANSLATION_CANCELLED'
  | 'E_TRANSLATION_INVALID_OUTPUT'
  | 'E_TRANSLATION_UNSUPPORTED'
  | 'E_TRANSLATION_FAILED'
  | 'E_TRANSLATION_RELEASED';
