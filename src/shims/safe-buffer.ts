type BufferInput = string | ArrayBuffer | ArrayBufferView | readonly number[];

class HermesBuffer extends Uint8Array {
  override toString(encoding: 'base64' | 'utf8' | 'utf-8' = 'utf8') {
    if (encoding === 'base64') return encodeBase64(this);
    if (encoding === 'utf8' || encoding === 'utf-8') return new TextDecoder().decode(this);
    throw new Error(`Unsupported buffer encoding: ${encoding}`);
  }
}

export const Buffer = {
  from(value: BufferInput, encoding: 'base64' | 'utf8' | 'utf-8' = 'utf8'): HermesBuffer {
    if (typeof value === 'string') {
      return wrap(encoding === 'base64' ? decodeBase64(value) : new TextEncoder().encode(value));
    }
    if (value instanceof ArrayBuffer) return wrap(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) {
      return wrap(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
    return wrap(Uint8Array.from(value));
  },
};

function wrap(value: Uint8Array) {
  const result = new HermesBuffer(value.byteLength);
  result.set(value);
  return result;
}

function decodeBase64(value: string) {
  const normalized = value.replace(/\s+/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) {
    throw new Error('Invalid base64 input');
  }
  const decoded = globalThis.atob(normalized);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

function encodeBase64(value: Uint8Array) {
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...value.subarray(offset, Math.min(value.length, offset + 0x8000))));
  }
  return globalThis.btoa(chunks.join(''));
}
