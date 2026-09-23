import nacl from "tweetnacl";
import WebSocket from "ws";
import { signChallenge, signHello } from "../../src/protocol/auth.js";
import { fromB64u, toB64u } from "../../src/protocol/encoding.js";
import type { HelloFrame, HubFrame } from "../../src/protocol/frames.js";
import { type Identity, peerId } from "../../src/protocol/identity.js";
import type { AllowedPeer } from "../../src/hub/handshake.js";
import { generatePath } from "../../src/hub/port.js";
import { type HubOptions, type RunningHub, startHub } from "../../src/hub/server.js";

export interface TestHub extends RunningHub {
  path: string;
  hubId: Uint8Array;
  url: string;
}

export function allowFor(...ids: Identity[]): Map<string, AllowedPeer> {
  return new Map(ids.map((i) => [peerId(i.signPub), { id: peerId(i.signPub), signPub: i.signPub }]));
}

export async function startTestHub(
  host: Identity,
  peers: Identity[],
  overrides: Partial<HubOptions> = {},
): Promise<TestHub> {
  const path = overrides.path ?? generatePath();
  const hub = await startHub({
    mode: "loopback",
    host: "127.0.0.1",
    path,
    hubId: host.signPub,
    allow: allowFor(...peers),
    ...overrides,
  });
  return { ...hub, path, hubId: host.signPub, url: `ws://127.0.0.1:${hub.port}/${path}` };
}

// A raw client that records everything it sees, for asserting on silence.
export class Probe {
  readonly ws: WebSocket;
  readonly frames: HubFrame[] = [];
  readonly raw: string[] = [];
  opened = false;
  pings = 0;
  private cursor = 0;
  readonly closed: Promise<number>;
  private waiters: (() => void)[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("open", () => (this.opened = true));
    this.ws.on("ping", () => this.pings++);
    this.ws.on("error", () => {});
    this.ws.on("message", (data) => {
      const text = data.toString();
      this.raw.push(text);
      this.frames.push(JSON.parse(text) as HubFrame);
      for (const w of this.waiters.splice(0)) w();
    });
    this.closed = new Promise((resolve) => this.ws.on("close", (code) => resolve(code)));
  }

  open(): Promise<void> {
    if (this.opened) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("close", () => reject(new Error("closed before open")));
    });
  }

  send(frame: unknown): void {
    this.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  // Returns frames in arrival order, each exactly once.
  async next(): Promise<HubFrame> {
    const index = this.cursor++;
    while (this.frames.length <= index) {
      await Promise.race([
        new Promise<void>((resolve) => this.waiters.push(resolve)),
        this.closed.then(() => {
          throw new Error("closed while waiting for a frame");
        }),
      ]);
    }
    return this.frames[index]!;
  }
}

export function helloFrame(who: Identity, hubId: Uint8Array, ts = Date.now()): HelloFrame {
  const nonce = nacl.randomBytes(32);
  return {
    type: "hello",
    signPub: peerId(who.signPub),
    ts,
    nonce: toB64u(nonce),
    sig: toB64u(signHello(who, hubId, ts, nonce)),
  };
}

export function authFrame(who: Identity, hubId: Uint8Array, challenge: string) {
  return { type: "auth", sig: toB64u(signChallenge(who, hubId, fromB64u(challenge))) };
}

export async function connectAuthed(hub: TestHub, who: Identity): Promise<Probe> {
  const probe = new Probe(hub.url);
  await probe.open();
  probe.send(helloFrame(who, hub.hubId));
  const challenge = await probe.next();
  if (challenge.type !== "challenge") throw new Error(`expected challenge, got ${challenge.type}`);
  probe.send(authFrame(who, hub.hubId, challenge.nonce));
  const ready = await probe.next();
  if (ready.type !== "ready") throw new Error(`expected ready, got ${ready.type}`);
  return probe;
}

export function sendFrame(to: Identity, ref = "r1") {
  return {
    type: "msg",
    ref,
    to: peerId(to.signPub),
    ciphertext: toB64u(nacl.randomBytes(48)),
    nonce: toB64u(nacl.randomBytes(24)),
  };
}
