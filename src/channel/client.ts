import nacl from "tweetnacl";
import WebSocket from "ws";
import { MAX_PAYLOAD_BYTES } from "../hub/server.js";
import { signChallenge, signHello } from "../protocol/auth.js";
import { fromB64u, toB64u } from "../protocol/encoding.js";
import type { Sealed } from "../protocol/envelope.js";
import { type AuthFrame, type ErrorCode, type HelloFrame, type HubFrame, parseHubFrame } from "../protocol/frames.js";
import { type Identity, peerId } from "../protocol/identity.js";
import type { InboundFrame } from "../protocol/receive.js";
import { SUPERSEDED_CODE } from "../hub/router.js";

export function helloFor(self: Identity, hubId: Uint8Array, ts: number): HelloFrame {
  const nonce = nacl.randomBytes(32);
  return { type: "hello", signPub: peerId(self.signPub), ts, nonce: toB64u(nonce), sig: toB64u(signHello(self, hubId, ts, nonce)) };
}

export function authFor(self: Identity, hubId: Uint8Array, challenge: string): AuthFrame {
  return { type: "auth", sig: toB64u(signChallenge(self, hubId, fromB64u(challenge, 32))) };
}

// 2 ** attempt overflows to Infinity past attempt 1023, and min * Infinity is
// NaN when min is 0 - capping the exponent keeps the multiply finite regardless
// of how many attempts have accumulated.
const MAX_BACKOFF_EXPONENT = 30;

// Doubles per failed attempt up to max. Jitter in the upper half keeps two
// relays that lost the hub at the same moment from reconnecting in lockstep.
export function backoffDelay(attempt: number, min: number, max: number, random: number): number {
  const exponent = Math.min(Math.max(attempt, 0), MAX_BACKOFF_EXPONENT);
  const base = Math.min(max, min * 2 ** exponent);
  return base / 2 + random * (base / 2);
}

export type HubState = "connecting" | "ready" | "superseded" | "closed";

// "sent" means the hub accepted the frame and handed it to the recipient's
// socket. The client doesn't authenticate the hub (the hub authenticates us),
// so it is not proof of delivery.
export type SendResult = { ok: true } | { ok: false; error: ErrorCode | "hub disconnected" | "timeout" | "superseded" | "not connected" };

export interface HubClientOptions {
  url: string;
  hubId: Uint8Array;
  identity: Identity;
  onMessage: (frame: InboundFrame) => void;
  log: (line: string) => void;
  now?: () => number;
  ackTimeoutMs?: number;
  // The hub pings every 30 s; three missed pings plus slack means it's gone.
  keepaliveMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  random?: () => number;
}

interface Pending {
  resolve: (r: SendResult) => void;
  timer: NodeJS.Timeout;
}

export class HubClient {
  private ws: WebSocket | undefined;
  private stateValue: HubState = "connecting";
  private readonly pending = new Map<string, Pending>();
  private nextRef = 0;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private keepaliveTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private started = false;
  private readonly now: () => number;

  constructor(private readonly opts: HubClientOptions) {
    this.now = opts.now ?? Date.now;
  }

