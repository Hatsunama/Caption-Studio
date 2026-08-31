import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { initWhisper, initWhisperVad } from 'whisper.rn/index';

import CaptionMedia from 'caption-media';
import {
  getModel,
  LEGACY_ENGLISH_MODEL_FILES,
  TRANSCRIPTION_MODELS,
  type TranscriptionModel,
} from '@/lib/model-catalog';
import { alignWordsToSpeech } from '@/lib/speech-alignment';
import { PREPARING_AUDIO_CUES } from '@/lib/transcription-progress';
import { coalesceWhisperWords } from '@/lib/whisper-words';
import {
  encodeModelVerificationMarker,
  modelVerificationMarkerMatches,
  type ModelFileIdentity,
} from '@/lib/model-verification';
import { buildPcm16MonoWave, parseCaptionPcmWave, planOverlappingPcmChunks } from '@/lib/wav-chunking';
import { requireFreeSpace } from '@/services/storage-policy';
import type { CaptionGenerationSessionContext } from '@/services/caption-generation-session';
import type { WordToken } from '@/types/project';

export type TranscriptionStage =
  | 'preparing-audio'
  | 'downloading-model'
  | 'detecting-speech'
  | 'transcribing'
  | 'grouping';

export type TranscriptionProgress = {
  stage: TranscriptionStage;
  progress: number;
  detail: string;
};

export type LocalTranscriptionResult = {
  language: string;
  words: WordToken[];
};

const activeModelDownloads = new Map<string, Promise<File>>();
let activeModelUsers = 0;
const MODEL_REPLACEMENT_HEADROOM_BYTES = 64 * 1024 * 1024;

const VAD_MODEL = {
  fileName: 'ggml-silero-v6.2.0.bin',
  downloadBytes: 885_098,
  sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987',
  downloadUrl: 'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin',
};

const VAD_OPTIONS = {
  threshold: 0.42,
  minSpeechDurationMs: 180,
  minSilenceDurationMs: 280,
  maxSpeechDurationS: 29,
  speechPadMs: 90,
  samplesOverlap: 0.1,
};

export type DownloadedTranscriptionModel = {
  id: TranscriptionModel['id'];
  label: string;
  sizeBytes: number;
};

export async function listDownloadedTranscriptionModels(): Promise<DownloadedTranscriptionModel[]> {
  const directory = new Directory(Paths.document, 'models');
  const downloaded: DownloadedTranscriptionModel[] = [];
  for (const model of TRANSCRIPTION_MODELS) {
    const file = new File(directory, model.fileName);
    if (await verifyModelFile(file, model.downloadBytes, model.sha256)) {
      downloaded.push({ id: model.id, label: model.label, sizeBytes: model.downloadBytes });
    }
  }
  return downloaded;
}

export async function removeDownloadedTranscriptionModels() {
  if (activeModelUsers > 0 || activeModelDownloads.size > 0) {
    throw new Error('Wait for caption generation to finish or stop before removing offline models.');
  }
  const directory = new Directory(Paths.document, 'models');
  const fileNames = [
    ...TRANSCRIPTION_MODELS.map((model) => model.fileName),
    ...LEGACY_ENGLISH_MODEL_FILES,
    VAD_MODEL.fileName,
  ];
  for (const fileName of fileNames) {
    for (const suffix of ['', '.sha256', '.sha256.download', '.download']) {
      const file = new File(directory, `${fileName}${suffix}`);
      if (file.exists) file.delete();
    }
  }
}

export async function ensureModel(
  modelId: TranscriptionModel['id'],
  onProgress?: (progress: TranscriptionProgress) => void,
  session?: CaptionGenerationSessionContext,
): Promise<File> {
  const activeDownload = activeModelDownloads.get(modelId);
  if (activeDownload) return activeDownload;
  const operation = downloadModel(modelId, onProgress, session);
  activeModelDownloads.set(modelId, operation);
  try {
    return await operation;
  } finally {
    if (activeModelDownloads.get(modelId) === operation) activeModelDownloads.delete(modelId);
  }
}

