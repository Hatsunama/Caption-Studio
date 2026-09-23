import { Directory, File, Paths } from 'expo-file-system';
import CaptionMedia from 'caption-media';
import CaptionTranslation, {
  TRANSLATION_RELEASE_CONTRACT,
  type NaturalCaptionTranslationLimits,
  type NaturalCaptionTranslationInput,
} from 'caption-translation';

import {
  canonicalCaptionLanguageTag,
  isLikelyUntranslatedCaption,
  resolveCaptionLanguage,
  type CaptionLanguageTag,
} from '@/lib/caption-languages';
import {
  captionTextHead,
  captionTextTail,
} from '@/lib/caption-text-breaks';
import { createTranslationBatches } from '@/lib/translation-batching';
import { splitBatchesByContext } from '@/lib/contextual-translation-batching';
import { validateTranslationUnits } from '@/lib/translation-input';
import {
  acceptTranslationBoundary,
} from '@/lib/translation-invariants';
import { requireFreeSpace } from '@/services/storage-policy';
import {
  downloadVerifiedModel,
  ModelDownloadIntegrityError,
  ModelDownloadPausedError,
  ModelDownloadTransferError,
  resumableModelDownloadReservation,
} from '@/services/verified-model-download';

const NATURAL_TRANSLATION_MODEL = TRANSLATION_RELEASE_CONTRACT;

export const NATURAL_TRANSLATION_MODEL_LABEL = NATURAL_TRANSLATION_MODEL.label;

export type CaptionTranslationProgress = {
  stage: 'downloading-model' | 'verifying-model' | 'loading-model' | 'translating';
  progress: number | null;
  detail: string;
};

export type NaturalTranslationUnit = { id: string; text: string };

export type NaturalCaptionTranslationProvider = {
  id: 'litertlm';
  modelId: typeof NATURAL_TRANSLATION_MODEL.id;
  modelRevision: typeof NATURAL_TRANSLATION_MODEL.revision;
  promptVersion: typeof NATURAL_TRANSLATION_MODEL.promptVersion;
};

export type NaturalCaptionTranslation = {
  captions: ReadonlyMap<string, string>;
  needsReview: ReadonlySet<string>;
  provider: NaturalCaptionTranslationProvider;
  failureReasons?: ReadonlyMap<string, string>;
};

export type NaturalCaptionTranslationOperation = {
  id: string;
  sourceLanguage: string;
  targetLanguage: string;
  captions: NaturalTranslationUnit[];
  allCaptions?: NaturalTranslationUnit[];
};

export type NaturalCaptionTranslationSession = {
  operations: ReadonlyMap<string, ReadonlyMap<string, string>>;
  needsReviewByOperation: ReadonlyMap<string, ReadonlySet<string>>;
  provider: NaturalCaptionTranslationProvider;
  failureReasonsByOperation?: ReadonlyMap<string, ReadonlyMap<string, string>>;
};

export type DownloadedNaturalTranslationModel = {
  id: typeof NATURAL_TRANSLATION_MODEL.id;
  label: string;
  sizeBytes: number;
};

export class CaptionTranslationCancelledError extends Error {
  constructor() {
    super('Caption translation was cancelled.');
    this.name = 'CaptionTranslationCancelledError';
  }
}

export class CaptionTranslationDownloadError extends Error {
  constructor(message = 'The language-model download stopped before it finished. Try again with a stable connection and keep Caption Studio open.') {
    super(message);
    this.name = 'CaptionTranslationDownloadError';
  }
}

type ActiveTranslation = {
  id: symbol;
  cancelled: boolean;
  pauseDownload?: () => Promise<void>;
};

let activeTranslation: ActiveTranslation | undefined;
let modelDownload: Promise<File> | undefined;

export type CaptionTranslationResourceLease = {
  ready: Promise<void>;
  restore: () => Promise<void>;
};

type CaptionTranslationResourceOwner = () => CaptionTranslationResourceLease;
let translationResourceOwner: CaptionTranslationResourceOwner | undefined;

export function registerCaptionTranslationResources(owner: CaptionTranslationResourceOwner) {
  translationResourceOwner = owner;
  return () => {
    if (translationResourceOwner === owner) translationResourceOwner = undefined;
  };
}

