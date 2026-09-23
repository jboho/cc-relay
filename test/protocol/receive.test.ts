import { describe, expect, test } from "vitest";
import { generateIdentity, type Identity, peerId } from "../../src/protocol/identity.js";
import { type Inner, newMessageId, seal } from "../../src/protocol/envelope.js";
import {
  acceptInbound,
  MAX_SKEW_MS,
  type Peer,
  type ReceiveContext,
  SEEN_TTL_MS,
} from "../../src/protocol/receive.js";
import { ReplayGuard } from "../../src/protocol/replay.js";

const self = generateIdentity("me");
const alice = generateIdentity("alice");
const bob = generateIdentity("bob");
const NOW = 1_790_000_000_000;

const asPeer = (id: Identity): Peer => ({
  id: peerId(id.signPub),
  alias: id.alias,
  signPub: id.signPub,
  boxPub: id.boxPub,
});

function context(overrides: Partial<ReceiveContext> = {}): ReceiveContext {
  return {
    selfId: peerId(self.signPub),
    selfBoxSec: self.boxSec,
    peers: new Map([asPeer(alice), asPeer(bob)].map((p) => [p.id, p])),
    replay: new ReplayGuard(SEEN_TTL_MS),
    now: NOW,
    ...overrides,
  };
}

function inner(sender: Identity, overrides: Partial<Inner> = {}): Inner {
  return {
    v: 1,
    id: newMessageId(),
    ts: NOW,
    from: peerId(sender.signPub),
    to: peerId(self.signPub),
    text: "hi",
    ...overrides,
  };
}

// sealedBy: whose box secret seals it. outerFrom: what the hub stamped.
function frame(sealedBy: Identity, outerFrom: Identity, msg: Inner) {
  return { from: peerId(outerFrom.signPub), ...seal(msg, self.boxPub, sealedBy.boxSec) };
}

describe("acceptInbound", () => {
  test("accepts a valid message from a known peer", () => {
    const msg = inner(alice);
    const result = acceptInbound(frame(alice, alice, msg), context());
    expect(result).toEqual({ ok: true, peer: asPeer(alice), message: msg });
  });

  test("drops an unknown sender before any decryption", () => {
    const stranger = generateIdentity("stranger");
    const result = acceptInbound(frame(stranger, stranger, inner(stranger)), context());
    expect(result).toEqual({ ok: false, reason: "unknown_sender" });
  });

  test("peer A's message that opens under A's key but claims inner from:B is dropped", () => {
    const result = acceptInbound(frame(alice, alice, inner(alice, { from: peerId(bob.signPub) })), context());
    expect(result).toEqual({ ok: false, reason: "sender_mismatch" });
  });

  test("a message sealed by B but stamped outer from:A doesn't open", () => {
    // Would succeed if the receiver tried every peer's box key.
    const result = acceptInbound(frame(bob, alice, inner(bob)), context());
    expect(result).toEqual({ ok: false, reason: "undecryptable" });
  });

  test("drops a message addressed to someone else", () => {
    const result = acceptInbound(frame(alice, alice, inner(alice, { to: peerId(bob.signPub) })), context());
    expect(result).toEqual({ ok: false, reason: "recipient_mismatch" });
  });

  test("drops messages outside the ±5 min window, accepts at the edge", () => {
    const early = inner(alice, { ts: NOW - MAX_SKEW_MS - 1 });
    const late = inner(alice, { ts: NOW + MAX_SKEW_MS + 1 });
    const edge = inner(alice, { ts: NOW - MAX_SKEW_MS });
    expect(acceptInbound(frame(alice, alice, early), context())).toEqual({ ok: false, reason: "stale" });
    expect(acceptInbound(frame(alice, alice, late), context())).toEqual({ ok: false, reason: "stale" });
    expect(acceptInbound(frame(alice, alice, edge), context()).ok).toBe(true);
  });

  test("drops a replay of the same message", () => {
    const ctx = context();
    const f = frame(alice, alice, inner(alice));
    expect(acceptInbound(f, ctx).ok).toBe(true);
    expect(acceptInbound(f, ctx)).toEqual({ ok: false, reason: "replay" });
  });

  test("a future-dated message can't be replayed at the end of its window", () => {
    const ctx = context();
    const f = frame(alice, alice, inner(alice, { ts: NOW + MAX_SKEW_MS }));
    expect(acceptInbound(f, ctx).ok).toBe(true);
    // Last moment the ts check still passes: NOW + 2 × MAX_SKEW_MS.
    expect(acceptInbound(f, { ...ctx, now: NOW + 2 * MAX_SKEW_MS })).toEqual({
      ok: false,
      reason: "replay",
    });
  });

  test("rejected frames never reach the replay guard", () => {
    const ctx = context();
    const stranger = generateIdentity("stranger");

    const unknownSender = frame(stranger, stranger, inner(stranger));
    expect(acceptInbound(unknownSender, ctx)).toEqual({ ok: false, reason: "unknown_sender" });

    const wrongKey = frame(bob, alice, inner(bob));
    expect(acceptInbound(wrongKey, ctx)).toEqual({ ok: false, reason: "undecryptable" });

    const validFrame = frame(alice, alice, inner(alice));
    const corrupted = {
      ...validFrame,
      ciphertext: (validFrame.ciphertext[0] === "A" ? "B" : "A") + validFrame.ciphertext.slice(1),
    };
    expect(acceptInbound(corrupted, ctx)).toEqual({ ok: false, reason: "undecryptable" });

    const senderMismatch = frame(alice, alice, inner(alice, { from: peerId(bob.signPub) }));
    expect(acceptInbound(senderMismatch, ctx)).toEqual({ ok: false, reason: "sender_mismatch" });

    const recipientMismatch = frame(alice, alice, inner(alice, { to: peerId(bob.signPub) }));
    expect(acceptInbound(recipientMismatch, ctx)).toEqual({ ok: false, reason: "recipient_mismatch" });

    const stale = frame(alice, alice, inner(alice, { ts: NOW - MAX_SKEW_MS - 1 }));
    expect(acceptInbound(stale, ctx)).toEqual({ ok: false, reason: "stale" });

    expect(ctx.replay.size).toBe(0);
  });

  test("replay IDs are scoped per sender", () => {
    const ctx = context();
    const id = newMessageId();
    const aliceMsg = inner(alice, { id });
    const bobMsg = inner(bob, { id });
    expect(acceptInbound(frame(alice, alice, aliceMsg), ctx).ok).toBe(true);
    expect(acceptInbound(frame(bob, bob, bobMsg), ctx).ok).toBe(true);
  });
});
