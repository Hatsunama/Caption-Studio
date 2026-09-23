import {
  File,
  FileMode,
} from 'expo-file-system';

import {
  decodeModelDownloadCheckpoint,
  decodeModelDownloadResume,
  encodeModelDownloadCheckpoint,
  matchesModelContentRange,
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

export class ModelDownloadTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelDownloadTransferError';
  }
}

const CHUNK_BYTES = 8 * 1024 * 1024;
const COPY_BYTES = 1024 * 1024;
const MAX_ATTEMPTS = 3;

export async function downloadVerifiedModel(options: DownloadOptions) {
  const { target, descriptor } = options;
  const temporary = temporaryFile(target);
  const resumeFile = resumeStateFile(target);
  const chunk = chunkFile(target);
  const chunkMarker = chunkMarkerFile(target);
  const identity = downloadIdentity(temporary, descriptor);

  if (temporary.exists && temporary.size === descriptor.downloadBytes) {
    options.onVerifying?.();
    if (await options.verifySha256(temporary.uri) === descriptor.sha256) {
      deleteIfPresent(resumeFile);
      deleteIfPresent(chunk);
      deleteIfPresent(chunkMarker);
      await replaceTarget(temporary, target);
      return target;
    }
    removeResumableModelDownloadArtifacts(target);
  }

  let committedBytes = await readValidCheckpoint(temporary, resumeFile, chunk, chunkMarker, identity);
  if (!temporary.exists) temporary.create();
  await writeResumeState(resumeFile, encodeModelDownloadCheckpoint(identity, committedBytes));
  options.onProgress?.(committedBytes, descriptor.downloadBytes);
  let pauseRequested = false;
  let activeRequest: AbortController | undefined;
  const pause = async () => {
    pauseRequested = true;
    activeRequest?.abort();
  };
  const unregisterPauser = options.registerPauser?.(pause);

  try {
    while (committedBytes < descriptor.downloadBytes) {
      if (pauseRequested) throw new ModelDownloadPausedError();
      const end = Math.min(descriptor.downloadBytes, committedBytes + CHUNK_BYTES) - 1;
      const chunkLength = end - committedBytes + 1;
      if (!chunk.exists || chunk.size !== chunkLength) {
        deleteIfPresent(chunk);
        deleteIfPresent(chunkMarker);
        const bytes = await fetchVerifiedRange(
          descriptor.downloadUrl,
          committedBytes,
          end,
          descriptor.downloadBytes,
          () => pauseRequested,
          (controller) => { activeRequest = controller; },
        );
        if (pauseRequested) throw new ModelDownloadPausedError();
        chunkMarker.write(String(committedBytes));
        chunk.write(bytes);
      }
      if (temporary.size < committedBytes || temporary.size > committedBytes + chunkLength) {
        throw new ModelDownloadIntegrityError();
      }
      appendChunk(temporary, chunk, committedBytes);
      committedBytes += chunkLength;
      await writeResumeState(resumeFile, encodeModelDownloadCheckpoint(identity, committedBytes));
      deleteIfPresent(chunk);
      deleteIfPresent(chunkMarker);
      options.onProgress?.(committedBytes, descriptor.downloadBytes);
    }
    if (temporary.size !== descriptor.downloadBytes) {
      throw new ModelDownloadIntegrityError();
    }
    options.onVerifying?.();
    if (await options.verifySha256(temporary.uri) !== descriptor.sha256) {
      throw new ModelDownloadIntegrityError();
    }
    await replaceTarget(temporary, target);
    deleteIfPresent(resumeFile);
    return target;
  } catch (error) {
    if (error instanceof ModelDownloadIntegrityError) {
      removeResumableModelDownloadArtifacts(target);
    }
    if (pauseRequested) throw new ModelDownloadPausedError();
    throw error;
  } finally {
    unregisterPauser?.();
  }
}

export async function resumableModelDownloadReservation(
  target: File,
  descriptor: VerifiedModelDescriptor,
  verifySha256: (uri: string) => Promise<string>,
) {
  const temporary = temporaryFile(target);
  const resumeFile = resumeStateFile(target);
  if (temporary.exists && temporary.size === descriptor.downloadBytes) {
    if (await verifySha256(temporary.uri) === descriptor.sha256) return 0;
    removeResumableModelDownloadArtifacts(target);
    return descriptor.downloadBytes;
  }
  const identity = downloadIdentity(temporary, descriptor);
  const committedBytes = await readValidCheckpoint(
    temporary, resumeFile, chunkFile(target), chunkMarkerFile(target), identity,
  );
  return remainingModelDownloadBytes(
    descriptor.downloadBytes,
    committedBytes,
    committedBytes > 0,
  );
}