export function normalizeNaturalCaptionLanguage(languageTag: string): CaptionLanguageTag {
  const canonical = canonicalCaptionLanguageTag(languageTag);
  const resolved = resolveCaptionLanguage(canonical);
  if (!resolved?.automaticTranslation) throw new Error('Caption Studio cannot translate this language on this phone.');
  return resolved.tag;
}

export async function listDownloadedNaturalTranslationModel(): Promise<DownloadedNaturalTranslationModel[]> {
  const file = translationModelFile();
  return await verifyTranslationModel(file)
    ? [{ id: NATURAL_TRANSLATION_MODEL.id, label: NATURAL_TRANSLATION_MODEL.label, sizeBytes: NATURAL_TRANSLATION_MODEL.downloadBytes }]
    : [];
}

export async function removeDownloadedNaturalTranslationModel() {
  if (activeTranslation || modelDownload) {
    throw new Error('Wait for caption translation to finish or cancel it before removing the language model.');
  }
  const directory = translationModelDirectory();
  for (const suffix of ['', '.sha256', '.download', '.download.resume.json', '.download.resume.json.writing']) {
    const file = new File(directory, `${NATURAL_TRANSLATION_MODEL.fileName}${suffix}`);
    if (file.exists) file.delete();
  }
}

export async function translateNaturalCaptionBatch(options: {
  sourceLanguage: string;
  targetLanguage: string;
  captions: NaturalTranslationUnit[];
  allCaptions?: NaturalTranslationUnit[];
  onProgress?: (progress: CaptionTranslationProgress) => void;
}): Promise<NaturalCaptionTranslation> {
  const operationId = 'caption-translation';
  const session = await translateNaturalCaptionOperations({
    operations: [{
      id: operationId,
      sourceLanguage: options.sourceLanguage,
      targetLanguage: options.targetLanguage,
      captions: options.captions,
      allCaptions: options.allCaptions,
    }],
    onProgress: options.onProgress,
  });
  const captions = session.operations.get(operationId);
  if (!captions) throw new Error('The local translation session did not return its requested operation.');
  return {
    captions,
    needsReview: session.needsReviewByOperation.get(operationId) ?? new Set<string>(),
    failureReasons: session.failureReasonsByOperation?.get(operationId),
    provider: session.provider,
  };
}

