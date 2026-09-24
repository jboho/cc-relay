import type { ErrorCode, HubFrame, SendFrame } from "../protocol/frames.js";

export interface Conn {
  id: string;
  send(frame: HubFrame): void;
  close(code: number, reason: string): void;
}

export const SUPERSEDED_CODE = 4001;
export const RATE_LIMIT_PER_MIN = 30;
const WINDOW_MS = 60_000;

export class Router {
  private readonly conns = new Map<string, Conn>();
  // Keyed by peer ID, not by connection: a per-connection budget would reset
  // every time a peer reconnects. Only allowlisted IDs ever authenticate, so
  // this map is bounded by the allowlist.
  private readonly sendTimes = new Map<string, number[]>();

  constructor(
    private readonly allow: ReadonlySet<string>,
    private readonly now: () => number,
  ) {}

  attach(conn: Conn): void {
    const existing = this.conns.get(conn.id);
    this.conns.set(conn.id, conn);
    if (existing && existing !== conn) existing.close(SUPERSEDED_CODE, "superseded");
  }

  // Only removes the entry if it's still this connection: a superseded
  // connection closing late must not unregister its replacement.
  detach(conn: Conn): void {
    if (this.conns.get(conn.id) === conn) this.conns.delete(conn.id);
  }

  isConnected(id: string): boolean {
    return this.conns.has(id);
  }

  route(from: Conn, frame: SendFrame): void {
    const error = (code: ErrorCode) => from.send({ type: "error", ref: frame.ref, code });
    if (!this.allowSend(from)) return error("rate_limited");
    if (!this.allow.has(frame.to)) return error("unknown_peer");
    const target = this.conns.get(frame.to);
    if (!target) return error("offline");
    // Built field by field: `from` is always the authenticated ID, and nothing
    // else the client sent is forwarded.
    target.send({ type: "msg", from: from.id, ciphertext: frame.ciphertext, nonce: frame.nonce });
    from.send({ type: "ack", ref: frame.ref });
  }

  // Same reasoning as Handshake.clock() and acceptInbound: a NaN/Infinity
  // clock makes `now - t < WINDOW_MS` false, pruning every entry and
  // disabling the limit. A broken clock is a local wiring bug; throw.
  private clock(): number {
    const now = this.now();
    if (!Number.isFinite(now)) throw new RangeError("Router: now() must return a finite clock value");
    return now;
  }

  private allowSend(conn: Conn): boolean {
    const now = this.clock();
    const recent = (this.sendTimes.get(conn.id) ?? []).filter((t) => now - t < WINDOW_MS);
    this.sendTimes.set(conn.id, recent);
    if (recent.length >= RATE_LIMIT_PER_MIN) return false;
    recent.push(now);
    return true;
  }
}
