import { describe, expect, test } from "vitest";
import {
  bytesEqual,
  concatBytes,
  EncodingError,
  fromB64u,
  toB64u,
  u64be,
} from "../../src/protocol/encoding.js";

describe("base64url", () => {
  test("round-trips bytes", () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    expect(fromB64u(toB64u(bytes))).toEqual(bytes);
  });

  test("rejects characters outside the alphabet", () => {
    expect(() => fromB64u("ab+c")).toThrow(EncodingError);
    expect(() => fromB64u("ab/c")).toThrow(EncodingError);
    expect(() => fromB64u("abc=")).toThrow(EncodingError);
  });

  test("rejects non-canonical encodings", () => {
    // "AB" decodes to one byte whose canonical encoding is "AA".
    expect(() => fromB64u("AB")).toThrow(EncodingError);
  });

  test("enforces an expected length", () => {
    const text = toB64u(new Uint8Array(32));
    expect(fromB64u(text, 32)).toHaveLength(32);
    expect(() => fromB64u(text, 24)).toThrow(EncodingError);
  });
});

describe("bytes helpers", () => {
  test("concatBytes joins in order", () => {
    expect(concatBytes(new Uint8Array([1]), new Uint8Array([2, 3]))).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  test("u64be encodes big-endian and rejects bad input", () => {
    expect(u64be(258)).toEqual(new Uint8Array([0, 0, 0, 0, 0, 0, 1, 2]));
    expect(() => u64be(-1)).toThrow(EncodingError);
    expect(() => u64be(1.5)).toThrow(EncodingError);
  });

  test("bytesEqual compares length and content", () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});
