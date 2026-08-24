import { Directory, File, Paths } from 'expo-file-system';
import { initWhisper, initWhisperVad } from 'whisper.rn/index';

import CaptionMedia from 'caption-media';
import { groupWordsIntoCaptions } from '@/lib/caption-grouping';
import { getModel, type TranscriptionModel } from '@/lib/model-catalog';
import { alignWordsToSpeech } from '@/lib/speech-alignment';
import { PREPARING_AUDIO_CUES } from '@/lib/transcription-progress';
import { coalesceWhisperWords } from '@/lib/whisper-words';
import { requireFreeSpace } from '@/services/storage-policy';
import type { CaptionBlock, WordToken } from '@/types/project';

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
  captions: CaptionBlock[];
};

const activeModelDownloads = new Map<string, Promise<File>>();

const VAD_MODEL = {
  fileName: 'ggml-silero-v6.2.0.bin',
  downloadBytes: 885_098,
  sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987',
  downloadUrl: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin',
};

export async function ensureModel(
  modelId: TranscriptionModel['id'],
  onProgress?: (progress: TranscriptionProgress) => void,
): Promise<File> {
  const activeDownload = activeModelDownloads.get(modelId);
  if (activeDownload) return activeDownload;
  const operation = downloadModel(modelId, onProgress);
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
): Promise<File> {
  const model = getModel(modelId);
  const modelDirectory = new Directory(Paths.document, 'models');
  modelDirectory.create({ idempotent: true, intermediates: true });
  const modelFile = new File(modelDirectory, model.fileName);

  if (await verifyModelFile(modelFile, model.downloadBytes, model.sha256)) {
    return modelFile;
  }

  onProgress?.({
    stage: 'downloading-model',
    progress: 0,
    detail: `Downloading ${model.label} model once for offline use`,
  });

  const temporaryFile = new File(modelDirectory, `${model.fileName}.download`);
  if (temporaryFile.exists) temporaryFile.delete();
  await File.downloadFileAsync(model.downloadUrl, temporaryFile, {
    idempotent: true,
    onProgress: ({ bytesWritten, totalBytes }) => {
      const denominator = totalBytes > 0 ? totalBytes : model.downloadBytes;
      onProgress?.({
        stage: 'downloading-model',
        progress: Math.min(1, bytesWritten / denominator),
        detail: `Downloading ${model.label} model`,
      });
    },
  });
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
  new File(modelDirectory, `${model.fileName}.sha256`).write(model.sha256);
  return modelFile;
}

async function ensureVadModel(onProgress?: (progress: TranscriptionProgress) => void): Promise<File> {
  const modelDirectory = new Directory(Paths.document, 'models');
  modelDirectory.create({ idempotent: true, intermediates: true });
  const modelFile = new File(modelDirectory, VAD_MODEL.fileName);
  if (await verifyModelFile(modelFile, VAD_MODEL.downloadBytes, VAD_MODEL.sha256)) return modelFile;

  onProgress?.({
    stage: 'downloading-model',
    progress: 0,
    detail: 'Downloading the small offline silence detector once',
  });
  const temporaryFile = new File(modelDirectory, `${VAD_MODEL.fileName}.download`);
  if (temporaryFile.exists) temporaryFile.delete();
  await File.downloadFileAsync(VAD_MODEL.downloadUrl, temporaryFile, {
    idempotent: true,
    onProgress: ({ bytesWritten, totalBytes }) => onProgress?.({
      stage: 'downloading-model',
      progress: Math.min(1, bytesWritten / Math.max(1, totalBytes || VAD_MODEL.downloadBytes)),
      detail: 'Downloading offline silence detector',
    }),
  });
  if (temporaryFile.size !== VAD_MODEL.downloadBytes || await CaptionMedia.sha256(temporaryFile.uri) !== VAD_MODEL.sha256) {
    if (temporaryFile.exists) temporaryFile.delete();
    throw new Error('The silence-detector model failed its security check. Try the download again.');
  }
  if (modelFile.exists) modelFile.delete();
  await temporaryFile.move(modelFile);
  new File(modelDirectory, `${VAD_MODEL.fileName}.sha256`).write(VAD_MODEL.sha256);
  return modelFile;
}

async function verifyModelFile(file: File, expectedBytes: number, expectedSha256: string) {
  if (!file.exists || file.size !== expectedBytes) return false;
  const marker = new File(file.parentDirectory, `${file.name}.sha256`);
  if (marker.exists && (await marker.text()).trim() === expectedSha256) return true;
  if (await CaptionMedia.sha256(file.uri) !== expectedSha256) return false;
  marker.write(expectedSha256);
  return true;
}

export async function transcribeVideoLocally(options: {
  projectId: string;
  videoUri: string;
  modelId: TranscriptionModel['id'];
  durationMs: number;
  language?: string;
  onProgress?: (progress: TranscriptionProgress) => void;
}): Promise<LocalTranscriptionResult> {
  const { projectId, videoUri, modelId, onProgress } = options;
  const audioDirectory = new Directory(Paths.cache, 'caption-audio');
  audioDirectory.create({ idempotent: true, intermediates: true });
  const audioFile = new File(audioDirectory, `${projectId}.wav`);
  const model = getModel(modelId);
  const modelFile = new File(new Directory(Paths.document, 'models'), model.fileName);
  const estimatedWavBytes = Math.ceil(Math.max(0, options.durationMs) / 1000) * 32_000 + 44;
  const modelBytes = modelFile.exists && modelFile.size === model.downloadBytes ? 0 : model.downloadBytes;
  await requireFreeSpace(estimatedWavBytes + modelBytes + 128 * 1024 * 1024, 'generate captions');

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
  onProgress?.({
    stage: 'preparing-audio',
    progress: 1,
    detail: 'Audio ready',
  });

  const [modelFile, vadModelFile] = await Promise.all([
    ensureModel(modelId, onProgress),
    ensureVadModel(onProgress),
  ]);
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
    speechSegments = await vadContext.detectSpeech(audioFile.uri, {
      threshold: 0.42,
      minSpeechDurationMs: 180,
      minSilenceDurationMs: 280,
      maxSpeechDurationS: 29,
      speechPadMs: 90,
      samplesOverlap: 0.1,
    });
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
    const { promise } = context.transcribe(audioFile.uri, {
      language: options.language ?? 'en',
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
    const result = await promise;
    if (result.isAborted) throw new Error('Transcription was cancelled');

    const words = alignWordsToSpeech(coalesceWhisperWords(result.segments), speechSegments);
    if (words.length === 0) {
      throw new Error('Speech was detected, but no reliable words were found. Try the Balanced model or clearer audio.');
    }
    onProgress?.({
      stage: 'grouping',
      progress: 0.5,
      detail: 'Grouping words into editable subtitles',
    });
    const captions = groupWordsIntoCaptions(words);
    onProgress?.({
      stage: 'grouping',
      progress: 1,
      detail: 'Captions ready',
    });

    return {
      language: result.language || options.language || 'en',
      words,
      captions,
    };
  } finally {
    await context.release();
  }
  } finally {
    if (audioFile.exists) audioFile.delete();
  }
}