async function downloadModel(
  modelId: TranscriptionModel['id'],
  onProgress?: (progress: TranscriptionProgress) => void,
  session?: CaptionGenerationSessionContext,
): Promise<File> {
  const model = getModel(modelId);
  const modelDirectory = new Directory(Paths.document, 'models');
  modelDirectory.create({ idempotent: true, intermediates: true });
  const modelFile = new File(modelDirectory, model.fileName);

  if (await verifyModelFile(modelFile, model.downloadBytes, model.sha256)) {
    return modelFile;
  }
  await requireFreeSpace(
    model.downloadBytes + MODEL_REPLACEMENT_HEADROOM_BYTES,
    `replace the ${model.label} transcription model safely`,
  );

  onProgress?.({
    stage: 'downloading-model',
    progress: 0,
    detail: `Downloading ${model.label} model once for offline use`,
  });

  const temporaryFile = new File(modelDirectory, `${model.fileName}.download`);
  if (temporaryFile.exists) temporaryFile.delete();
  const controller = new AbortController();
  const unregisterStopper = session?.registerStopper(async () => controller.abort('Caption generation cancelled.'));
  try {
    await File.downloadFileAsync(model.downloadUrl, temporaryFile, {
      idempotent: true,
      signal: controller.signal,
      onProgress: ({ bytesWritten, totalBytes }) => {
        if (session?.isCancelled()) return;
        const denominator = totalBytes > 0 ? totalBytes : model.downloadBytes;
        onProgress?.({
          stage: 'downloading-model',
          progress: Math.min(1, bytesWritten / denominator),
          detail: `Downloading ${model.label} model`,
        });
      },
    });
  } catch (error) {
    if (temporaryFile.exists) temporaryFile.delete();
    throw error;
  } finally {
    unregisterStopper?.();
  }
  if (temporaryFile.size !== model.downloadBytes) {
    temporaryFile.delete();
    throw new Error(`The ${model.label} model download was incomplete. Try again on a stable connection.`);
  }
  if (await CaptionMedia.sha256(temporaryFile.uri) !== model.sha256) {
    temporaryFile.delete();
    throw new Error(`The ${model.label} model failed its security check. Delete it and try again.`);
  }
  if (modelFile.exists) modelFile.delete();
  await temporaryFile.move(modelFile);
  await writeModelVerificationMarker(modelFile, model.sha256);
  return modelFile;
}

async function ensureVadModel(
  onProgress?: (progress: TranscriptionProgress) => void,
  session?: CaptionGenerationSessionContext,
): Promise<File> {
  const modelDirectory = new Directory(Paths.document, 'models');
  modelDirectory.create({ idempotent: true, intermediates: true });
  const modelFile = new File(modelDirectory, VAD_MODEL.fileName);
  if (await verifyModelFile(modelFile, VAD_MODEL.downloadBytes, VAD_MODEL.sha256)) return modelFile;
  await requireFreeSpace(
    VAD_MODEL.downloadBytes + MODEL_REPLACEMENT_HEADROOM_BYTES,
    'replace the offline silence-detector model safely',
  );

  onProgress?.({
    stage: 'downloading-model',
    progress: 0,
    detail: 'Downloading the small offline silence detector once',
  });
  const temporaryFile = new File(modelDirectory, `${VAD_MODEL.fileName}.download`);
  if (temporaryFile.exists) temporaryFile.delete();
  const controller = new AbortController();
  const unregisterStopper = session?.registerStopper(async () => controller.abort('Caption generation cancelled.'));
  try {
    await File.downloadFileAsync(VAD_MODEL.downloadUrl, temporaryFile, {
      idempotent: true,
      signal: controller.signal,
      onProgress: ({ bytesWritten, totalBytes }) => {
        if (session?.isCancelled()) return;
        onProgress?.({
          stage: 'downloading-model',
          progress: Math.min(1, bytesWritten / Math.max(1, totalBytes || VAD_MODEL.downloadBytes)),
          detail: 'Downloading offline silence detector',
        });
      },
    });
  } catch (error) {
    if (temporaryFile.exists) temporaryFile.delete();
    throw error;
  } finally {
    unregisterStopper?.();
  }
  if (temporaryFile.size !== VAD_MODEL.downloadBytes || await CaptionMedia.sha256(temporaryFile.uri) !== VAD_MODEL.sha256) {
    if (temporaryFile.exists) temporaryFile.delete();
    throw new Error('The silence-detector model failed its security check. Try the download again.');
  }
  if (modelFile.exists) modelFile.delete();
  await temporaryFile.move(modelFile);
  await writeModelVerificationMarker(modelFile, VAD_MODEL.sha256);
  return modelFile;
}