export async function translateNaturalCaptionOperations(options: {
  operations: NaturalCaptionTranslationOperation[];
  onProgress?: (progress: CaptionTranslationProgress) => void;
}): Promise<NaturalCaptionTranslationSession> {
  const limits = requireNaturalCaptionTranslationLimits(CaptionTranslation.limits);
  if (activeTranslation) throw new Error('Another caption translation is already running.');
  if (
    options.operations.length === 0
    || options.operations.length > limits.maxOperationsPerSession
  ) {
    throw new Error('A natural translation session must contain between 1 and 8 operations.');
  }
  const operationIds = new Set<string>();
  let nextCaptionKey = 1;
  const prepared = options.operations.map((operation) => {
    const id = operation.id;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/.test(id) || operationIds.has(id)) {
      throw new Error('Natural translation operation identifiers must be valid and unique.');
    }
    operationIds.add(id);
    const sourceLanguage = normalizeNaturalCaptionLanguage(operation.sourceLanguage);
    const targetLanguage = normalizeNaturalCaptionLanguage(operation.targetLanguage);
    const originalCaptions = validateTranslationUnits(operation.captions, limits.maxCharactersPerCaption);
    const originalContext = operation.allCaptions?.length
      ? validateTranslationUnits(
        operation.allCaptions.filter((caption) => caption.text.trim().length > 0),
        limits.maxCharactersPerCaption,
      )
      : originalCaptions;
    const keyByOriginalId = new Map<string, string>();
    for (const caption of originalContext) keyByOriginalId.set(caption.id, `c${nextCaptionKey++}`);
    for (const caption of originalCaptions) {
      if (!keyByOriginalId.has(caption.id)) keyByOriginalId.set(caption.id, `c${nextCaptionKey++}`);
    }
    const captions = originalCaptions.map((caption) => ({
      id: keyByOriginalId.get(caption.id)!,
      text: caption.text,
    }));
    const fullContext = originalContext.map((caption) => ({
      id: keyByOriginalId.get(caption.id)!,
      text: caption.text,
    }));
    const originalIdByKey = new Map(originalCaptions.map((caption) => [keyByOriginalId.get(caption.id)!, caption.id]));
    const contextIndex = new Map(fullContext.map((caption, index) => [caption.id, index]));
    const batches = splitBatchesByContext(createTranslationBatches(captions, limits), fullContext).map((batch) => {
      const context = batchContext(fullContext, contextIndex, batch);
      return {
        captions: batch,
        contextBefore: context.before,
        contextAfter: context.after,
      };
    });
    return { id, sourceLanguage, targetLanguage, originalCaptions, originalIdByKey, captions, batches };
  });
  const allCaptionIds = new Set<string>();
  let totalCaptions = 0;
  let totalCharacters = 0;
  let totalBatches = 0;
  for (const operation of prepared) {
    totalCaptions += operation.captions.length;
    totalBatches += operation.batches.length;
    for (const caption of operation.captions) {
      if (allCaptionIds.has(caption.id)) {
        throw new Error('A subtitle cannot belong to more than one operation in the same translation session.');
      }
      allCaptionIds.add(caption.id);
      totalCharacters += Array.from(caption.text).length;
    }
  }
  if (
    totalCaptions > limits.maxCaptionsPerSession
    || totalCharacters > limits.maxCaptionCharactersPerSession
    || totalBatches > limits.maxBatchesPerSession
  ) {
    throw new Error('The caption script is too large for one local translation session. Translate a smaller selection.');
  }
  const run: ActiveTranslation = { id: Symbol('caption-translation'), cancelled: false };
  activeTranslation = run;
  let resourceLease: CaptionTranslationResourceLease | undefined;

  try {
    resourceLease = translationResourceOwner?.();
    if (resourceLease) await resourceLease.ready;
    throwIfCancelled(run);
    try {
      const nativeRequest = { operations: prepared.map((operation) => ({
        id: operation.id,
        sourceLanguage: operation.sourceLanguage,
        targetLanguage: operation.targetLanguage,
        batches: operation.batches,
      })) };
      const result = await translateWithModelRecovery(run, nativeRequest.operations, options.onProgress);
      throwIfCancelled(run);
      if (
        result.offline !== true
        || result.backend !== 'cpu'
        || result.modelId !== NATURAL_TRANSLATION_MODEL.id
        || result.promptContract !== NATURAL_TRANSLATION_MODEL.promptContract
        || result.batchCount !== totalBatches
        || result.operations.length !== prepared.length
      ) {
        throw new Error('The local model returned an incomplete translation. No captions were changed.');
      }
      result.operations.forEach((actual, index) => {
        const expected = prepared[index];
        if (
          actual.id !== expected.id
          || actual.sourceLanguage !== expected.sourceLanguage
          || actual.targetLanguage !== expected.targetLanguage
          || actual.captionCount !== expected.captions.length
          || actual.batchCount !== expected.batches.length
        ) {
          throw new Error('The local model returned invalid translation operation metadata. No captions were changed.');
        }
      });
      const expectedCaptions = prepared.flatMap((operation) => operation.captions);
      const translated = validateNativeResult(expectedCaptions, result.captions);
      const rejected = new Set([
        ...translated.filter((caption) => caption.rejected).map((caption) => caption.id),
        ...result.captions.filter((caption) => caption.valid === false).map((caption) => caption.id),
      ]);
      const repaired = reviewTranslatedCaptions(
        prepared,
        new Map(translated.map((caption) => [caption.id, caption.text])),
        rejected,
      );
      throwIfCancelled(run);
      const translatedById = repaired.translatedById;
      const translatedOperations = new Map<string, ReadonlyMap<string, string>>();
      const needsReviewByOperation = new Map<string, ReadonlySet<string>>();
      const failureReasonsByOperation = new Map<string, ReadonlyMap<string, string>>();
      const nativeFailures = new Map(result.captions.map((caption) => [caption.id, caption.failureReason]));
      for (const operation of prepared) {
        const needsReview = new Set<string>();
        const failureReasons = new Map<string, string>();
        translatedOperations.set(operation.id, new Map(operation.captions.map((caption) => {
          const text = translatedById.get(caption.id) ?? '';
          const originalId = operation.originalIdByKey.get(caption.id)!;
          if (!text || repaired.needsReview.has(caption.id)) {
            needsReview.add(originalId);
            failureReasons.set(originalId, nativeFailures.get(caption.id) ?? 'output-needs-review');
          }
          return [originalId, text];
        })));
        needsReviewByOperation.set(operation.id, needsReview);
        failureReasonsByOperation.set(operation.id, failureReasons);
      }
      return {
        operations: translatedOperations,
        needsReviewByOperation,
        failureReasonsByOperation,
        provider: {
          id: 'litertlm',
          modelId: result.modelId,
          modelRevision: NATURAL_TRANSLATION_MODEL.revision,
          promptVersion: NATURAL_TRANSLATION_MODEL.promptVersion,
        },
      } satisfies NaturalCaptionTranslationSession;
    } catch (error) {
      if (run.cancelled || translationCancelled(error)) throw new CaptionTranslationCancelledError();
      throw error;
    }
  } finally {
    try {
      if (resourceLease) await resourceLease.restore();
    } finally {
      if (activeTranslation?.id === run.id) activeTranslation = undefined;
    }
  }
}

