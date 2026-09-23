import { open, type Inner, type Sealed } from "./envelope.js";
import type { ReplayGuard } from "./replay.js";

export interface Peer {
  id: string;
  alias: string;
  signPub: Uint8Array;
  boxPub: Uint8Array;
}

export interface InboundFrame extends Sealed {
  // Stamped by the hub from the authenticated sign key; never client-supplied.
  from: string;
}

export type Rejection =
  | "unknown_sender"
  | "undecryptable"
  | "sender_mismatch"
  | "recipient_mismatch"
  | "stale"
  | "replay";

export type Acceptance = { ok: true; peer: Peer; message: Inner } | { ok: false; reason: Rejection };

export interface ReceiveContext {
  selfId: string;
  selfBoxSec: Uint8Array;
  peers: ReadonlyMap<string, Peer>;
  replay: ReplayGuard;
  now: number;
}

export const MAX_SKEW_MS = 5 * 60_000;
// A message stays acceptable for up to 2 × MAX_SKEW_MS after it's first seen
// (ts up to 5 min ahead, accepted until 5 min after ts), so remembered IDs must
// outlive that window. The extra second covers the boundary tick.
export const SEEN_TTL_MS = 2 * MAX_SKEW_MS + 1000;

export function acceptInbound(frame: InboundFrame, ctx: ReceiveContext): Acceptance {
  const peer = ctx.peers.get(frame.from);
  if (!peer) return { ok: false, reason: "unknown_sender" };

  // Open only with the box key bound to the hub-authenticated sender. Never
  // try other peers' keys to see which one works.
  const message = open(frame, peer.boxPub, ctx.selfBoxSec);
  if (!message) return { ok: false, reason: "undecryptable" };

  if (message.from !== frame.from) return { ok: false, reason: "sender_mismatch" };
  if (message.to !== ctx.selfId) return { ok: false, reason: "recipient_mismatch" };
  if (Math.abs(ctx.now - message.ts) > MAX_SKEW_MS) return { ok: false, reason: "stale" };
  if (!ctx.replay.checkAndRemember(`${frame.from}:${message.id}`, ctx.now)) {
    return { ok: false, reason: "replay" };
  }
  return { ok: true, peer, message };
}