  get state(): HubState {
    return this.stateValue;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.stateValue = "closed";
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.keepaliveTimer);
    this.failPending("hub disconnected");
    this.ws?.terminate();
  }

  send(to: string, sealed: Sealed): Promise<SendResult> {
    if (this.stateValue === "superseded") return Promise.resolve({ ok: false, error: "superseded" });
    const ws = this.ws;
    if (this.stateValue !== "ready" || !ws) return Promise.resolve({ ok: false, error: "not connected" });
    const ref = `s${this.nextRef++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(ref);
        resolve({ ok: false, error: "timeout" });
      }, this.opts.ackTimeoutMs ?? 10_000);
      this.pending.set(ref, { resolve, timer });
      ws.send(JSON.stringify({ type: "msg", ref, to, ciphertext: sealed.ciphertext, nonce: sealed.nonce }));
    });
  }

  private failPending(error: "hub disconnected" | "superseded"): void {
    for (const [ref, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error });
      this.pending.delete(ref);
    }
  }

  private armKeepalive(ws: WebSocket): void {
    clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = setTimeout(() => {
      this.opts.log("cc-relay: no ping from the hub; reconnecting");
      ws.terminate();
    }, this.opts.keepaliveMs ?? 75_000);
  }

  private connect(): void {
    if (this.stopped) return;
    this.stateValue = "connecting";
    const ws = new WebSocket(this.opts.url, { maxPayload: MAX_PAYLOAD_BYTES, handshakeTimeout: 10_000 });
    this.ws = ws;
    let phase: "hello" | "auth" | "ready" = "hello";

    // Anything unexpected from the hub ends this connection; the reconnect
    // loop starts clean. Never try to interpret a frame out of order.
    const bail = (why: string) => {
      this.opts.log(`cc-relay: ${why}; dropping the hub connection`);
      ws.terminate();
    };

    // A socket this connect() replaced (e.g. after a second start() call, before
    // the started guard existed, or any future path that outlives its ws) must
    // not go on mutating state for a session that has already moved to a newer
    // socket.
    ws.on("open", () => {
      if (this.ws !== ws) return;
      // Doubles as the handshake timer: a hub that pings without ever
      // finishing the handshake must not keep re-arming this below.
      this.armKeepalive(ws);
      ws.send(JSON.stringify(helloFor(this.opts.identity, this.opts.hubId, this.now())));
    });
    ws.on("ping", () => {
      if (this.ws !== ws) return;
      if (phase === "ready") this.armKeepalive(ws);
    });
    ws.on("error", (err) => {
      if (this.ws !== ws) return;
      this.opts.log(`cc-relay: hub connection error: ${err.message}`);
    });
    ws.on("message", (data, isBinary) => {
      if (this.ws !== ws) return;
      try {
        if (isBinary) return bail("binary frame from hub");
        const frame: HubFrame | null = parseHubFrame(data.toString("utf8"));
        if (!frame) return bail("malformed frame from hub");
        if (phase === "hello") {
          if (frame.type !== "challenge") return bail(`expected challenge, got ${frame.type}`);
          phase = "auth";
          return ws.send(JSON.stringify(authFor(this.opts.identity, this.opts.hubId, frame.nonce)));
        }
        if (phase === "auth") {
          if (frame.type !== "ready") return bail(`expected ready, got ${frame.type}`);
          phase = "ready";
          this.attempt = 0;
          this.stateValue = "ready";
          this.opts.log("cc-relay: connected to hub");
          return;
        }
        switch (frame.type) {
          case "msg":
            return this.opts.onMessage({ from: frame.from, ciphertext: frame.ciphertext, nonce: frame.nonce });
          case "ack":
          case "error": {
            const p = this.pending.get(frame.ref);
            if (!p) return;
            this.pending.delete(frame.ref);
            clearTimeout(p.timer);
            return p.resolve(frame.type === "ack" ? { ok: true } : { ok: false, error: frame.code });
          }
          default:
            return bail(`unexpected ${frame.type} after ready`);
        }
      } catch (err) {
        // onMessage and log are caller-supplied and can throw arbitrary app code;
        // an uncaught throw here kills the whole channel process, so it's caught
        // and logged by name only - never the raw frame, which may carry ciphertext.
        const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        try {
          this.opts.log(`cc-relay: onMessage threw while handling a frame from the hub: ${detail}`);
        } catch {
          // log is untrusted too; swallow rather than risk a second throw.
        }
      }
    });
    ws.on("close", (code) => {
      if (this.ws !== ws) return;
      clearTimeout(this.keepaliveTimer);
      if (this.stopped) {
        this.failPending("hub disconnected");
        return;
      }
      // Another session with the same identity took over. Reconnecting would
      // just knock that one off in turn, forever.
      if (code === SUPERSEDED_CODE) {
        this.failPending("superseded");
        this.stateValue = "superseded";
        this.opts.log("cc-relay: another session with this identity connected; this one stops sending");
        return;
      }
      this.failPending("hub disconnected");
      this.stateValue = "connecting";
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    const min = this.opts.backoffMinMs ?? 500;
    const max = this.opts.backoffMaxMs ?? 30_000;
    const delay = backoffDelay(this.attempt++, min, max, (this.opts.random ?? Math.random)());
    this.opts.log(`cc-relay: hub connection lost; retrying in ${Math.round(delay)}ms`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