export async function cancelNaturalCaptionTranslation() {
  const run = activeTranslation;
  if (!run) return false;
  run.cancelled = true;
  const pauseOperation = run.pauseDownload?.();
  try {
    await CaptionTranslation.cancelNaturalCaptionTranslation();
  } catch (error) {
    if (!pauseOperation) throw error;
  }
  await pauseOperation;
  return true;
}

async function ensureNaturalTranslationModel(
  run: ActiveTranslation,
  onProgress?: (progress: CaptionTranslationProgress) => void,
) {
  const existing = translationModelFile();
  if (await verifyTranslationModel(existing)) return existing;
  if (modelDownload) return modelDownload;
  const operation = downloadNaturalTranslationModel(run, onProgress);
  modelDownload = operation;
  try {
    return await operation;
  } finally {
    if (modelDownload === operation) modelDownload = undefined;
  }
}

async function downloadNaturalTranslationModel(
  run: ActiveTranslation,
  onProgress?: (progress: CaptionTranslationProgress) => void,
) {
  const directory = translationModelDirectory();
  directory.create({ idempotent: true, intermediates: true });
  const target = translationModelFile();
  const reservation = await resumableModelDownloadReservation(
    target, NATURAL_TRANSLATION_MODEL, (uri) => CaptionMedia.sha256(uri),
  );
  await requireFreeSpace(
    reservation + 384 * 1024 * 1024,
    'download the optional natural multilingual translation model',
  );
  throwIfCancelled(run);
  onProgress?.({
    stage: 'downloading-model',
    progress: null,
    detail: 'take a little breath — your local AI is settling onto this phone; it can take a bit, and that’s okay; you only wait through this once.',
  });
  try {
    await downloadVerifiedModel({
      target,
      descriptor: NATURAL_TRANSLATION_MODEL,
      verifySha256: (uri) => CaptionMedia.sha256(uri),
      registerPauser: (pause) => {
        run.pauseDownload = pause;
        return () => {
          if (run.pauseDownload === pause) run.pauseDownload = undefined;
        };
      },
      onProgress: (bytesWritten, totalBytes) => {
        if (run.cancelled) return;
        const denominator = totalBytes > 0 ? totalBytes : NATURAL_TRANSLATION_MODEL.downloadBytes;
        onProgress?.({
          stage: 'downloading-model',
          progress: Math.min(1, bytesWritten / denominator),
          detail: `take a little breath — your local AI is settling onto this phone; it can take a bit, and that’s okay; you only wait through this once.\n${formatModelProgress(bytesWritten, denominator)}`,
        });
      },
      onVerifying: () => onProgress?.({ stage: 'verifying-model', progress: null, detail: 'Verifying the downloaded model' }),
    });
  } catch (error) {
    if (run.cancelled || error instanceof ModelDownloadPausedError) throw new CaptionTranslationCancelledError();
    if (error instanceof ModelDownloadIntegrityError) {
      throw new Error('The natural translation model failed its security check and was discarded.');
    }
    if (error instanceof ModelDownloadTransferError) throw new CaptionTranslationDownloadError(error.message);
    throw new CaptionTranslationDownloadError();
  }
  throwIfCancelled(run);
  new File(directory, `${NATURAL_TRANSLATION_MODEL.fileName}.sha256`).write(NATURAL_TRANSLATION_MODEL.sha256);
  return target;
}

