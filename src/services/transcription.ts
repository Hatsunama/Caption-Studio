import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { initWhisper, initWhisperVad } from 'whisper.rn/index';

import CaptionMedia from 'caption-media';
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
import {
  downloadVerifiedModel,
  ModelDownloadIntegrityError,
  ModelDownloadPausedError,
  resumableModelDownloadReservation,
} from '@/services/verified-model-download';
import type { WordToken } from '@/types/project';

export type TranscriptionModelId = 'fast' | 'balanced' | 'accurate';

export type TranscriptionModelOption = Readonly<{
  id: TranscriptionModelId;
  label: string;
  description: string;
  downloadBytes: number;
}>;

type TranscriptionModel = TranscriptionModelOption & Readonly<{
  fileName: string;
  downloadUrl: string;
  sha256: string;
}>;

const MODEL_REVISION = 'c521a4b02f422512d734391fdf08bb08c0862f68';
const MODEL_ROOT = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL_REVISION}`;
const LEGACY_ENGLISH_MODEL_FILES = [
  'ggml-tiny.en-q5_1.bin',
  'ggml-base.en-q5_1.bin',
  'ggml-small.en-q5_1.bin',
] as const;
const TRANSCRIPTION_MODELS: readonly TranscriptionModel[] = [
  {
    id: 'fast',
    label: 'Fast',
    description: 'Tiny multilingual, best for quick drafts and lower-memory phones.',
    fileName: 'ggml-tiny-q5_1.bin',
    downloadUrl: `${MODEL_ROOT}/ggml-tiny-q5_1.bin`,
    downloadBytes: 32_152_673,
    sha256: '818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'Base multilingual, the default quality/speed choice.',
    fileName: 'ggml-base-q5_1.bin',
    downloadUrl: `${MODEL_ROOT}/ggml-base-q5_1.bin`,
    downloadBytes: 59_707_625,
    sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898',
  },
  {
    id: 'accurate',
    label: 'Accurate',
    description: 'Small multilingual, slower and intended for higher-memory phones.',
    fileName: 'ggml-small-q5_1.bin',
    downloadUrl: `${MODEL_ROOT}/ggml-small-q5_1.bin`,
    downloadBytes: 190_085_487,
    sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
  },
];

export const TRANSCRIPTION_MODEL_OPTIONS: readonly TranscriptionModelOption[] = Object.freeze(
  TRANSCRIPTION_MODELS.map(({ id, label, description, downloadBytes }) => Object.freeze({
    id,
    label,
    description,
    downloadBytes,
  })),
);

function getModel(modelId: TranscriptionModelId) {
  const model = TRANSCRIPTION_MODELS.find((item) => item.id === modelId);
  if (!model) throw new Error(`Unknown transcription model: ${modelId}`);
  return model;
}

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
  id: TranscriptionModelId;
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
    for (const suffix of ['', '.sha256', '.sha256.download', '.download', '.download.resume.json', '.download.resume.json.writing']) {
      const file = new File(directory, `${fileName}${suffix}`);
      if (file.exists) file.delete();
    }
  }
}

export async function ensureModel(
  modelId: TranscriptionModelId,
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
  modelId: TranscriptionModelId,
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
  const reservation = await resumableModelDownloadReservation(modelFile, model);
  await requireFreeSpace(
    reservation + MODEL_REPLACEMENT_HEADROOM_BYTES,
    `replace the ${model.label} transcription model safely`,
  );

  onProgress?.({
    stage: 'downloading-model',
    progress: 0,
    detail: `Downloading ${model.label} model once for offline use`,
  });

  try {
    await downloadVerifiedModel({
      target: modelFile,
      descriptor: model,
      verifySha256: (uri) => CaptionMedia.sha256(uri),
      registerPauser: session ? (pause) => session.registerStopper(pause) : undefined,
      onProgress: (bytesWritten, totalBytes) => {
        if (session?.isCancelled()) return;
        const denominator = totalBytes > 0 ? totalBytes : model.downloadBytes;
        onProgress?.({
          stage: 'downloading-model',
          progress: Math.min(1, bytesWritten / denominator),
          detail: `Downloading ${model.label} model`,
        });
      },
      onVerifying: () => onProgress?.({
        stage: 'downloading-model',
        progress: 1,
        detail: `Verifying ${model.label} model`,
      }),
    });
  } catch (error) {
    if (error instanceof ModelDownloadPausedError) session?.throwIfCancelled();
    if (error instanceof ModelDownloadIntegrityError) {
      throw new Error(`The ${model.label} model failed its security check. Delete it and try again.`);
    }
    throw error;
  }
  session?.throwIfCancelled();
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
  const reservation = await resumableModelDownloadReservation(modelFile, VAD_MODEL);
  await requireFreeSpace(
    reservation + MODEL_REPLACEMENT_HEADROOM_BYTES,
    'replace the offline silence-detector model safely',
  );

  onProgress?.({
    stage: 'downloading-model',
    progress: 0,
    detail: 'Downloading the small offline silence detector once',
  });
  try {
    await downloadVerifiedModel({
      target: modelFile,
      descriptor: VAD_MODEL,
      verifySha256: (uri) => CaptionMedia.sha256(uri),
      registerPauser: session ? (pause) => session.registerStopper(pause) : undefined,
      onProgress: (bytesWritten, totalBytes) => {
        if (session?.isCancelled()) return;
        onProgress?.({
          stage: 'downloading-model',
          progress: Math.min(1, bytesWritten / Math.max(1, totalBytes || VAD_MODEL.downloadBytes)),
          detail: 'Downloading offline silence detector',
        });
      },
      onVerifying: () => onProgress?.({
        stage: 'downloading-model',
        progress: 1,
        detail: 'Verifying offline silence detector',
      }),
    });
  } catch (error) {
    if (error instanceof ModelDownloadPausedError) session?.throwIfCancelled();
    if (error instanceof ModelDownloadIntegrityError) {
      throw new Error('The silence-detector model failed its security check. Try the download again.');
    }
    throw error;
  }
  session?.throwIfCancelled();
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

async function modelReplacementReservation(
  file: File,
  descriptor: { downloadUrl: string; downloadBytes: number; sha256: string },
) {
  const { downloadBytes: expectedBytes, sha256: expectedSha256 } = descriptor;
  if (!file.exists || file.size !== expectedBytes) {
    return resumableModelDownloadReservation(file, descriptor);
  }
  const marker = new File(file.parentDirectory, `${file.name}.sha256`);
  if (marker.exists && modelVerificationMarkerMatches(await marker.text(), modelFileIdentity(file), expectedSha256)) return 0;
  return resumableModelDownloadReservation(file, descriptor);
}

export async function transcribeVideoLocally(options: {
  projectId: string;
  videoUri: string;
  modelId: TranscriptionModelId;
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
    modelReplacementReservation(modelFile, model),
    modelReplacementReservation(vadModelFile, VAD_MODEL),
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
