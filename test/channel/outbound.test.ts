import { describe, expect, test } from "vitest";
import { makePeer } from "../../src/channel/config.js";
import { sealFor } from "../../src/channel/outbound.js";
import { MAX_TEXT_BYTES, open } from "../../src/protocol/envelope.js";
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

  test("text whose JSON escaping overflows the plaintext cap maps to too large", () => {
    expect(sealFor(alice, bob, "\u0001".repeat(MAX_TEXT_BYTES), 1)).toEqual({ ok: false, error: "too large" });
  });

  test("a wiring bug in our own keys still throws", () => {
    const broken = { ...alice, boxSec: new Uint8Array(3) };
    expect(() => sealFor(broken, bob, "x", 1)).toThrow(/wrong length/);
  });
});
