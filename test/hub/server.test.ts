import { request } from "node:http";
import { connect as netConnect, createServer as createNetServer, type Socket } from "node:net";
import nacl from "tweetnacl";
import WebSocket from "ws";
import { afterEach, describe, expect, test, vi } from "vitest";
import { toB64u } from "../../src/protocol/encoding.js";
import { generateIdentity, peerId } from "../../src/protocol/identity.js";
import { BindError } from "../../src/hub/bind.js";
import { MAX_PAYLOAD_BYTES, startHub } from "../../src/hub/server.js";
import {
  authFrame,
  connectAuthed,
  helloFrame,
  Probe,
  sendFrame,
  startTestHub,
  type TestHub,
} from "./helpers.js";

const RAW_404 = "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

// Builds a raw HTTP Upgrade request. `key` defaults to a valid
// Sec-WebSocket-Key so callers only need to override it to force ws's own
// handshake validation to reject the request.
function rawUpgradeRequest(pathname: string, key = "dGhlIHNhbXBsZSBub25jZQ=="): string {
  return (
    `GET /${pathname} HTTP/1.1\r\n` +
    `Host: 127.0.0.1\r\n` +
    `Upgrade: websocket\r\n` +
    `Connection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\n` +
    `Sec-WebSocket-Version: 13\r\n` +
    `\r\n`
  );
}

function rawGetRequest(pathname: string): string {
  return `GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`;
}

// Sends a raw request over its own socket and collects every byte of the
// response until the server closes the connection.
function rawBytes(port: number, req: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = netConnect({ host: "127.0.0.1", port }, () => sock.write(req));
    let data = "";
    sock.on("data", (chunk: Buffer) => (data += chunk.toString("latin1")));
    sock.on("close", () => resolve(data));
    sock.on("error", reject);
  });
}

// A single-frame WebSocket encoder, only as much as these protocol-error
// tests need: small payloads, one frame, FIN always set.
function encodeFrame(opcode: number, payload: Buffer, masked: boolean): Buffer {
  if (payload.length >= 126) throw new Error("encodeFrame: payload too large for this helper");
  const b0 = 0x80 | (opcode & 0x0f);
  const b1 = (masked ? 0x80 : 0x00) | payload.length;
  if (!masked) return Buffer.concat([Buffer.from([b0, b1]), payload]);
  const mask = Buffer.from(nacl.randomBytes(4));
  const maskedPayload = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) maskedPayload[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([Buffer.from([b0, b1]), mask, maskedPayload]);
}

// Opens a raw socket and drives the WebSocket handshake by hand, so the
// caller can then write frames ws's own client would refuse to construct.
async function manualHandshake(port: number, pathname: string): Promise<Socket> {
  const sock = netConnect({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  const key = Buffer.from(nacl.randomBytes(16)).toString("base64");
  sock.write(rawUpgradeRequest(pathname, key));
  await new Promise<void>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      if (!buf.includes("\r\n\r\n")) return;
      sock.off("data", onData);
      if (buf.startsWith("HTTP/1.1 101")) resolve();
      else reject(new Error(`manualHandshake: unexpected response: ${buf}`));
    };
    sock.on("data", onData);
    sock.on("error", reject);
  });
  return sock;
}

// Reads a single close frame's code off a socket that already completed the
// WebSocket handshake. Small-payload, single-frame only, matching encodeFrame.
function readCloseCode(sock: Socket): Promise<number> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 2) return;
      if ((buf[0]! & 0x0f) !== 0x8) return;
      const len = buf[1]! & 0x7f;
      if (buf.length < 2 + len) return;
      resolve(len >= 2 ? buf.readUInt16BE(2) : 1005);
    });
    sock.once("close", () => resolve(1006));
  });
}

