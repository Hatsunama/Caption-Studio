import { Directory, File, Paths } from 'expo-file-system';
import CaptionMedia from 'caption-media';
import CaptionTranslation, {
  type NaturalCaptionTranslationInput,
} from 'caption-translation';

import {
  normalizeEnglishChineseCaptionLanguage,
  type EnglishChineseCaptionLanguage,
} from '@/lib/caption-languages';
import {
  captionTextHead,
  captionTextLength,
  captionTextTail,
} from '@/lib/caption-text-breaks';
import { requireFreeSpace } from '@/services/storage-policy';

export const NATURAL_TRANSLATION_MODEL = {
  id: 'qwen2.5-1.5b-q8',
  label: 'Natural English–Chinese',
  fileName: 'Qwen2.5-1.5B-Instruct_multi-prefill-seq_q8_ekv4096.litertlm',
  downloadBytes: 1_597_931_520,
  sha256: 'faa60663b333290c1496c499828b21d3e3254a788cacd8cce917ce0f761a2dc9',
  revision: '19edb84c69a0212f29a6ef17ba0d6f278b6a1614',
  promptVersion: 1,
  downloadUrl: 'https://huggingface.co/litert-community/Qwen2.5-1.5B-Instruct/resolve/19edb84c69a0212f29a6ef17ba0d6f278b6a1614/Qwen2.5-1.5B-Instruct_multi-prefill-seq_q8_ekv4096.litertlm',
} as const;

const NATURAL_TRANSLATION_SESSION_LIMITS = {
  operations: 8,
  captions: 3_072,
  captionCharacters: 256_000,
  batches: 128,
} as const;

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

type ActiveTranslation = {
  id: symbol;
  cancelled: boolean;
  downloadController?: AbortController;
};

let activeTranslation: ActiveTranslation | undefined;
let modelDownload: Promise<File> | undefined;

export const normalizeNaturalCaptionLanguage = normalizeEnglishChineseCaptionLanguage;

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
  for (const suffix of ['', '.sha256', '.download']) {
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
    provider: session.provider,
  };
}

