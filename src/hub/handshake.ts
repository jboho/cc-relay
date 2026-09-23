import { NONCE_BYTES, verifyChallenge, verifyHello } from "../protocol/auth.js";
import { fromB64u, toB64u } from "../protocol/encoding.js";
import type { AuthFrame, HelloFrame } from "../protocol/frames.js";
import type { ReplayGuard } from "../protocol/replay.js";
import type { HubMode } from "./bind.js";
import type { Whois } from "./whois.js";

export interface AllowedPeer {
  id: string;
  signPub: Uint8Array;
  // Required in tailscale mode: the Tailscale login expected for this key.
  tailscaleLogin?: string;
}

export interface HandshakeDeps {
  mode: HubMode;
  hubId: Uint8Array;
  allow: ReadonlyMap<string, AllowedPeer>;
  helloNonces: ReplayGuard;
  now: () => number;
  randomBytes: (n: number) => Uint8Array;
  whois?: Whois;
  remote: { address: string; port: number };
}

export const HELLO_SKEW_MS = 60_000;
// Same reasoning as SEEN_TTL_MS in receive.ts: a hello stays valid for up to
// 2 × HELLO_SKEW_MS after it's first seen.
export const HELLO_NONCE_TTL_MS = 2 * HELLO_SKEW_MS + 1000;

type State = "hello" | "checking" | "challenge" | "done" | "failed";

// Pure handshake logic, one instance per connection. Any failure moves to
// "failed" for good; the server drops the socket without replying.
export class Handshake {
  private state: State = "hello";
  private peer: AllowedPeer | undefined;
  private challenge: Uint8Array | undefined;

  constructor(private readonly deps: HandshakeDeps) {}

  async onHello(frame: HelloFrame): Promise<{ type: "challenge"; nonce: string } | null> {
    if (this.state !== "hello") return this.fail();
    this.state = "checking";
    const { deps } = this;

    const peer = deps.allow.get(frame.signPub);
    if (!peer) return this.fail();
    let nonce: Uint8Array;
    let sig: Uint8Array;
    try {
      nonce = fromB64u(frame.nonce, NONCE_BYTES);
      sig = fromB64u(frame.sig, 64);
    } catch {
      return this.fail();
    }
    if (!verifyHello(peer.signPub, deps.hubId, frame.ts, nonce, sig)) return this.fail();
    if (Math.abs(deps.now() - frame.ts) > HELLO_SKEW_MS) return this.fail();

    if (deps.mode === "tailscale") {
      if (!deps.whois || !peer.tailscaleLogin) return this.fail();
      const login = await deps.whois.loginFor(deps.remote.address, deps.remote.port);
      if (this.state !== "checking") return null;
      if (login !== peer.tailscaleLogin) return this.fail();
    }

    // Recorded last, so only fully valid hellos occupy the cache.
    if (!deps.helloNonces.checkAndRemember(`${peer.id}:${frame.nonce}`, deps.now())) return this.fail();

    this.peer = peer;
    this.challenge = deps.randomBytes(NONCE_BYTES);
    this.state = "challenge";
    return { type: "challenge", nonce: toB64u(this.challenge) };
  }

  // Returns the authenticated peer ID, or null. The challenge is cleared either
  // way, so it can be answered at most once.
  onAuth(frame: AuthFrame): string | null {
    if (this.state !== "challenge" || !this.peer || !this.challenge) return this.fail();
    const challenge = this.challenge;
    this.challenge = undefined;
    let sig: Uint8Array;
    try {
      sig = fromB64u(frame.sig, 64);
    } catch {
      return this.fail();
    }
    if (!verifyChallenge(this.peer.signPub, this.deps.hubId, challenge, sig)) return this.fail();
    this.state = "done";
    return this.peer.id;
  }

  fail(): null {
    this.state = "failed";
    this.peer = undefined;
    this.challenge = undefined;
    return null;
  }
}
