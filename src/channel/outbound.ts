import { EnvelopeError, type Inner, MAX_TEXT_BYTES, newMessageId, type Sealed, seal } from "../protocol/envelope.js";
import { type Identity, peerId } from "../protocol/identity.js";
import type { Peer } from "../protocol/receive.js";

export type Outbound = { ok: true; sealed: Sealed; id: string } | { ok: false; error: string };

export function buildInner(self: Identity, to: Peer, text: string, now: number): Inner {
  return { v: 1, id: newMessageId(), ts: now, from: peerId(self.signPub), to: to.id, text };
}

// Only "too large" is the caller's fault and worth telling Claude about; any
// other EnvelopeError is our own wiring and must throw.
export function sealFor(self: Identity, to: Peer, text: string, now: number): Outbound {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_TEXT_BYTES) return { ok: false, error: `too large: ${bytes} bytes (max ${MAX_TEXT_BYTES})` };
  const inner = buildInner(self, to, text, now);
  try {
    return { ok: true, sealed: seal(inner, to.boxPub, self.boxSec), id: inner.id };
  } catch (err) {
    if (err instanceof EnvelopeError && err.code === "too_large") return { ok: false, error: "too large" };
    throw err;
  }
}