export async function translateNaturalCaptionOperations(options: {
  operations: NaturalCaptionTranslationOperation[];
  onProgress?: (progress: CaptionTranslationProgress) => void;
}): Promise<NaturalCaptionTranslationSession> {
  if (activeTranslation) throw new Error('Another caption translation is already running.');
  if (
    options.operations.length === 0
    || options.operations.length > NATURAL_TRANSLATION_SESSION_LIMITS.operations
  ) {
    throw new Error('A natural translation session must contain between 1 and 8 operations.');
  }
  const operationIds = new Set<string>();
  let nextCaptionKey = 1;
  const prepared = options.operations.map((operation) => {
    const id = operation.id.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/.test(id) || operationIds.has(id)) {
      throw new Error('Natural translation operation identifiers must be valid and unique.');
    }
    operationIds.add(id);
    const sourceLanguage: EnglishChineseCaptionLanguage = normalizeNaturalCaptionLanguage(operation.sourceLanguage);
    const targetLanguage: EnglishChineseCaptionLanguage = normalizeNaturalCaptionLanguage(operation.targetLanguage);
    if (sourceLanguage === targetLanguage) throw new Error('Choose a different language for the second subtitle track.');
    const originalCaptions = validateTranslationUnits(operation.captions);
    const originalContext = operation.allCaptions?.length
      ? validateTranslationUnits(operation.allCaptions.filter((caption) => caption.text.trim().length > 0))
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
    const batches = createBatches(captions).map((batch) => {
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
      totalCharacters += captionTextLength(caption.text);
    }
  }
  if (
    totalCaptions > NATURAL_TRANSLATION_SESSION_LIMITS.captions
    || totalCharacters > NATURAL_TRANSLATION_SESSION_LIMITS.captionCharacters
    || totalBatches > NATURAL_TRANSLATION_SESSION_LIMITS.batches
  ) {
    throw new Error('The caption script is too large for one local translation session. Translate a smaller selection.');
  }
  const run: ActiveTranslation = { id: Symbol('caption-translation'), cancelled: false };
  activeTranslation = run;

  try {
    const model = await ensureNaturalTranslationModel(run, options.onProgress);
    throwIfCancelled(run);
    options.onProgress?.({
      stage: 'loading-model',
      progress: 0,
      detail: 'Loading the local natural-language model once',
    });
    const nativeProgress = pollNativeProgress(run, options.onProgress);
    try {
      const nativeRequest = { operations: prepared.map((operation) => ({
        id: operation.id,
        sourceLanguage: operation.sourceLanguage,
        targetLanguage: operation.targetLanguage,
        batches: operation.batches,
      })) };
      const result = await translateWithNative(model.uri, nativeRequest.operations);
      throwIfCancelled(run);
      if (
        result.offline !== true
        || result.backend !== 'cpu'
        || result.modelId !== NATURAL_TRANSLATION_MODEL.id
        || result.promptContract !== 'qwen2.5-caption-json-v1'
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
      const repaired = await repairChineseTranslations(
        run,
        model.uri,
        prepared,
        new Map(translated.map((caption) => [caption.id, caption.text])),
        options.onProgress,
      );
      const translatedById = repaired.translatedById;
      const translatedOperations = new Map<string, ReadonlyMap<string, string>>();
      const needsReviewByOperation = new Map<string, ReadonlySet<string>>();
      for (const operation of prepared) {
        const needsReview = new Set<string>();
        translatedOperations.set(operation.id, new Map(operation.captions.map((caption) => {
          const text = translatedById.get(caption.id);
          if (!text) throw new Error('The local model returned an incomplete translation. No captions were changed.');
          const originalId = operation.originalIdByKey.get(caption.id)!;
          if (repaired.needsReview.has(caption.id)) needsReview.add(originalId);
          return [originalId, text];
        })));
        needsReviewByOperation.set(operation.id, needsReview);
      }
      return {
        operations: translatedOperations,
        needsReviewByOperation,
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
    } finally {
      clearInterval(nativeProgress);
    }
  } finally {
    if (activeTranslation?.id === run.id) activeTranslation = undefined;
  }
}

export async function cancelNaturalCaptionTranslation() {
  const run = activeTranslation;
  if (!run) return false;
  run.cancelled = true;
  run.downloadController?.abort('Caption translation cancelled.');
  await CaptionTranslation.cancelNaturalCaptionTranslation().catch(() => undefined);
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
  await requireFreeSpace(
    NATURAL_TRANSLATION_MODEL.downloadBytes + 384 * 1024 * 1024,
    'download the optional natural English–Chinese translation model',
  );
  throwIfCancelled(run);
  const directory = translationModelDirectory();
  directory.create({ idempotent: true, intermediates: true });
  const target = translationModelFile();
  const temporary = new File(directory, `${NATURAL_TRANSLATION_MODEL.fileName}.download`);
  if (temporary.exists) temporary.delete();
  const controller = new AbortController();
  run.downloadController = controller;
  onProgress?.({ stage: 'downloading-model', progress: 0, detail: 'Downloading the optional natural English–Chinese model once' });
  try {
    await File.downloadFileAsync(NATURAL_TRANSLATION_MODEL.downloadUrl, temporary, {
      idempotent: true,
      signal: controller.signal,
      onProgress: ({ bytesWritten, totalBytes }) => {
        if (run.cancelled) return;
        const denominator = totalBytes > 0 ? totalBytes : NATURAL_TRANSLATION_MODEL.downloadBytes;
        onProgress?.({
          stage: 'downloading-model',
          progress: Math.min(1, bytesWritten / denominator),
          detail: `Downloading natural translation model · ${formatModelProgress(bytesWritten, denominator)}`,
        });
      },
    });
  } catch (error) {
    if (temporary.exists) temporary.delete();
    if (run.cancelled || controller.signal.aborted) throw new CaptionTranslationCancelledError();
    throw error;
  } finally {
    if (run.downloadController === controller) run.downloadController = undefined;
  }
  throwIfCancelled(run);
  if (temporary.size !== NATURAL_TRANSLATION_MODEL.downloadBytes) {
    temporary.delete();
    throw new Error('The natural translation model download was incomplete. Try again on a stable connection.');
  }
  onProgress?.({ stage: 'verifying-model', progress: null, detail: 'Verifying the downloaded model' });
  if (await CaptionMedia.sha256(temporary.uri) !== NATURAL_TRANSLATION_MODEL.sha256) {
    temporary.delete();
    throw new Error('The natural translation model failed its security check and was discarded.');
  }
  if (target.exists) target.delete();
  await temporary.move(target);
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

function validateTranslationUnits(units: NaturalTranslationUnit[]) {
  if (units.length === 0) throw new Error('Choose at least one subtitle to translate.');
  const ids = new Set<string>();
  return units.map((unit) => {
    const id = unit.id.trim();
    const text = unit.text.normalize('NFC').trim();
    if (!id || captionTextLength(id) > 256) throw new Error('A subtitle has an invalid internal identity.');
    if (ids.has(id)) throw new Error(`Subtitle ${id} was included more than once.`);
    if (!text) throw new Error(`Subtitle ${id} has no text to translate.`);
    if (captionTextLength(text) > 1_000) throw new Error(`Subtitle ${id} is too long. Split it before translating.`);
    ids.add(id);
    return { id, text };
  });
}

function createBatches(captions: NaturalCaptionTranslationInput[]) {
  const batches: NaturalCaptionTranslationInput[][] = [];
  let batch: NaturalCaptionTranslationInput[] = [];
  let characters = 0;
  for (const caption of captions) {
    const captionLength = captionTextLength(caption.text);
    if (batch.length >= 24 || characters + captionLength > 1_000) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(caption);
    characters += captionLength;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
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
  translated: { id: string; text: string }[],
) {
  const translatedById = new Map<string, string>();
  for (const caption of translated) {
    if (translatedById.has(caption.id)) continue;
    const text = caption.text.normalize('NFC').trim();
    if (text && captionTextLength(text) <= 2_000) translatedById.set(caption.id, text);
  }
  return expected.map((caption) => ({
    id: caption.id,
    text: translatedById.get(caption.id) ?? caption.text,
  }));
}

async function repairChineseTranslations(
  run: ActiveTranslation,
  modelUri: string,
  prepared: {
    sourceLanguage: EnglishChineseCaptionLanguage;
    targetLanguage: EnglishChineseCaptionLanguage;
    captions: NaturalCaptionTranslationInput[];
  }[],
  translatedById: Map<string, string>,
  onProgress?: (progress: CaptionTranslationProgress) => void,
) {
  let updated = new Map(translatedById);
  const needsReview = new Set<string>();
  for (const operation of prepared) {
    if (run.cancelled) return { translatedById: updated, needsReview };
    if (operation.targetLanguage !== 'zh-Hans' && operation.targetLanguage !== 'zh-Hant') continue;

    let questionables = operation.captions.filter((caption) => isLikelyUntranslatedChinese(
      caption.text,
      updated.get(caption.id) ?? caption.text,
      operation.targetLanguage,
    ));
    if (questionables.length === 0) continue;

    let retryResult;
    try {
      retryResult = await translateWithNative(modelUri, [{
        id: 'repair',
        sourceLanguage: operation.sourceLanguage,
        targetLanguage: operation.targetLanguage,
        batches: createBatches(questionables).map((captions) => ({ captions })),
      }]);
    } catch {
      for (const caption of questionables) {
        updated.set(caption.id, caption.text);
        needsReview.add(caption.id);
      }
      continue;
    }
    const validated = validateNativeResult(questionables, retryResult.captions);
    questionables = questionables.filter((caption) => {
      const repaired = validated.find((candidate) => candidate.id === caption.id);
      const text = repaired?.text ?? '';
      const keep = isLikelyUntranslatedChinese(caption.text, text, operation.targetLanguage);
      if (keep) {
        updated.set(caption.id, caption.text);
        needsReview.add(caption.id);
        return true;
      }
      updated.set(caption.id, text);
      return false;
    });
    onProgress?.({ stage: 'translating', progress: 0.1, detail: 'Checking Chinese translations' });
  }
  return { translatedById: updated, needsReview };
}

function isLikelyUntranslatedChinese(sourceText: string, translatedText: string, targetLanguage: string) {
  if (targetLanguage !== 'zh-Hans' && targetLanguage !== 'zh-Hant') return false;
  const source = sourceText.normalize('NFC').trim();
  const translated = translatedText.normalize('NFC').trim();
  if (!translated || source === translated) return true;
  if (!containsChineseText(translated)) {
    const latinCount = (translated.match(/[A-Za-z]/g) ?? []).length;
    if (latinCount >= 3 || /^[A-Za-z0-9\s.,!?'\":;()\-–—’”“‘“”'"]+$/.test(translated)) return true;
  }
  return false;
}

function containsChineseText(value: string) {
  return /[\u3400-\u4DBF\u4E00-\u9FFF]/.test(value);
}

async function translateWithNative(
  modelUri: string,
  operations: {
    id: string;
    sourceLanguage: EnglishChineseCaptionLanguage;
    targetLanguage: EnglishChineseCaptionLanguage;
    batches: { captions: NaturalCaptionTranslationInput[]; contextBefore?: string; contextAfter?: string; }[];
  }[],
) {
  const result = await CaptionTranslation.translateNaturalCaptions(modelUri, { operations });
  if (
    result.offline !== true
    || result.backend !== 'cpu'
    || result.modelId !== NATURAL_TRANSLATION_MODEL.id
    || result.promptContract !== 'qwen2.5-caption-json-v1'
  ) {
    throw new Error('The local model returned an incomplete translation. No captions were changed.');
  }
  return result;
}

function pollNativeProgress(
  run: ActiveTranslation,
  onProgress?: (progress: CaptionTranslationProgress) => void,
) {
  const startedAt = Date.now();
  let nativeProgress = 0;
  let syntheticProgress = 0;
  let lastEmittedProgress = -1;
  return setInterval(() => {
    if (run.cancelled) return;
    void CaptionTranslation.getNaturalCaptionTranslationProgress().then((native) => {
      if (run.cancelled) return;
      const stage = native.stage === 'verifying-model'
        ? 'verifying-model'
        : native.stage === 'loading-model'
          ? 'loading-model'
          : 'translating';
      const batchDetail = native.totalBatches > 1 && native.stage !== 'verifying-model' && native.stage !== 'loading-model'
        ? ` · batch ${Math.min(native.completedBatches + 1, native.totalBatches)} of ${native.totalBatches}`
        : '';
      const reported = native.percent == null ? 0 : Math.min(1, Math.max(0, native.percent / 100));
      nativeProgress = Math.max(nativeProgress, reported);
      const progress = Math.max(nativeProgress, syntheticProgress);
      onProgress?.({
        stage,
        progress,
        detail: native.stage === 'verifying-model'
          ? 'Verifying the local natural-language model'
          : native.stage === 'loading-model'
            ? 'Loading the local natural-language model once'
            : `Translating locally${batchDetail}`,
      });
    }).catch(() => undefined);

    const elapsedSinceStart = Date.now() - startedAt;
    if (elapsedSinceStart >= 3_000 && syntheticProgress < 0.10) {
      syntheticProgress = Math.min(0.10, 0.05 + Math.floor((elapsedSinceStart - 3_000) / 4_000) * 0.01);
    }
    const progress = Math.max(nativeProgress, syntheticProgress);
    if (progress > lastEmittedProgress && onProgress != null) {
      lastEmittedProgress = progress;
      onProgress?.({
        stage: 'translating',
        progress,
        detail: 'Translating locally',
      });
    }
  }, 500);
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
