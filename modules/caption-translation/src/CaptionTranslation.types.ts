export type NaturalCaptionLanguage =
  | 'en' | 'zh-Hans' | 'zh-Hant' | 'hi' | 'es' | 'fr' | 'ar' | 'bn' | 'pt' | 'ru'
  | 'ur' | 'id' | 'de' | 'ja' | 'ko' | 'tr' | 'vi' | 'th' | 'it' | 'pl';

export type NaturalCaptionTranslationInput = {
  id: string;
  text: string;
};

export type NaturalCaptionTranslationLimits = {
  maxCaptionsPerBatch: number;
  maxOperationsPerSession: number;
  maxBatchesPerSession: number;
  maxCaptionsPerSession: number;
  maxCharactersPerCaption: number;
  maxCaptionCharactersPerBatch: number;
  maxCaptionCharactersPerSession: number;
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
  runtimeBackend?: 'auto' | 'cpu' | 'gpu';
  benchmarkNoCheckpoints?: boolean;
  reuseCheckpoints?: boolean;
  repairUnusableOutputs?: boolean;
};

export type NaturalCaptionTranslationOutput = {
  id: string;
  text: string;
  valid?: boolean;
  failureReason?: string;
};

export type NaturalCaptionTranslationOperationResult = {
  id: string;
  sourceLanguage: NaturalCaptionLanguage;
  targetLanguage: NaturalCaptionLanguage;
  captionCount: number;
  batchCount: number;
};

export type NaturalCaptionTranslationBackend = 'cpu' | 'gpu' | 'none' | 'unknown';

export type NaturalCaptionTranslationBatchMetrics = {
  batchIndex: number;
  captionCount: number;
  backend: NaturalCaptionTranslationBackend;
  initializationFallback: boolean;
  durationMs: number;
  initializationMs: number;
  generationMs: number;
  attempts: number;
  repairAttempts: number;
  generationFailures: number;
  invalidOutputs: number;
  qualityRejections: number;
  outcome: 'completed' | 'cancelled' | 'failed';
};

export type NaturalCaptionTranslationResult = {
  captions: NaturalCaptionTranslationOutput[];
  operations: NaturalCaptionTranslationOperationResult[];
  durationMs: number;
  backend: NaturalCaptionTranslationBackend;
  initializationFallback: boolean;
  benchmarkNoCheckpoints: boolean;
  batchMetrics: NaturalCaptionTranslationBatchMetrics[];
  offline: true;
  modelId: typeof TRANSLATION_RELEASE_CONTRACT.id;
  promptContract: typeof TRANSLATION_RELEASE_CONTRACT.promptContract;
  batchCount: number;
};

export type NaturalCaptionTranslationStage =
  | 'idle'
  | 'validating'
  | 'verifying-model'
  | 'loading-model'
  | 'translating'
  | 'validating-output'
  | 'restoring'
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
import { TRANSLATION_RELEASE_CONTRACT } from './TranslationReleaseContract.generated';
