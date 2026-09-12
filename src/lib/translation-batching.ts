import { captionTextLength } from '@/lib/caption-text-breaks';
import {
  TRANSLATION_BATCH_CONTEXT_TOKEN_RESERVE,
  TRANSLATION_BATCH_STRUCTURAL_TOKEN_BASE,
  TRANSLATION_BATCH_TOKEN_BUDGET,
  estimateTranslationTokens,
} from '@/lib/translation-invariants';

export type TranslationBatchCapacity = {
  maxCaptionsPerBatch: number;
  maxCaptionCharactersPerBatch: number;
};

export function createTranslationBatches<T extends { text: string }>(
  captions: readonly T[],
  capacity: TranslationBatchCapacity,
) {
  assertPositiveInteger(capacity.maxCaptionsPerBatch);
  assertPositiveInteger(capacity.maxCaptionCharactersPerBatch);

  const batches: T[][] = [];
  let batch: T[] = [];
  let batchTokens = 0;
  let batchCharacters = 0;
  for (const caption of captions) {
    const captionTokens = estimateTranslationTokens(caption.text);
    const captionCharacters = captionTextLength(caption.text);
    if (captionCharacters > capacity.maxCaptionCharactersPerBatch) {
      throw new Error('A caption exceeds the local translation batch capacity.');
    }
    const nextCount = batch.length + 1;
    const nextTokens = batchTokens + captionTokens;
    const structural = TRANSLATION_BATCH_STRUCTURAL_TOKEN_BASE + nextCount * 12;
    const outputTokens = Math.ceil(nextTokens * 1.35);
    const projectedTokens = nextTokens
      + TRANSLATION_BATCH_CONTEXT_TOKEN_RESERVE
      + structural
      + outputTokens;
    const exceedsCapacity = nextCount > capacity.maxCaptionsPerBatch
      || batchCharacters + captionCharacters > capacity.maxCaptionCharactersPerBatch
      || projectedTokens > TRANSLATION_BATCH_TOKEN_BUDGET;
    if (batch.length > 0 && exceedsCapacity) {
      batches.push(batch);
      batch = [];
      batchTokens = 0;
      batchCharacters = 0;
    }
    batch.push(caption);
    batchTokens += captionTokens;
    batchCharacters += captionCharacters;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function assertPositiveInteger(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('The local translation runtime reported an invalid capacity contract.');
  }
}