async function verifyTranslationModel(file: File) {
  if (!file.exists || file.size !== NATURAL_TRANSLATION_MODEL.downloadBytes) return false;
  const marker = new File(file.parentDirectory, `${file.name}.sha256`);
  if (marker.exists && (await marker.text()).trim() === NATURAL_TRANSLATION_MODEL.sha256) return true;
  if (await CaptionMedia.sha256(file.uri) !== NATURAL_TRANSLATION_MODEL.sha256) return false;
  marker.write(NATURAL_TRANSLATION_MODEL.sha256);
  return true;
}

function requireNaturalCaptionTranslationLimits(
  limits: NaturalCaptionTranslationLimits,
) {
  const values = [
    limits.maxCaptionsPerBatch,
    limits.maxOperationsPerSession,
    limits.maxBatchesPerSession,
    limits.maxCaptionsPerSession,
    limits.maxCharactersPerCaption,
    limits.maxCaptionCharactersPerBatch,
    limits.maxCaptionCharactersPerSession,
  ];
  if (
    values.some((value) => !Number.isSafeInteger(value) || value < 1)
    || limits.maxCaptionsPerBatch > limits.maxCaptionsPerSession
    || limits.maxCharactersPerCaption > limits.maxCaptionCharactersPerBatch
    || limits.maxCaptionCharactersPerBatch > limits.maxCaptionCharactersPerSession
  ) {
    throw new Error('The local translation runtime reported an invalid capacity contract.');
  }
  return limits;
}

function batchContext(
  allCaptions: NaturalTranslationUnit[],
  contextIndex: Map<string, number>,
  batch: NaturalTranslationUnit[],
) {
  const indices = batch.flatMap((caption) => {
    const index = contextIndex.get(caption.id);
    return index === undefined ? [] : [index];
  });
  if (indices.length === 0) return { before: '', after: '' };
  const first = Math.min(...indices);
  const last = Math.max(...indices);
  return {
    before: captionTextTail(allCaptions.slice(Math.max(0, first - 4), first).map((caption) => caption.text).join('\n'), 250),
    after: captionTextHead(allCaptions.slice(last + 1, last + 5).map((caption) => caption.text).join('\n'), 250),
  };
}

function validateNativeResult(
  expected: NaturalCaptionTranslationInput[],
  translated: { id: string; text: string; valid?: boolean }[],
) {
  const boundary = acceptTranslationBoundary(expected, translated);
  return expected.map((caption) => ({
    id: caption.id,
    text: boundary.translations.get(caption.id) ?? '',
    rejected: boundary.rejected.has(caption.id),
  }));
}

function reviewTranslatedCaptions(
  prepared: {
    sourceLanguage: CaptionLanguageTag;
    targetLanguage: CaptionLanguageTag;
    captions: NaturalCaptionTranslationInput[];
  }[],
  translatedById: Map<string, string>,
  rejected: ReadonlySet<string>,
) {
  const needsReview = new Set(rejected);
  for (const operation of prepared) {
    for (const caption of operation.captions) {
      if (operation.sourceLanguage !== operation.targetLanguage
        && isLikelyUntranslatedCaption(caption.text, translatedById.get(caption.id) ?? '', operation.targetLanguage)) {
        needsReview.add(caption.id);
      }
    }
  }
  return { translatedById, needsReview };
}

async function translateWithNative(
  modelUri: string,
  operations: {
    id: string;
    sourceLanguage: CaptionLanguageTag;
    targetLanguage: CaptionLanguageTag;
    batches: { captions: NaturalCaptionTranslationInput[]; contextBefore?: string; contextAfter?: string; }[];
  }[],
  reuseCheckpoints = true,
) {
  const result = await CaptionTranslation.translateNaturalCaptions(modelUri, { operations, reuseCheckpoints, repairUnusableOutputs: true });
  if (
    result.offline !== true
    || result.backend !== 'cpu'
    || result.modelId !== NATURAL_TRANSLATION_MODEL.id
    || result.promptContract !== NATURAL_TRANSLATION_MODEL.promptContract
  ) {
    throw new Error('The local model returned an incomplete translation. No captions were changed.');
  }
  return result;
}

function isNativeModelIntegrityFailure(error: unknown) {
  return typeof error === 'object' && error !== null
    && 'code' in error && error.code === 'E_TRANSLATION_MODEL_INTEGRITY';
}

