// Request body reader with a hard byte cap. Checks the declared Content-Length first, then counts the bytes
// actually read (chunked bodies or a lying Content-Length can't get past the cap).
export const MAX_BODY_BYTES = 32 * 1024;

export class BodyError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function declaredTooLarge(request, max = MAX_BODY_BYTES) {
  const cl = request.headers.get('content-length');
  if (cl === null) return false;
  if (!/^\d+$/.test(cl.trim())) throw new BodyError(400, 'bad_content_length', 'Content-Length must be a number.');
  return Number(cl) > max;
}

export async function readBodyCapped(request, max = MAX_BODY_BYTES) {
  if (declaredTooLarge(request, max)) throw tooLarge(max);
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      reader.cancel().catch(() => {}); // don't wait for the client to stop sending
      throw tooLarge(max);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new BodyError(400, 'invalid_encoding', 'Request body must be UTF-8.');
  }
}

export function tooLarge(max = MAX_BODY_BYTES) {
  return new BodyError(413, 'payload_too_large', `Request body exceeds ${max.toLocaleString('en-US')} bytes (32 KB). Send at most 500 codes per batch.`);
}