// Swaps out any existing listeners for `event` on process, runs `fn`, and
// restores them afterward, returning whatever `fn` captured. Mirrors the
// pattern the handler-throw test below uses for unhandledRejection.
async function withCapturedProcessEvent(
  event: "uncaughtException" | "unhandledRejection",
  fn: () => Promise<void>,
): Promise<unknown[]> {
  // process.on's overloads key off a literal event name; this helper's job is
  // to be generic across the two, so route through `any` here rather than
  // fighting overload resolution — the runtime behavior is identical either
  // way.
  const proc = process as unknown as {
    listeners(e: string): ((...a: unknown[]) => void)[];
    removeAllListeners(e: string): void;
    on(e: string, l: (...a: unknown[]) => void): void;
  };
  const saved = proc.listeners(event);
  proc.removeAllListeners(event);
  const captured: unknown[] = [];
  proc.on(event, (err: unknown) => captured.push(err));
  try {
    await fn();
    return captured;
  } finally {
    proc.removeAllListeners(event);
    for (const l of saved) proc.on(event, l);
  }
}

const host = generateIdentity("host");
const alice = generateIdentity("alice");
const bob = generateIdentity("bob");
const mallory = generateIdentity("mallory");

const hubs: TestHub[] = [];
const probes: Probe[] = [];
afterEach(async () => {
  for (const p of probes.splice(0)) p.ws.terminate();
  for (const h of hubs.splice(0)) await h.close();
});

async function hub(overrides = {}) {
  const h = await startTestHub(host, [alice, bob], overrides);
  hubs.push(h);
  return h;
}
function probe(url: string, options?: ConstructorParameters<typeof Probe>[1]) {
  const p = new Probe(url, options);
  probes.push(p);
  return p;
}
async function authed(h: TestHub, who = alice) {
  const p = await connectAuthed(h, who);
  probes.push(p);
  return p;
}

async function expectSilentDrop(p: Probe) {
  expect(await p.closed).toBe(1006);
  expect(p.raw).toEqual([]);
}

function httpGet(port: number, path: string) {
  return new Promise<{ status: number; headers: Record<string, unknown> }>((resolve, reject) => {
    request({ host: "127.0.0.1", port, path }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, headers: res.headers });
    })
      .on("error", reject)
      .end();
  });
}

describe("hub: bind", () => {
  test("refuses a wildcard or out-of-mode address", async () => {
    const base = { path: "p", hubId: host.signPub, allow: new Map() };
    await expect(startHub({ ...base, mode: "loopback", host: "0.0.0.0" })).rejects.toThrow(BindError);
    await expect(startHub({ ...base, mode: "lan", host: "127.0.0.1" })).rejects.toThrow(BindError);
  });

  test("picks a port in 20000–32767 when none is given", async () => {
    const h = await hub();
    expect(h.port).toBeGreaterThanOrEqual(20000);
    expect(h.port).toBeLessThanOrEqual(32767);
  });
});

describe("hub: looks like nothing", () => {
  test("plain GET on any path is a bare 404 with no Server or Date header", async () => {
    const h = await hub();
    for (const path of ["/", `/${h.path}`, "/favicon.ico"]) {
      const res = await httpGet(h.port, path);
      expect(res.status).toBe(404);
      expect(res.headers.server).toBeUndefined();
      expect(res.headers.date).toBeUndefined();
      expect(res.headers.connection).toBe("close");
    }
  });

  test("an upgrade on the wrong path gets 404 and never opens", async () => {
    const h = await hub();
    const p = probe(`ws://127.0.0.1:${h.port}/wrong`);
    const status = await new Promise<number>((resolve) =>
      p.ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)),
    );
    expect(status).toBe(404);
    expect(p.opened).toBe(false);
  });
});

