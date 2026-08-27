export type PcmWaveFormat = {
  dataOffset: number;
  dataBytes: number;
  sampleRate: number;
  channelCount: number;
  bitsPerSample: number;
  bytesPerSecond: number;
};

export type ByteRange = { start: number; end: number };

const WAVE_HEADER_BYTES = 44;

export function parseCaptionPcmWave(header: Uint8Array, fileBytes: number): PcmWaveFormat {
  if (header.byteLength < WAVE_HEADER_BYTES) throw new Error('The prepared audio file is incomplete.');
  if (ascii(header, 0, 4) !== 'RIFF' || ascii(header, 8, 4) !== 'WAVE') {
    throw new Error('The prepared audio file is not a WAV file.');
  }
  if (ascii(header, 12, 4) !== 'fmt ' || uint32(header, 16) !== 16 || uint16(header, 20) !== 1) {
    throw new Error('The prepared audio file does not use supported PCM audio.');
  }
  if (ascii(header, 36, 4) !== 'data') throw new Error('The prepared audio file has an unsupported WAV layout.');
  const channelCount = uint16(header, 22);
  const sampleRate = uint32(header, 24);
  const bitsPerSample = uint16(header, 34);
  const dataBytes = uint32(header, 40);
  const bytesPerSample = bitsPerSample / 8;
  const bytesPerSecond = sampleRate * channelCount * bytesPerSample;
  if (channelCount !== 1 || sampleRate !== 16_000 || bitsPerSample !== 16 || !Number.isSafeInteger(bytesPerSecond)) {
    throw new Error('The prepared audio file does not use 16 kHz mono PCM audio.');
  }
  if (dataBytes <= 0 || dataBytes > fileBytes - WAVE_HEADER_BYTES || dataBytes % 2 !== 0) {
    throw new Error('The prepared audio file has invalid sample data.');
  }
  return {
    dataOffset: WAVE_HEADER_BYTES,
    dataBytes,
    sampleRate,
    channelCount,
    bitsPerSample,
    bytesPerSecond,
  };
}

export function planOverlappingPcmChunks(
  dataBytes: number,
  bytesPerSecond: number,
  chunkSeconds = 30,
  overlapSeconds = 2,
): ByteRange[] {
  const sampleBytes = 2;
  const chunkBytes = evenFloor(bytesPerSecond * chunkSeconds, sampleBytes);
  const overlapBytes = evenFloor(bytesPerSecond * overlapSeconds, sampleBytes);
  if (dataBytes <= 0 || chunkBytes <= 0 || overlapBytes < 0 || overlapBytes >= chunkBytes) {
    throw new Error('The speech-detector chunk configuration is invalid.');
  }
  const ranges: ByteRange[] = [];
  let start = 0;
  while (start < dataBytes) {
    const end = Math.min(dataBytes, start + chunkBytes);
    ranges.push({ start, end });
    if (end === dataBytes) break;
    start = end - overlapBytes;
  }
  return ranges;
}

export function buildPcm16MonoWave(pcm: Uint8Array, sampleRate: number): Uint8Array {
  if (pcm.byteLength <= 0 || pcm.byteLength % 2 !== 0) throw new Error('PCM chunks must contain complete 16-bit samples.');
  const output = new Uint8Array(WAVE_HEADER_BYTES + pcm.byteLength);
  const view = new DataView(output.buffer);
  writeAscii(output, 0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(output, 8, 'WAVE');
  writeAscii(output, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(output, 36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  output.set(pcm, WAVE_HEADER_BYTES);
  return output;
}

function uint16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
}

function evenFloor(value: number, alignment: number): number {
  return Math.floor(value / alignment) * alignment;
}
