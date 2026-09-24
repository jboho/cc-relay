import { describe, expect, test } from "vitest";
import { makePeer } from "../../src/channel/config.js";
import { buildInner, sealFor } from "../../src/channel/outbound.js";
import { MAX_PLAINTEXT_BYTES, MAX_TEXT_BYTES, open } from "../../src/protocol/envelope.js";
import { generateIdentity, peerId } from "../../src/protocol/identity.js";

const alice = generateIdentity("alice");
const bobId = generateIdentity("bob");
const bob = makePeer(bobId);

describe("sealFor", () => {
  test("seals a message only the recipient can open, from and to the right ids", () => {
    const out = sealFor(alice, bob, "hello", 1000);
    if (!out.ok) throw new Error(out.error);
    const inner = open(out.sealed, alice.boxPub, bobId.boxSec);
    expect(inner).toMatchObject({ v: 1, id: out.id, ts: 1000, from: peerId(alice.signPub), to: bob.id, text: "hello" });
  });

  test("each message gets a fresh id and nonce", () => {
    const a = sealFor(alice, bob, "x", 1);
    const b = sealFor(alice, bob, "x", 1);
    if (!a.ok || !b.ok) throw new Error("seal failed");
    expect(a.id).not.toBe(b.id);
    expect(a.sealed.nonce).not.toBe(b.sealed.nonce);
  });

  test("text over the limit, counted in UTF-8 bytes, is refused before sealing", () => {
    expect(sealFor(alice, bob, "a".repeat(MAX_TEXT_BYTES), 1).ok).toBe(true);
    const out = sealFor(alice, bob, "é".repeat(MAX_TEXT_BYTES / 2 + 1), 1);
    expect(out).toEqual({ ok: false, error: `too large: ${MAX_TEXT_BYTES + 2} bytes (max ${MAX_TEXT_BYTES})` });
  });

  test("text whose JSON escaping overflows the plaintext cap maps to too large, with the size and limit", () => {
    const text = "\u0001".repeat(MAX_TEXT_BYTES);
    const inner = buildInner(alice, bob, text, 1);
    const plaintextBytes = Buffer.byteLength(JSON.stringify(inner), "utf8");
    const out = sealFor(alice, bob, text, 1);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected a failure");
    expect(out.error).toBe(`too large: ${plaintextBytes} bytes of plaintext (max ${MAX_PLAINTEXT_BYTES})`);
  });

  test("a wiring bug in our own keys still throws", () => {
    const broken = { ...alice, boxSec: new Uint8Array(3) };
    expect(() => sealFor(broken, bob, "x", 1)).toThrow(/wrong length/);
  });

  test("eve can't open a message sealed for bob, even knowing the ciphertext", () => {
    const out = sealFor(alice, bob, "for bob's eyes only", 1);
    if (!out.ok) throw new Error(out.error);
    const eve = generateIdentity("eve");
    expect(open(out.sealed, alice.boxPub, eve.boxSec)).toBeNull();
  });

  test("opening with a sender key that isn't the actual sender's fails, not silently reads as someone else", () => {
    const out = sealFor(alice, bob, "hello", 1);
    if (!out.ok) throw new Error(out.error);
    const eve = generateIdentity("eve");
    expect(open(out.sealed, eve.boxPub, bobId.boxSec)).toBeNull();
  });
});