describe("hub: silent gate (1006, zero bytes)", () => {
  test("an unpaired key", async () => {
    const h = await hub();
    const p = probe(h.url);
    await p.open();
    p.send(helloFrame(mallory, h.hubId));
    await expectSilentDrop(p);
  });

  test("a bad signature", async () => {
    const h = await hub();
    const p = probe(h.url);
    await p.open();
    p.send({ ...helloFrame(mallory, h.hubId), signPub: peerId(alice.signPub) });
    await expectSilentDrop(p);
  });

  test("a stale timestamp", async () => {
    const h = await hub();
    const p = probe(h.url);
    await p.open();
    p.send(helloFrame(alice, h.hubId, Date.now() - 10 * 60_000));
    await expectSilentDrop(p);
  });

  test("a reused hello nonce", async () => {
    const h = await hub();
    const recorded = helloFrame(alice, h.hubId);
    const first = probe(h.url);
    await first.open();
    first.send(recorded);
    expect((await first.next()).type).toBe("challenge");
    const second = probe(h.url);
    await second.open();
    second.send(recorded);
    await expectSilentDrop(second);
  });

  test("a message before auth", async () => {
    const h = await hub();
    const p = probe(h.url);
    await p.open();
    p.send(sendFrame(bob));
    await expectSilentDrop(p);
  });

  test("malformed JSON, extra keys, or a binary frame", async () => {
    const h = await hub();
    for (const bad of ["not json", { ...helloFrame(alice, h.hubId), extra: 1 }, Buffer.from("x")]) {
      const p = probe(h.url);
      await p.open();
      if (Buffer.isBuffer(bad)) p.ws.send(bad);
      else p.send(bad);
      await expectSilentDrop(p);
    }
  });

  test("a frame sent before the challenge arrives", async () => {
    const h = await hub();
    const p = probe(h.url);
    await p.open();
    p.send(helloFrame(alice, h.hubId));
    p.send({ type: "auth", sig: "A".repeat(86) });
    expect(await p.closed).toBe(1006);
  });

  test("no hello within the auth timeout", async () => {
    const h = await hub({ authTimeoutMs: 100 });
    const p = probe(h.url);
    await p.open();
    await expectSilentDrop(p);
  });

  test("a wrong-key challenge answer", async () => {
    const h = await hub();
    const p = probe(h.url);
    await p.open();
    p.send(helloFrame(alice, h.hubId));
    const challenge = await p.next();
    if (challenge.type !== "challenge") throw new Error("expected challenge");
    p.send(authFrame(mallory, h.hubId, challenge.nonce));
    expect(await p.closed).toBe(1006);
    expect(p.frames.map((f) => f.type)).toEqual(["challenge"]);
  });
});

describe("hub: challenge", () => {
  test("an answer captured on one connection is refused on another", async () => {
    const h = await hub();
    const first = probe(h.url);
    await first.open();
    first.send(helloFrame(alice, h.hubId));
    const c1 = await first.next();
    if (c1.type !== "challenge") throw new Error("expected challenge");
    const captured = authFrame(alice, h.hubId, c1.nonce);

    const second = probe(h.url);
    await second.open();
    second.send(helloFrame(alice, h.hubId));
    await second.next();
    second.send(captured);
    expect(await second.closed).toBe(1006);
  });

  test("answering twice on one connection is refused", async () => {
    const h = await hub();
    const p = probe(h.url);
    await p.open();
    p.send(helloFrame(alice, h.hubId));
    const c = await p.next();
    if (c.type !== "challenge") throw new Error("expected challenge");
    const answer = authFrame(alice, h.hubId, c.nonce);
    p.send(answer);
    expect((await p.next()).type).toBe("ready");
    p.send(answer);
    expect(await p.closed).toBe(1006);
  });

  test("challenges are unique across 20 connections", async () => {
    const h = await hub({ maxPending: 20 });
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const p = probe(h.url);
      await p.open();
      p.send(helloFrame(alice, h.hubId));
      const c = await p.next();
      if (c.type !== "challenge") throw new Error("expected challenge");
      seen.add(c.nonce);
      p.ws.terminate();
    }
    expect(seen.size).toBe(20);
  });

  test("a hello replayed after a hub restart gets a challenge but can't answer it", async () => {
    const path = "fixed-path-for-restart";
    const hub1 = await hub({ path });
    const recorded = helloFrame(alice, hub1.hubId);
    const legit = probe(hub1.url);
    await legit.open();
    legit.send(recorded);
    const c1 = await legit.next();
    if (c1.type !== "challenge") throw new Error("expected challenge");
    const recordedAuth = authFrame(alice, hub1.hubId, c1.nonce);
    legit.send(recordedAuth);
    expect((await legit.next()).type).toBe("ready");
    await hub1.close();
    hubs.splice(hubs.indexOf(hub1), 1);

    const hub2 = await hub({ path });
    const attacker = probe(hub2.url);
    await attacker.open();
    attacker.send(recorded);
    expect((await attacker.next()).type).toBe("challenge");
    attacker.send(recordedAuth);
    expect(await attacker.closed).toBe(1006);
  });
});