async function verifyModelFile(file: File, expectedBytes: number, expectedSha256: string) {
  if (!file.exists || file.size !== expectedBytes) return false;
  const marker = new File(file.parentDirectory, `${file.name}.sha256`);
  const identity = modelFileIdentity(file);
  if (marker.exists && modelVerificationMarkerMatches(await marker.text(), identity, expectedSha256)) return true;
  if (await CaptionMedia.sha256(file.uri) !== expectedSha256) {
    if (marker.exists) marker.delete();
    return false;
  }
  await writeModelVerificationMarker(file, expectedSha256);
  return true;
}

async function writeModelVerificationMarker(file: File, sha256: string) {
  const markerContents = encodeModelVerificationMarker(modelFileIdentity(file), sha256);
  const marker = new File(file.parentDirectory, `${file.name}.sha256`);
  if (!markerContents) {
    if (marker.exists) marker.delete();
    return;
  }
  const staging = new File(file.parentDirectory, `${file.name}.sha256.download`);
  if (staging.exists) staging.delete();
  staging.write(markerContents);
  let moved = false;
  try {
    await staging.move(marker, { overwrite: true });
    moved = true;
  } finally {
    if (!moved && staging.exists) staging.delete();
  }
}

function modelFileIdentity(file: File): ModelFileIdentity {
  return {
    fileName: file.name,
    sizeBytes: file.size,
    modifiedAtMs: file.lastModified,
    createdAtMs: file.creationTime,
  };
}

async function modelReplacementReservation(file: File, expectedBytes: number, expectedSha256: string) {
  if (!file.exists || file.size !== expectedBytes) return expectedBytes;
  const marker = new File(file.parentDirectory, `${file.name}.sha256`);
  if (!marker.exists) return expectedBytes;
  return modelVerificationMarkerMatches(await marker.text(), modelFileIdentity(file), expectedSha256)
    ? 0
    : expectedBytes;
}

export async function transcribeVideoLocally(options: {
  projectId: string;
  videoUri: string;
  modelId: TranscriptionModel['id'];
  durationMs: number;
  language?: string;
  onProgress?: (progress: TranscriptionProgress) => void;
  session?: CaptionGenerationSessionContext;
}): Promise<LocalTranscriptionResult> {
  const { projectId, videoUri, modelId, onProgress, session } = options;
  session?.throwIfCancelled();
  const audioDirectory = new Directory(Paths.cache, 'caption-audio');
  audioDirectory.create({ idempotent: true, intermediates: true });
  const audioFile = new File(audioDirectory, `${projectId}.wav`);
  const model = getModel(modelId);
  const modelFile = new File(new Directory(Paths.document, 'models'), model.fileName);
  const vadModelFile = new File(new Directory(Paths.document, 'models'), VAD_MODEL.fileName);
  const estimatedWavBytes = Math.ceil(Math.max(0, options.durationMs) / 1000) * 32_000 + 44;
  const [modelBytes, vadModelBytes] = await Promise.all([
    modelReplacementReservation(modelFile, model.downloadBytes, model.sha256),
    modelReplacementReservation(vadModelFile, VAD_MODEL.downloadBytes, VAD_MODEL.sha256),
  ]);
  await requireFreeSpace(
    estimatedWavBytes + modelBytes + vadModelBytes + 128 * 1024 * 1024,
    'generate captions',
  );
  session?.throwIfCancelled();

  activeModelUsers += 1;
  try {

  onProgress?.({
    stage: 'preparing-audio',
    progress: 0,
    detail: 'Extracting audio on this phone',
  });

  let audioPreparationFinished = false;
  const preparationCueTimers = PREPARING_AUDIO_CUES.map((cue) =>
    setTimeout(() => {
      if (audioPreparationFinished) return;
      onProgress?.({
        stage: 'preparing-audio',
        progress: cue.progress,
        detail: cue.progress === 0.05
          ? 'Extracting audio on this phone'
          : 'Still preparing audio — longer videos can take a few minutes',
      });
    }, cue.afterMs),
  );

  try {
    await CaptionMedia.extractAudioToWav(videoUri, audioFile.uri);
  } finally {
    audioPreparationFinished = true;
    preparationCueTimers.forEach(clearTimeout);
  }
  session?.throwIfCancelled();
  onProgress?.({
    stage: 'preparing-audio',
    progress: 1,
    detail: 'Audio ready',
  });

  const [modelFile, vadModelFile] = await Promise.all([
    ensureModel(modelId, onProgress, session),
    ensureVadModel(onProgress, session),
  ]);
  session?.throwIfCancelled();
  onProgress?.({
    stage: 'detecting-speech',
    progress: 0,
    detail: 'Finding spoken sections and ignoring silence',
  });
  const vadContext = await initWhisperVad({
    filePath: vadModelFile.uri,
    useGpu: false,
    nThreads: 4,
  });
  let speechSegments: { t0: number; t1: number }[];
  try {
    speechSegments = await detectSpeechCooperatively(vadContext, audioFile, onProgress, session);
    session?.throwIfCancelled();
  } finally {
    await vadContext.release();
  }
  if (speechSegments.length === 0) {
    throw new Error('No speech was detected in this video. Try a clip with clearer spoken audio.');
  }
  onProgress?.({
    stage: 'detecting-speech',
    progress: 1,
    detail: `Found ${speechSegments.length} spoken section${speechSegments.length === 1 ? '' : 's'}`,
  });
  const context = await initWhisper({
    filePath: modelFile.uri,
    useGpu: false,
  });

  try {
    const { promise, stop } = context.transcribe(audioFile.uri, {
      ...(options.language && options.language !== 'auto' ? { language: options.language } : {}),
      maxThreads: 4,
      tokenTimestamps: true,
      maxLen: 1,
      wordThold: 0.01,
      temperature: 0,
      temperatureInc: 0.2,
      beamSize: modelId === 'fast' ? -1 : 5,
      bestOf: modelId === 'fast' ? 3 : 5,
      onProgress: (value: number) =>
        onProgress?.({
          stage: 'transcribing',
          progress: value / 100,
          detail: 'Generating word timings locally',
        }),
    });
    const unregisterStopper = session?.registerStopper(stop);
    let result;
    try {
      result = await promise;
    } finally {
      unregisterStopper?.();
    }
    session?.throwIfCancelled();
    if (result.isAborted) throw new Error('Transcription was cancelled');

    const words = alignWordsToSpeech(coalesceWhisperWords(result.segments), speechSegments);
    if (words.length === 0) {
      throw new Error('Speech was detected, but no reliable words were found. Try the Balanced model or clearer audio.');
    }
    const language = result.language || options.language || 'en';

    return {
      language,
      words,
    };
  } finally {
    await context.release();
  }
  } finally {
    if (audioFile.exists) audioFile.delete();
    activeModelUsers -= 1;
  }
}

