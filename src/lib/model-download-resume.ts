export type ModelDownloadResumeIdentity = {
  url: string;
  fileUri: string;
  expectedBytes: number;
  sha256: string;
};

type StoredModelDownloadResume = ModelDownloadResumeIdentity & {
  version: 1;
  resumeData: string;
};

const MAX_RESUME_STATE_CHARACTERS = 1024 * 1024;
const STORED_KEYS = ['expectedBytes', 'fileUri', 'resumeData', 'sha256', 'url', 'version'];

export function encodeModelDownloadResume(
  identity: ModelDownloadResumeIdentity,
  resumeData: string,
) {
  requireIdentity(identity);
  if (!resumeData || resumeData.length > MAX_RESUME_STATE_CHARACTERS) {
    throw new Error('The model-download resume state is invalid.');
  }
  const stored: StoredModelDownloadResume = { version: 1, ...identity, resumeData };
  return JSON.stringify(stored);
}

export function decodeModelDownloadResume(
  raw: string,
  expected: ModelDownloadResumeIdentity,
) {
  requireIdentity(expected);
  if (!raw || raw.length > MAX_RESUME_STATE_CHARACTERS || raw.trim() !== raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || Object.keys(value).sort().join('|') !== STORED_KEYS.join('|')) return undefined;
  if (
    value.version !== 1
    || value.url !== expected.url
    || value.fileUri !== expected.fileUri
    || value.expectedBytes !== expected.expectedBytes
    || value.sha256 !== expected.sha256
    || typeof value.resumeData !== 'string'
    || !value.resumeData
    || value.resumeData.length > MAX_RESUME_STATE_CHARACTERS
  ) return undefined;
  return value.resumeData;
}

export function remainingModelDownloadBytes(expectedBytes: number, partialBytes: number, resumable: boolean) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
    throw new Error('The expected model size is invalid.');
  }
  if (!resumable || !Number.isSafeInteger(partialBytes) || partialBytes <= 0 || partialBytes >= expectedBytes) {
    return expectedBytes;
  }
  return expectedBytes - partialBytes;
}

function requireIdentity(identity: ModelDownloadResumeIdentity) {
  if (
    !identity.url.startsWith('https://')
    || /\s/.test(identity.url)
    || !identity.fileUri.startsWith('file://')
    || !Number.isSafeInteger(identity.expectedBytes)
    || identity.expectedBytes <= 0
    || identity.sha256.length !== 64
    || [...identity.sha256].some((character) => !'0123456789abcdef'.includes(character))
  ) {
    throw new Error('The model-download identity is invalid.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