export function removeResumableModelDownloadArtifacts(target: File) {
  deleteIfPresent(temporaryFile(target));
  deleteIfPresent(chunkFile(target));
  deleteIfPresent(chunkMarkerFile(target));
  const state = resumeStateFile(target);
  deleteIfPresent(state);
  deleteIfPresent(new File(state.parentDirectory, `${state.name}.writing`));
}

async function readValidCheckpoint(
  temporary: File,
  resumeFile: File,
  chunk: File,
  chunkMarker: File,
  identity: ModelDownloadResumeIdentity,
) {
  if (!temporary.exists || !resumeFile.exists) {
    if (temporary.exists || resumeFile.exists) {
      deleteIfPresent(temporary);
      deleteIfPresent(resumeFile);
    }
    deleteIfPresent(chunk);
    deleteIfPresent(chunkMarker);
    return 0;
  }
  const raw = await resumeFile.text();
  const checkpoint = decodeModelDownloadCheckpoint(raw, identity);
  if (checkpoint !== undefined) {
    const chunkLength = Math.min(CHUNK_BYTES, identity.expectedBytes - checkpoint);
    const currentChunk = chunk.exists && chunkMarker.exists
      && chunk.size === chunkLength
      && await chunkMarker.text() === String(checkpoint);
    if (
      temporary.size >= checkpoint
      && temporary.size <= checkpoint + chunkLength
      && (temporary.size === checkpoint || currentChunk)
    ) {
      if (!currentChunk) {
        deleteIfPresent(chunk);
        deleteIfPresent(chunkMarker);
      }
      return checkpoint;
    }
  } else if (
    temporary.size > 0
    && temporary.size < identity.expectedBytes
    && decodeModelDownloadResume(raw, identity)
  ) {
    deleteIfPresent(chunk);
    deleteIfPresent(chunkMarker);
    await writeResumeState(resumeFile, encodeModelDownloadCheckpoint(identity, temporary.size));
    return temporary.size;
  }
  deleteIfPresent(temporary);
  deleteIfPresent(resumeFile);
  deleteIfPresent(chunk);
  deleteIfPresent(chunkMarker);
  return 0;
}

async function fetchVerifiedRange(
  url: string,
  start: number,
  end: number,
  total: number,
  isPaused: () => boolean,
  setActiveRequest: (controller: AbortController | undefined) => void,
) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (isPaused()) throw new ModelDownloadPausedError();
    const controller = new AbortController();
    setActiveRequest(controller);
    try {
      const response = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' },
        signal: controller.signal,
      });
      if (response.status !== 206 || !matchesModelContentRange(response.headers.get('Content-Range'), start, end, total)) {
        if (response.status === 408 || response.status === 429 || response.status >= 500) {
          throw new Error(`HTTP ${response.status}`);
        }
        throw new ModelDownloadTransferError(
          `The model server did not return the requested byte range (HTTP ${response.status}). Download progress was saved; try again later.`,
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== end - start + 1) {
        throw new Error('The connection ended before the requested bytes arrived.');
      }
      return bytes;
    } catch (error) {
      if (isPaused()) throw new ModelDownloadPausedError();
      if (error instanceof ModelDownloadTransferError) throw error;
      if (attempt === MAX_ATTEMPTS) {
        throw new ModelDownloadTransferError('The model connection stopped after three attempts. Download progress was saved; try again when the connection is stable.');
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
    } finally {
      setActiveRequest(undefined);
    }
  }
  throw new ModelDownloadTransferError('The model download stopped. Download progress was saved.');
}

function appendChunk(target: File, chunk: File, offset: number) {
  const source = chunk.open(FileMode.ReadOnly);
  const destination = target.open(FileMode.WriteOnly);
  try {
    destination.offset = offset;
    let remaining = chunk.size;
    while (remaining > 0) {
      const bytes = source.readBytes(Math.min(COPY_BYTES, remaining));
      if (bytes.length === 0) throw new ModelDownloadIntegrityError();
      destination.writeBytes(bytes);
      remaining -= bytes.length;
    }
  } finally {
    source.close();
    destination.close();
  }
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

function chunkFile(target: File) {
  return new File(target.parentDirectory, `${target.name}.download.chunk`);
}

function chunkMarkerFile(target: File) {
  return new File(target.parentDirectory, `${target.name}.download.chunk.offset`);
}

function deleteIfPresent(file: File) {
  if (file.exists) file.delete();
}