describe("hub: limits", () => {
  test("a ninth pending connection never opens; a freed slot admits the next", async () => {
    const h = await hub({ authTimeoutMs: 10_000 });
    const pending: Probe[] = [];
    for (let i = 0; i < 8; i++) {
      const p = probe(h.url);
      await p.open();
      pending.push(p);
    }
    const ninth = probe(h.url);
    await ninth.closed;
    expect(ninth.opened).toBe(false);

    pending[0]!.ws.terminate();
    await pending[0]!.closed;
    // The client sees its own close before the hub's own 'close' handler
    // (on a different socket) has necessarily run and freed the slot, so
    // poll for it instead of guessing a fixed delay.
    const deadline = Date.now() + 2000;
    let tenth: Probe | undefined;
    while (!tenth && Date.now() < deadline) {
      const candidate = probe(h.url);
      try {
        await candidate.open();
        tenth = candidate;
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    expect(tenth?.opened).toBe(true);
  });

  test("authenticated connections don't count against the pending cap", async () => {
    const h = await hub({ maxPending: 1 });
    await authed(h, alice);
    await authed(h, bob);
  });

  // 1009 is the one non-silent close OUR OWN pre-auth validation produces
  // (the size cap). It is not the only non-silent close a pre-auth socket
  // can see: ws itself closes with 1007/1002 for transport-level protocol
  // errors before a frame ever reaches our code — see the ws-layer test
  // below, which pins those separately.
  test("an oversize frame is closed with 1009, our own size-limit rejection", async () => {
    const h = await hub();
    const p = probe(h.url);
    await p.open();
    p.send("x".repeat(129 * 1024));
    expect(await p.closed).toBe(1009);
    expect(p.raw).toEqual([]);
  });

  test("ws-layer protocol errors close with 1007/1002, not our own codes, and before we ever see a frame", async () => {
    const h = await hub();

    // Invalid UTF-8 in a text frame: ws validates this itself and closes
    // with 1007. kill() can't pre-empt it — ws calls close(code) before it
    // ever emits 'error' — so this reveals nothing about our own auth gate.
    const utf8Sock = await manualHandshake(h.port, h.path);
    utf8Sock.write(encodeFrame(0x1, Buffer.from([0xff, 0xfe, 0xfd]), true));
    expect(await readCloseCode(utf8Sock)).toBe(1007);

    // An unmasked client frame is a protocol violation per RFC 6455 5.1;
    // ws closes with 1002, again before our own message handler ever runs.
    const unmaskedSock = await manualHandshake(h.port, h.path);
    unmaskedSock.write(encodeFrame(0x1, Buffer.from("hi"), false));
    expect(await readCloseCode(unmaskedSock)).toBe(1002);
  });

  test("only authenticated connections are pinged", async () => {
    const h = await hub({ pingIntervalMs: 30, authTimeoutMs: 10_000 });
    const pre = probe(h.url);
    await pre.open();
    const post = await authed(h);
    await new Promise((r) => setTimeout(r, 150));
    expect(pre.pings).toBe(0);
    expect(post.pings).toBeGreaterThan(0);
  });
});

describe("hub: routing", () => {
  test("delivers with the authenticated sender ID and acks", async () => {
    const h = await hub();
    const a = await authed(h, alice);
    const b = await authed(h, bob);
    const frame = sendFrame(bob, "m1");
    a.send(frame);
    expect(await b.next()).toEqual({
      type: "msg",
      from: peerId(alice.signPub),
      ciphertext: frame.ciphertext,
      nonce: frame.nonce,
    });
    expect(await a.next()).toEqual({ type: "ack", ref: "m1" });
  });

  test("a client-supplied from is rejected, not forwarded", async () => {
    const h = await hub();
    const a = await authed(h, alice);
    await authed(h, bob);
    a.send({ ...sendFrame(bob), from: peerId(bob.signPub) });
    expect(await a.closed).toBe(1006);
  });

  test("unknown_peer and offline errors", async () => {
    const h = await hub();
    const a = await authed(h, alice);
    a.send(sendFrame(mallory, "r1"));
    expect(await a.next()).toEqual({ type: "error", ref: "r1", code: "unknown_peer" });
    a.send(sendFrame(bob, "r2"));
    expect(await a.next()).toEqual({ type: "error", ref: "r2", code: "offline" });
  });

  test("a second login supersedes the first with 4001, and delivery goes to the new one", async () => {
    const h = await hub();
    const old = await authed(h, alice);
    const fresh = await authed(h, alice);
    expect(await old.closed).toBe(4001);
    const b = await authed(h, bob);
    b.send(sendFrame(alice, "m1"));
    expect((await fresh.next()).type).toBe("msg");
    expect(await b.next()).toEqual({ type: "ack", ref: "m1" });
  });

  test("the 31st message in a minute is rate_limited", async () => {
    const h = await hub();
    const a = await authed(h, alice);
    await authed(h, bob);
    for (let i = 0; i < 31; i++) a.send(sendFrame(bob, `r${i}`));
    for (let i = 0; i < 30; i++) expect(await a.next()).toEqual({ type: "ack", ref: `r${i}` });
    expect(await a.next()).toEqual({ type: "error", ref: "r30", code: "rate_limited" });
  });

  test("post-auth garbage or handshake frames kill the connection", async () => {
    const h = await hub();
    for (const bad of ["garbage", helloFrame(alice, h.hubId)]) {
      const a = await authed(h, alice);
      a.send(bad);
      expect(await a.closed).toBe(1006);
    }
  });

  test("the largest legal frame fits under maxPayload and still delivers", async () => {
    const h = await hub();
    const a = await authed(h, alice);
    const b = await authed(h, bob);
    const frame = {
      type: "msg" as const,
      ref: "r".repeat(64),
      to: peerId(bob.signPub),
      ciphertext: toB64u(nacl.randomBytes(90_000)), // 90000 * 4/3 = 120000 chars, the schema's max
      nonce: toB64u(nacl.randomBytes(24)), // 24 * 4/3 = 32 chars, the schema's exact nonce length
    };
    expect(frame.ciphertext).toHaveLength(120_000);
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(MAX_PAYLOAD_BYTES);
    a.send(frame);
    expect(await b.next()).toEqual({
      type: "msg",
      from: peerId(alice.signPub),
      ciphertext: frame.ciphertext,
      nonce: frame.nonce,
    });
    expect(await a.next()).toEqual({ type: "ack", ref: frame.ref });
  });
});

describe("hub: upgrade abort safety", () => {
  test("an RST right after a wrong-path or over-cap upgrade never crashes the process", async () => {
    const h = await hub({ maxPending: 1, authTimeoutMs: 10_000 });

    const captured = await withCapturedProcessEvent("uncaughtException", async () => {
      // Node strips its own 'error' listener from the socket before emitting
      // 'upgrade'. Our own socket.end(RAW_404)/socket.destroy() branches ran
      // before ws ever attaches its listener, so without our own backstop an
      // RST landing here used to be an uncaught EPIPE/ECONNRESET that took
      // the whole process down — reproduced 200/200 times against this exact
      // ws/Node pair before the fix.
      // Wait for each raw socket's own 'close' before starting the next:
      // otherwise `filler` below can end up opening while some of this
      // loop's connections are still in flight instead of strictly after it,
      // making the "fill the one pending slot" setup below unreliable.
      for (let i = 0; i < 50; i++) {
        await new Promise<void>((resolve) => {
          const sock = netConnect({ host: "127.0.0.1", port: h.port }, () => {
            sock.write(rawUpgradeRequest("wrong"));
            sock.resetAndDestroy();
          });
          sock.on("error", () => {});
          sock.on("close", () => resolve());
        });
      }

      // Fill the single pending slot so the next upgrades take the over-cap
      // socket.destroy() branch instead of the wrong-path one.
      const filler = probe(h.url);
      await filler.open();
      for (let i = 0; i < 20; i++) {
        await new Promise<void>((resolve) => {
          const sock = netConnect({ host: "127.0.0.1", port: h.port }, () => {
            sock.write(rawUpgradeRequest(h.path));
            sock.resetAndDestroy();
          });
          sock.on("error", () => {});
          sock.on("close", () => resolve());
        });
      }

      // Bounded window for any async error event to surface before we check.
      await new Promise((r) => setTimeout(r, 200));

      // Release filler's own pending slot: with maxPending: 1 it's the only
      // one, and it stays open (never authenticates) for the whole block
      // above on purpose, so it must be torn down before anything else can
      // connect.
      filler.ws.terminate();
      await filler.closed;
    });
    expect(captured).toEqual([]);

    // The hub must still be fully usable after all of the above.
    const a = await authed(h, alice);
    const b = await authed(h, bob);
    a.send(sendFrame(bob, "r1"));
    expect(await b.next()).toMatchObject({ type: "msg" });
    expect(await a.next()).toEqual({ type: "ack", ref: "r1" });
  });

  test("aborted handshakes on the correct path release their pending slot instead of locking the hub out", async () => {
    const h = await hub({ maxPending: 2, authTimeoutMs: 10_000 });
    // More than maxPending, sequential and each awaited to completion: if the
    // pending slot leaked (no release on an aborted handshake), the second of
    // these would already saturate the cap forever, and every connection
    // after it — including the legitimate one below — would be destroyed
    // before ws even gets to reject the bad key.
    for (let i = 0; i < 3; i++) {
      await new Promise<void>((resolve, reject) => {
        const sock = netConnect({ host: "127.0.0.1", port: h.port }, () => {
          sock.write(rawUpgradeRequest(h.path, "nope"));
        });
        sock.on("data", () => {});
        sock.on("close", () => resolve());
        sock.on("error", reject);
      });
    }
    const p = await authed(h, alice);
    expect(p.opened).toBe(true);
  });

  test("a half-open peer that never closes doesn't hold its pending slot forever", async () => {
    const h = await hub({ maxPending: 2, authTimeoutMs: 300 });
    // Node's http sockets set allowHalfOpen, so our end() only sends our own
    // FIN; without an explicit destroy, the socket (and the pending release
    // tied to its 'close') waits on the peer's FIN, which a client with
    // allowHalfOpen: true and no auth timer on this path can withhold forever.
    const rawSockets: Socket[] = [];
    try {
      const terminated = await Promise.all(
        Array.from({ length: 2 }, () => {
          return new Promise<void>((resolve) => {
            const sock = netConnect({ host: "127.0.0.1", port: h.port, allowHalfOpen: true }, () => {
              sock.write(rawUpgradeRequest(h.path, "nope"));
            });
            rawSockets.push(sock);
            sock.on("error", () => {});
            // A paused readable stream never emits 'end' until its buffered
            // data (the 404 response) is read out, so this has to drain it —
            // without it the socket sits on unread data forever and neither
            // 'end' nor 'close' fires, independent of the server's own close.
            sock.on("data", () => {});
            // Never end() or destroy() this socket ourselves: the whole point
            // is to see the server close its side without our cooperation.
            sock.once("end", () => resolve());
            sock.once("close", () => resolve());
          });
        }),
      );
      expect(terminated).toHaveLength(2);

      const p = await authed(h, alice);
      expect(p.opened).toBe(true);
    } finally {
      for (const sock of rawSockets) sock.destroy();
    }
  });

  test("pending never goes negative across auth/disconnect cycles, including a superseded login", async () => {
    const h = await hub({ maxPending: 2, authTimeoutMs: 10_000 });
    // release() runs unconditionally in the close handler, even for a
    // connection already released at auth time. Without the idempotency
    // guard, each of these cycles double-decrements pending, drifting it
    // negative and silently loosening the cap below.
    for (let i = 0; i < 3; i++) {
      const p = await authed(h, alice);
      p.ws.terminate();
      await p.closed;
    }
    // A superseded login releases the old connection at its own auth time,
    // then again when router.attach's kick closes it — the same double
    // release, from a different trigger.
    const old = await authed(h, alice);
    const fresh = await authed(h, alice);
    expect(await old.closed).toBe(4001);
    fresh.ws.terminate();
    await fresh.closed;

    // If pending drifted negative above, opening exactly maxPending
    // unauthenticated connections wouldn't be enough to saturate the cap.
    const held: Probe[] = [];
    for (let i = 0; i < 2; i++) {
      const p = probe(h.url);
      await p.open();
      held.push(p);
    }
    const extra = probe(h.url);
    await extra.closed;
    expect(extra.opened).toBe(false);
  });

  test("a bad-key upgrade on the correct path gets the same bare 404, not ws's own 400 text/html body", async () => {
    const h = await hub();
    const raw = await rawBytes(h.port, rawUpgradeRequest(h.path, "nope"));
    expect(raw).toBe(RAW_404);
  });

  test("the 404 for a wrong-path upgrade is byte-identical to a plain GET's 404", async () => {
    const h = await hub();
    const upgradeRaw = await rawBytes(h.port, rawUpgradeRequest("wrong"));
    const getRaw = await rawBytes(h.port, rawGetRequest("/"));
    expect(upgradeRaw).toBe(RAW_404);
    expect(getRaw).toBe(RAW_404);
  });
});

describe("hub: liveness and teardown correctness", () => {
  test("a successful auth cancels the auth timeout, not just the pending cap", async () => {
    const h = await hub({ authTimeoutMs: 100 });
    const p = await authed(h, alice);
    await new Promise((r) => setTimeout(r, 300));
    expect(p.ws.readyState).toBe(p.ws.OPEN);
    await authed(h, bob);
    p.send(sendFrame(bob, "r1"));
    expect(await p.next()).toEqual({ type: "ack", ref: "r1" });
  });

  test("a disconnect detaches the peer from routing, not just from authed()", async () => {
    const h = await hub();
    const a = await authed(h, alice);
    const b = await authed(h, bob);
    b.ws.terminate();

    // The hub's own 'close' handler for bob's socket runs asynchronously, so
    // poll for the effect (routing sees bob as offline) instead of a fixed
    // sleep.
    let code: string | undefined;
    let ref = 0;
    const deadline = Date.now() + 2000;
    while (code === undefined && Date.now() < deadline) {
      const r = `p${ref++}`;
      a.send(sendFrame(bob, r));
      const reply = await a.next();
      if (reply.type === "error" && reply.code === "offline") {
        code = reply.code;
      } else {
        await new Promise((res) => setTimeout(res, 20));
      }
    }
    expect(code).toBe("offline");
  });

  test("a client that never answers pings gets dropped by the sweep", async () => {
    const h = await hub({ pingIntervalMs: 40, authTimeoutMs: 10_000 });
    // autoPong:false (ws 8.21+) makes the client silently ignore pings
    // instead of answering them, so the sweep's alive-tracking sees a truly
    // dead peer rather than one this test is keeping alive by accident.
    const p = probe(h.url, { autoPong: false });
    await p.open();
    p.send(helloFrame(alice, h.hubId));
    const challenge = await p.next();
    if (challenge.type !== "challenge") throw new Error("expected challenge");
    p.send(authFrame(alice, h.hubId, challenge.nonce));
    expect((await p.next()).type).toBe("ready");

    const code = await Promise.race([
      p.closed,
      new Promise<string>((r) => setTimeout(() => r("still open"), 40 * 4 + 500)),
    ]);
    expect(code).toBe(1006);
  });
});

describe("hub: startup validation", () => {
  test("a wrong-length hubId is rejected before anything is allocated", async () => {
    await expect(
      startHub({
        mode: "loopback",
        host: "127.0.0.1",
        path: "p",
        hubId: new Uint8Array(31),
        allow: new Map(),
      }),
    ).rejects.toThrow(RangeError);
  });

  test("a non-finite clock is rejected before anything is allocated", async () => {
    await expect(
      startHub({
        mode: "loopback",
        host: "127.0.0.1",
        path: "p",
        hubId: host.signPub,
        allow: new Map(),
        now: () => Number.NaN,
      }),
    ).rejects.toThrow(RangeError);
  });

  test("tailscale mode with no whois is rejected before pickPort/listen, even for a non-local address", async () => {
    // 100.64.0.1 passes validateBind's tailscale-CGNAT check but is not an
    // address this machine can bind, so if the whois check didn't run first,
    // this would instead fail later with a PortError/bind error, not our
    // startup-validation error.
    await expect(
      startHub({
        mode: "tailscale",
        host: "100.64.0.1",
        path: "p",
        hubId: host.signPub,
        allow: new Map(),
      }),
    ).rejects.toThrow(/whois/i);
  });

  test("a failed listen doesn't leave the ping interval running", async () => {
    const blocker = createNetServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
    });
    const addr = blocker.address();
    if (addr === null || typeof addr === "string") throw new Error("expected an AddressInfo");
    const port = addr.port;

    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      await expect(
        startHub({
          mode: "loopback",
          host: "127.0.0.1",
          path: "p",
          hubId: host.signPub,
          allow: new Map(),
          port,
        }),
      ).rejects.toThrow();
      // A failed listen must never even create the ping interval: nothing
      // would ever call close() to clear it.
      expect(setIntervalSpy).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
    }

    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });
});

