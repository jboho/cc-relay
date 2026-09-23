import { describe, expect, test } from "vitest";
import { fromB64u, toB64u } from "../../src/protocol/encoding.js";
import { generateIdentity, peerId } from "../../src/protocol/identity.js";
import {
  EnvelopeError,
  type Inner,
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
      "too large",
    );
    expect(() => seal(message({ id: "short" }), bob.boxPub, alice.boxSec)).toThrow(EnvelopeError);
  });
});

test("a near-limit plaintext (60 KB after escaping) still fits the frame schema", () => {
  const sealed = seal(message({ text: "\u0001".repeat(10_000) }), bob.boxPub, alice.boxSec);
  expect(sealed.ciphertext.length).toBeLessThanOrEqual(120_000);
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