async function detectSpeechCooperatively(
  vadContext: Awaited<ReturnType<typeof initWhisperVad>>,
  audioFile: File,
  onProgress?: (progress: TranscriptionProgress) => void,
  session?: CaptionGenerationSessionContext,
) {
  const handle = audioFile.open(FileMode.ReadOnly);
  const chunkNonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const speechSegments: { t0: number; t1: number }[] = [];
  try {
    handle.offset = 0;
    const header = handle.readBytes(44);
    const format = parseCaptionPcmWave(header, handle.size ?? audioFile.size);
    const ranges = planOverlappingPcmChunks(format.dataBytes, format.bytesPerSecond);
    for (let index = 0; index < ranges.length; index += 1) {
      session?.throwIfCancelled();
      const range = ranges[index];
      handle.offset = format.dataOffset + range.start;
      const pcm = handle.readBytes(range.end - range.start);
      if (pcm.byteLength !== range.end - range.start) {
        throw new Error('The prepared audio file ended unexpectedly during speech detection.');
      }
      const chunkFile = new File(audioFile.parentDirectory, `.vad-${chunkNonce}-${index}.wav`);
      try {
        chunkFile.write(buildPcm16MonoWave(pcm, format.sampleRate));
        const chunkSegments = await vadContext.detectSpeech(chunkFile.uri, VAD_OPTIONS);
        const offsetCentiseconds = Math.round(range.start / format.bytesPerSecond * 100);
        speechSegments.push(...chunkSegments.map((segment) => ({
          t0: segment.t0 + offsetCentiseconds,
          t1: segment.t1 + offsetCentiseconds,
        })));
      } finally {
        if (chunkFile.exists) chunkFile.delete();
      }
      session?.throwIfCancelled();
      onProgress?.({
        stage: 'detecting-speech',
        progress: Math.min(0.95, (index + 1) / ranges.length),
        detail: ranges.length === 1
          ? 'Finding spoken sections and ignoring silence'
          : `Finding spoken sections · part ${index + 1} of ${ranges.length}`,
      });
    }
    return speechSegments;
  } finally {
    handle.close();
  }
}
