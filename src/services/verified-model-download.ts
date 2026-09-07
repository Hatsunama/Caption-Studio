import {
  DownloadTask,
  File,
  type DownloadPauseState,
  type DownloadProgress,
} from 'expo-file-system';

import {
  decodeModelDownloadResume,
  encodeModelDownloadResume,
  remainingModelDownloadBytes,
  type ModelDownloadResumeIdentity,
} from '@/lib/model-download-resume';

export type VerifiedModelDescriptor = {
  downloadUrl: string;
  downloadBytes: number;
  sha256: string;
};

type DownloadOptions = {
  target: File;
  descriptor: VerifiedModelDescriptor;
  verifySha256: (uri: string) => Promise<string>;
  onProgress?: (bytesWritten: number, totalBytes: number) => void;
  onVerifying?: () => void;
  registerPauser?: (pause: () => Promise<void>) => (() => void);
};

export class ModelDownloadPausedError extends Error {
  constructor() {
    super('The model download paused. Downloaded bytes were saved for the next attempt.');
    this.name = 'ModelDownloadPausedError';
  }
}

export class ModelDownloadIntegrityError extends Error {
  constructor() {
    super('The model download failed its security check and was discarded.');
    this.name = 'ModelDownloadIntegrityError';
  }
}

export async function downloadVerifiedModel(options: DownloadOptions) {
  const { target, descriptor } = options;
  const temporary = temporaryFile(target);
  const resumeFile = resumeStateFile(target);
  const identity = downloadIdentity(temporary, descriptor);

  if (temporary.exists && temporary.size === descriptor.downloadBytes) {
    options.onVerifying?.();
    if (await options.verifySha256(temporary.uri) === descriptor.sha256) {
      deleteIfPresent(resumeFile);
      await replaceTarget(temporary, target);
      return target;
    }
    removeResumableModelDownloadArtifacts(target);
  }

  const resumeData = await readValidResumeData(temporary, resumeFile, identity);
  options.onProgress?.(resumeData ? temporary.size : 0, descriptor.downloadBytes);
  const taskOptions = {
    onProgress: ({ bytesWritten, totalBytes }: DownloadProgress) => {
      options.onProgress?.(bytesWritten, totalBytes > 0 ? totalBytes : descriptor.downloadBytes);
    },
  };
  const pauseState: DownloadPauseState | undefined = resumeData ? {
    url: descriptor.downloadUrl,
    fileUri: temporary.uri,
    isDirectory: false,
    resumeData,
  } : undefined;
  const task = pauseState
    ? DownloadTask.fromSavable(pauseState, taskOptions)
    : new DownloadTask(descriptor.downloadUrl, temporary, taskOptions);
  let pauseRequested = false;
  let pauseOperation: Promise<void> | undefined;
  const transfer = pauseState ? task.resumeAsync() : task.downloadAsync();
  const pause = () => {
    if (pauseOperation) return pauseOperation;
    pauseRequested = true;
    pauseOperation = (async () => {
      if (task.state === 'active') await task.pauseAsync();
      if (task.state !== 'paused') return;
      const saved = task.savable();
      if (!saved.resumeData) throw new Error('Android did not provide resumable download state.');
      await writeResumeState(resumeFile, encodeModelDownloadResume(identity, saved.resumeData));
    })();
    return pauseOperation;
  };
  const unregisterPauser = options.registerPauser?.(pause);

  try {
    const result = await transfer;
    if (!result) {
      if (!pauseOperation) throw new Error('The model download stopped without resumable state.');
      await pauseOperation;
      throw new ModelDownloadPausedError();
    }
    if (temporary.size !== descriptor.downloadBytes) {
      throw new Error('The model download ended before every byte arrived.');
    }
    options.onVerifying?.();
    if (await options.verifySha256(temporary.uri) !== descriptor.sha256) {
      throw new ModelDownloadIntegrityError();
    }
    deleteIfPresent(resumeFile);
    await replaceTarget(temporary, target);
    return target;
  } catch (error) {
    if (pauseRequested) {
      try {
        await pauseOperation;
      } catch (pauseError) {
        removeResumableModelDownloadArtifacts(target);
        throw pauseError;
      }
      if (resumeFile.exists && temporary.exists) throw new ModelDownloadPausedError();
    }
    removeResumableModelDownloadArtifacts(target);
    throw error;
  } finally {
    unregisterPauser?.();
    task.release();
  }
}

export async function resumableModelDownloadReservation(
  target: File,
  descriptor: VerifiedModelDescriptor,
) {
  const temporary = temporaryFile(target);
  const resumeFile = resumeStateFile(target);
  const identity = downloadIdentity(temporary, descriptor);
  const resumeData = await readValidResumeData(temporary, resumeFile, identity);
  return remainingModelDownloadBytes(
    descriptor.downloadBytes,
    temporary.exists ? temporary.size : 0,
    Boolean(resumeData),
  );
}

export function removeResumableModelDownloadArtifacts(target: File) {
  deleteIfPresent(temporaryFile(target));
  const state = resumeStateFile(target);
  deleteIfPresent(state);
  deleteIfPresent(new File(state.parentDirectory, `${state.name}.writing`));
}

async function readValidResumeData(
  temporary: File,
  resumeFile: File,
  identity: ModelDownloadResumeIdentity,
) {
  if (!temporary.exists || !resumeFile.exists) {
    if (temporary.exists || resumeFile.exists) {
      deleteIfPresent(temporary);
      deleteIfPresent(resumeFile);
    }
    return undefined;
  }
  if (temporary.size <= 0 || temporary.size >= identity.expectedBytes) {
    deleteIfPresent(temporary);
    deleteIfPresent(resumeFile);
    return undefined;
  }
  const resumeData = decodeModelDownloadResume(await resumeFile.text(), identity);
  if (!resumeData) {
    deleteIfPresent(temporary);
    deleteIfPresent(resumeFile);
  }
  return resumeData;
}

async function writeResumeState(state: File, value: string) {
  const writing = new File(state.parentDirectory, `${state.name}.writing`);
  deleteIfPresent(writing);
  writing.write(value);
  let moved = false;
  try {
    await writing.move(state, { overwrite: true });
    moved = true;
  } finally {
    if (!moved) deleteIfPresent(writing);
  }
}

async function replaceTarget(source: File, target: File) {
  await source.move(target, { overwrite: true });
}

function downloadIdentity(temporary: File, descriptor: VerifiedModelDescriptor) {
  return {
    url: descriptor.downloadUrl,
    fileUri: temporary.uri,
    expectedBytes: descriptor.downloadBytes,
    sha256: descriptor.sha256,
  };
}

function temporaryFile(target: File) {
  return new File(target.parentDirectory, `${target.name}.download`);
}

function resumeStateFile(target: File) {
  return new File(target.parentDirectory, `${target.name}.download.resume.json`);
}

function deleteIfPresent(file: File) {
  if (file.exists) file.delete();
}
