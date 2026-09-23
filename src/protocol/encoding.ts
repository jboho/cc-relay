export class EncodingError extends Error {
  override name = "EncodingError";
}

const B64U_RE = /^[A-Za-z0-9_-]*$/;

export function toB64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

// Buffer's base64url decoder silently skips invalid characters, so the input is
// checked against the alphabet and must survive a canonical round trip.
export function fromB64u(text: string, expectedLength?: number): Uint8Array {
  if (!B64U_RE.test(text)) throw new EncodingError("invalid base64url");
  const bytes = new Uint8Array(Buffer.from(text, "base64url"));
  if (toB64u(bytes) !== text) throw new EncodingError("non-canonical base64url");
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new EncodingError(`expected ${expectedLength} bytes, got ${bytes.length}`);
  }
  return bytes;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function u64be(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EncodingError("u64be expects a non-negative safe integer");
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
