import { request } from "node:http";
import { createServer as createNetServer } from "node:net";
import nacl from "tweetnacl";
import { afterEach, describe, expect, test } from "vitest";
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
function probe(url: string) {
  const p = new Probe(url);
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
    await new Promise((r) => setTimeout(r, 50));
    const tenth = probe(h.url);
    await tenth.open();
  });

  test("authenticated connections don't count against the pending cap", async () => {
    const h = await hub({ maxPending: 1 });
    await authed(h, alice);
    await authed(h, bob);
  });

  test("an oversize frame is closed with 1009 (the one non-silent close)", async () => {
    const h = await hub();
    const p = probe(h.url);
    await p.open();
    p.send("x".repeat(129 * 1024));
    expect(await p.closed).toBe(1009);
    expect(p.raw).toEqual([]);
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

    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
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
    const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    expect(after).toBe(before);

    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });
});