async function translateWithModelRecovery(
  run: ActiveTranslation,
  operations: Parameters<typeof translateWithNative>[1],
  onProgress?: (progress: CaptionTranslationProgress) => void,
) {
  let recoveryAttempted = false;
  while (true) {
    throwIfCancelled(run);
    const model = await ensureNaturalTranslationModel(run, onProgress);
    throwIfCancelled(run);
    onProgress?.({
      stage: 'loading-model',
      progress: null,
      detail: 'Loading the local natural-language model',
    });
    const stopProgress = pollNativeProgress(run, onProgress);
    try {
      // Recovery changes only the model file; successful cue checkpoints remain reusable.
      return await translateWithNative(model.uri, operations);
    } catch (error) {
      if (!isNativeModelIntegrityFailure(error)) throw error;
      // Remove the trust marker first, including after a failed recovery attempt.
      // Keep independent download/resume artifacts for the verified downloader.
      const marker = new File(model.parentDirectory, `${model.name}.sha256`);
      if (marker.exists) marker.delete();
      if (model.exists) model.delete();
      throwIfCancelled(run);
      if (recoveryAttempted) throw error;
      recoveryAttempted = true;
    } finally {
      stopProgress();
    }
  }
}

function pollNativeProgress(
  run: ActiveTranslation,
  onProgress?: (progress: CaptionTranslationProgress) => void,
) {
  let polling = false;
  let stopped = false;
  const interval = setInterval(() => {
    if (stopped || run.cancelled || polling) return;
    polling = true;
    void CaptionTranslation.getNaturalCaptionTranslationProgress().then((native) => {
      if (stopped || run.cancelled || activeTranslation?.id !== run.id) return;
      onProgress?.(captionTranslationProgress(native));
    }).catch(() => undefined).finally(() => { polling = false; });
  }, 500);
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

export function captionTranslationProgress(native: {
  stage: string;
  percent?: number | null;
  processedItems?: number;
  totalItems?: number;
}) : CaptionTranslationProgress {
  const stage = native.stage === 'verifying-model' ? 'verifying-model'
    : native.stage === 'loading-model' ? 'loading-model' : 'translating';
  const processed = Number.isFinite(native.processedItems) ? Math.max(0, Math.floor(native.processedItems!)) : 0;
  const total = Number.isFinite(native.totalItems) ? Math.max(0, Math.floor(native.totalItems!)) : 0;
  const count = total > 0 ? ` · ${Math.min(processed, total)} of ${total} cues completed` : '';
  const label = native.stage === 'validating-output' ? 'Validating and retrying translations'
    : native.stage === 'restoring' ? 'Restoring saved translations'
      : native.stage === 'cancelling' ? 'Cancelling local translation'
        : native.stage === 'failed' ? 'Local translation failed'
          : native.stage === 'completed' ? 'Local translation completed'
            : stage === 'verifying-model' ? 'Verifying the local natural-language model'
              : stage === 'loading-model' ? 'Loading the local natural-language model' : 'Translating locally';
  const terminalComplete = native.stage === 'completed' && total > 0 && processed >= total;
  const cueProgress = total > 0 ? processed / total : undefined;
  const reportedProgress = Number.isFinite(native.percent) ? Math.max(0, native.percent! / 100) : undefined;
  const progress = terminalComplete ? 1
    : stage === 'loading-model' ? null
      : stage === 'verifying-model' ? (reportedProgress != null ? Math.min(0.99, reportedProgress) : null)
        : cueProgress != null ? Math.min(0.99, cueProgress)
          : reportedProgress != null ? Math.min(0.99, reportedProgress) : null;
  return { stage, progress, detail: label + count };
}

function translationModelDirectory() {
  return new Directory(Paths.document, 'models');
}

function translationModelFile() {
  return new File(translationModelDirectory(), NATURAL_TRANSLATION_MODEL.fileName);
}

function throwIfCancelled(run: ActiveTranslation) {
  if (run.cancelled) throw new CaptionTranslationCancelledError();
}

function translationCancelled(error: unknown) {
  return error instanceof Error && (error.name.includes('Cancel') || error.message.toLowerCase().includes('cancel'));
}

function formatModelProgress(written: number, total: number) {
  const megabytes = (value: number) => (value / 1024 / 1024).toFixed(0);
  return `${megabytes(written)} of ${megabytes(total)} MB`;
}
