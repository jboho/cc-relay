import nacl from "tweetnacl";
import { describe, expect, test } from "vitest";
import { fromB64u, toB64u, utf8 } from "../../src/protocol/encoding.js";
import { generateIdentity, peerId } from "../../src/protocol/identity.js";
import {
  EnvelopeError,
  type Inner,
  MAX_PLAINTEXT_BYTES,
  MAX_TEXT_BYTES,
  newMessageId,
  open,
  seal,
} from "../../src/protocol/envelope.js";

const alice = generateIdentity("alice");
const bob = generateIdentity("bob");
const carol = generateIdentity("carol");

function message(overrides: Partial<Inner> = {}): Inner {
  return {
    v: 1,
    id: newMessageId(),
    ts: 1_790_000_000_000,
    from: peerId(alice.signPub),
    to: peerId(bob.signPub),
    text: "hello bob",
    ...overrides,
  };
}

describe("seal/open", () => {
  test("round-trips from alice to bob", () => {
    const inner = message();
    const sealed = seal(inner, bob.boxPub, alice.boxSec);
    expect(open(sealed, alice.boxPub, bob.boxSec)).toEqual(inner);
  });

  test("fails with the wrong sender key or the wrong recipient key", () => {
    const sealed = seal(message(), bob.boxPub, alice.boxSec);
    expect(open(sealed, carol.boxPub, bob.boxSec)).toBeNull();
    expect(open(sealed, alice.boxPub, carol.boxSec)).toBeNull();
  });

  test("fails on a tampered ciphertext or nonce", () => {
    const sealed = seal(message(), bob.boxPub, alice.boxSec);
    const ct = fromB64u(sealed.ciphertext);
    ct[ct.length - 1]! ^= 1;
    expect(open({ ...sealed, ciphertext: toB64u(ct) }, alice.boxPub, bob.boxSec)).toBeNull();
    const nonce = fromB64u(sealed.nonce);
    nonce[0]! ^= 1;
    expect(open({ ...sealed, nonce: toB64u(nonce) }, alice.boxPub, bob.boxSec)).toBeNull();
  });

  test("fails on malformed encodings without throwing", () => {
    expect(open({ ciphertext: "!!", nonce: "AA" }, alice.boxPub, bob.boxSec)).toBeNull();
    const sealed = seal(message(), bob.boxPub, alice.boxSec);
    expect(open({ ...sealed, nonce: toB64u(new Uint8Array(8)) }, alice.boxPub, bob.boxSec)).toBeNull();
  });

  test("returns null (does not throw) for authenticated but malformed plaintext", () => {
    // Encrypted honestly from alice to bob, but the plaintext inside is not a
    // valid Inner message. Decryption succeeds (it authenticates), so this
    // must still resolve to null via the schema/JSON checks, not throw.
    const encryptFrom = (plaintext: Uint8Array) => {
      const nonce = nacl.randomBytes(24);
      const ciphertext = nacl.box(plaintext, nonce, bob.boxPub, alice.boxSec);
      return { ciphertext: toB64u(ciphertext), nonce: toB64u(nonce) };
    };
    expect(open(encryptFrom(new Uint8Array([0xff])), alice.boxPub, bob.boxSec)).toBeNull();
    expect(open(encryptFrom(utf8("not json")), alice.boxPub, bob.boxSec)).toBeNull();
    expect(
      open(encryptFrom(utf8(JSON.stringify({ ...message(), extra: true }))), alice.boxPub, bob.boxSec),
    ).toBeNull();
  });

  test("throws on wrong-length local keys instead of returning null", () => {
    const sealed = seal(message(), bob.boxPub, alice.boxSec);
    // bob.signSec is a 64-byte ed25519 secret key, not a 32-byte box secret
    // key: a local wiring bug, not peer input, so it must throw.
    expect(() => open(sealed, alice.boxPub, bob.signSec)).toThrow(EnvelopeError);
    expect(() => seal(message(), bob.boxPub.subarray(0, 31), alice.boxSec)).toThrow(EnvelopeError);
  });

  test("seal refuses invalid or oversize messages", () => {
    expect(() => seal(message({ text: "x".repeat(32 * 1024 + 1) }), bob.boxPub, alice.boxSec)).toThrow(
      EnvelopeError,
    );
    // 32 KB limit is in UTF-8 bytes, not characters: 8,193 four-byte emoji = 32,772 bytes.
    expect(() => seal(message({ text: "😀".repeat(8193) }), bob.boxPub, alice.boxSec)).toThrow(
      EnvelopeError,
    );
    // Under the text limit, but JSON escaping (\u0001 → 6 bytes) exceeds the plaintext cap.
    expect(() => seal(message({ text: "\u0001".repeat(20_000) }), bob.boxPub, alice.boxSec)).toThrow(
      EnvelopeError,
    );
    expect(() => seal(message({ text: "\u0001".repeat(20_000) }), bob.boxPub, alice.boxSec)).toThrow(
      "too large",
    );
    expect(() => seal(message({ id: "short" }), bob.boxPub, alice.boxSec)).toThrow(EnvelopeError);
  });
});

test("a plaintext at exactly MAX_PLAINTEXT_BYTES fits the frame schema; one byte more is refused", () => {
  // Build a message whose JSON-serialized byte length is exactly
  // MAX_PLAINTEXT_BYTES: n copies of "\u0001" (6 JSON bytes each) plus "a"
  // padding (1 JSON byte each) for the remainder.
  const base = utf8(JSON.stringify(message({ text: "" }))).length;
  const remaining = MAX_PLAINTEXT_BYTES - base;
  const n = Math.floor(remaining / 6);
  const p = remaining - n * 6;
  const text = "\u0001".repeat(n) + "a".repeat(p);
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_TEXT_BYTES);

  const exact = message({ text });
  expect(utf8(JSON.stringify(exact)).length).toBe(MAX_PLAINTEXT_BYTES);

  const sealed = seal(exact, bob.boxPub, alice.boxSec);
  expect(sealed.ciphertext.length).toBeLessThanOrEqual(120_000);

  const overBy1 = message({ text: text + "a" });
  expect(() => seal(overBy1, bob.boxPub, alice.boxSec)).toThrow(EnvelopeError);
  expect(() => seal(overBy1, bob.boxPub, alice.boxSec)).toThrow(/too large/);
});

test("EnvelopeError codes keep wiring, invalid and too-large apart", () => {
  const codeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return err instanceof EnvelopeError ? err.code : "not an EnvelopeError";
    }
    return "no throw";
  };
  expect(codeOf(() => seal(message(), bob.boxPub.subarray(0, 31), alice.boxSec))).toBe("wiring");
  expect(codeOf(() => seal(message({ id: "short" }), bob.boxPub, alice.boxSec))).toBe("invalid");
  const huge = "\u0001".repeat(MAX_TEXT_BYTES);
  expect(codeOf(() => seal(message({ text: huge }), bob.boxPub, alice.boxSec))).toBe("too_large");
});

describe("nonce discipline", () => {
  test("seal takes no nonce parameter", () => {
    // Three parameters: message, recipient box key, sender box secret. A nonce
    // parameter would let a caller pass a counter.
    expect(seal.length).toBe(3);
  });

  test("10,000 seals of the same message never repeat a nonce", () => {
    const inner = message();
    const nonces = new Set<string>();
    for (let i = 0; i < 10_000; i++) nonces.add(seal(inner, bob.boxPub, alice.boxSec).nonce);
    expect(nonces.size).toBe(10_000);
  }, 60_000); // tweetnacl is pure JS: 10k box operations take several seconds.
});