describe("hub: fail-closed handler throws and teardown", () => {
  test("a handler throw kills the connection silently and still surfaces to the operator", async () => {
    let broken = false;
    const h = await hub({ authTimeoutMs: 10_000, now: () => (broken ? Number.NaN : Date.now()) });
    // The rethrow escapes ws's async listener as an unhandled rejection; capture
    // it here instead of letting the runner report it as a stray error.
    const saved = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    const surfaced = new Promise<unknown>((resolve) => process.once("unhandledRejection", resolve));
    try {
      const p = probe(h.url);
      await p.open();
      broken = true;
      p.send(helloFrame(alice, h.hubId));
      const code = await Promise.race([
        p.closed,
        new Promise<string>((r) => setTimeout(() => r("still open"), 1000)),
      ]);
      expect(code).toBe(1006);
      expect(p.raw).toEqual([]);
      // Bounded so the finally below always runs before the test timeout.
      const thrown = await Promise.race([
        surfaced,
        new Promise<string>((r) => setTimeout(() => r("not surfaced"), 1000)),
      ]);
      expect(thrown).toBeInstanceOf(RangeError);
    } finally {
      process.removeAllListeners("unhandledRejection");
      for (const l of saved) process.on("unhandledRejection", l as never);
    }
  });

  test("close() stops the ping sweep", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    try {
      const h = await startTestHub(host, []);
      hubs.push(h);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      const handle = setIntervalSpy.mock.results[0]!.value;
      await h.close();
      expect(clearIntervalSpy).toHaveBeenCalledWith(handle);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });
});
