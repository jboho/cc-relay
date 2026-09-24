import nacl from "tweetnacl";
import { type WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, test } from "vitest";
import { backoffDelay, HubClient, type HubClientOptions, MIN_BACKOFF_MS } from "../../src/channel/client.js";
import { toB64u } from "../../src/protocol/encoding.js";
import { generateIdentity, type Identity, peerId } from "../../src/protocol/identity.js";
import type { InboundFrame } from "../../src/protocol/receive.js";
import { SUPERSEDED_CODE } from "../../src/hub/router.js";
import { startTestHub, type TestHub } from "../hub/helpers.js";

const host = generateIdentity("host");
const alice = generateIdentity("alice");
const bob = generateIdentity("bob");
const stranger = generateIdentity("stranger");
const SEALED = { ciphertext: toB64u(nacl.randomBytes(48)), nonce: toB64u(nacl.randomBytes(24)) };

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function client(url: string, identity: Identity, extra: Partial<HubClientOptions> = {}) {
  const received: InboundFrame[] = [];
  const logs: string[] = [];
  const c = new HubClient({
    url,
    hubId: host.signPub,
    identity,
    onMessage: (f) => received.push(f),
    log: (l) => logs.push(l),
    backoffMinMs: 20,
    backoffMaxMs: 100,
    ...extra,
  });
  c.start();
  cleanup.push(() => c.stop());
  return { c, received, logs };
}

async function hub(overrides = {}): Promise<TestHub> {
  const h = await startTestHub(host, [alice, bob], overrides);
  cleanup.push(() => h.close());
  return h;
}

// A scriptable stand-in for the hub: it completes the handshake without
// checking signatures, then hands every later frame to `after`.
async function fakeHub(
  opts: {
    afterReady?: (ws: WebSocket, frame: Record<string, unknown>) => void;
    onHello?: (ws: WebSocket) => void;
    onReady?: (ws: WebSocket) => void;
  } = {},
) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => wss.once("listening", r));
  let connections = 0;
  wss.on("connection", (ws) => {
    connections++;
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame.type === "hello") {
        if (opts.onHello) return opts.onHello(ws);
        return ws.send(JSON.stringify({ type: "challenge", nonce: toB64u(nacl.randomBytes(32)) }));
      }
      if (frame.type === "auth") {
        ws.send(JSON.stringify({ type: "ready" }));
        return opts.onReady?.(ws);
      }
      opts.afterReady?.(ws, frame);
    });
  });
  cleanup.push(() => {
    for (const ws of wss.clients) ws.terminate();
    return new Promise((r) => wss.close(r));
  });
  const { port } = wss.address() as { port: number };
  return { url: `ws://127.0.0.1:${port}/x`, connections: () => connections };
}

describe("backoffDelay", () => {
  test("doubles from min, caps at max, and jitters within the upper half", () => {
    expect([0, 1, 2, 3].map((n) => backoffDelay(n, 500, 30_000, 1))).toEqual([500, 1000, 2000, 4000]);
    expect(backoffDelay(20, 500, 30_000, 1)).toBe(30_000);
    expect(backoffDelay(0, 500, 30_000, 0)).toBe(250);
  });

  test("caps the exponent so a very high attempt count doesn't overflow to NaN", () => {
    expect(backoffDelay(2000, 500, 30_000, 1)).toBe(30_000);
    expect(Number.isFinite(backoffDelay(2000, 500, 30_000, 1))).toBe(true);
  });

  test("clamps to a finite delay when min is 0, even after many attempts", () => {
    expect(backoffDelay(2000, 0, 30_000, 1)).toBe(MIN_BACKOFF_MS);
    expect(Number.isFinite(backoffDelay(2000, 0, 30_000, 0.5))).toBe(true);
  });

  test("never returns a delay below the floor, even for a tiny non-zero min", () => {
    expect(backoffDelay(0, 1, 30_000, 0)).toBe(MIN_BACKOFF_MS);
  });
});

describe("HubClient against the real hub", () => {
  test("authenticates, sends, and the recipient gets the frame stamped with the sender's id", async () => {
    const h = await hub();
    const a = client(h.url, alice);
    const b = client(h.url, bob);
    await waitFor(() => a.c.state === "ready" && b.c.state === "ready");
    expect(await a.c.send(peerId(bob.signPub), SEALED)).toEqual({ ok: true });
    await waitFor(() => b.received.length === 1);
    expect(b.received[0]).toEqual({ from: peerId(alice.signPub), ...SEALED });
  });

  test("hub errors come back as distinct results", async () => {
    const h = await hub();
    const a = client(h.url, alice);
    await waitFor(() => a.c.state === "ready");
    expect(await a.c.send(peerId(bob.signPub), SEALED)).toEqual({ ok: false, error: "offline" });
    expect(await a.c.send(peerId(stranger.signPub), SEALED)).toEqual({ ok: false, error: "unknown_peer" });
  });

  test("sending before the hub is ready says so instead of queueing", async () => {
    const h = await hub();
    const a = client(h.url, alice);
    expect(await a.c.send(peerId(bob.signPub), SEALED)).toEqual({ ok: false, error: "not connected" });
    await waitFor(() => a.c.state === "ready");
  });

  test("an identity the hub doesn't know never becomes ready, and keeps retrying", async () => {
    const h = await hub();
    const s = client(h.url, stranger);
    await new Promise((r) => setTimeout(r, 300));
    expect(s.c.state).toBe("connecting");
  });

  test("a second session with the same identity supersedes the first, which stops reconnecting", async () => {
    const h = await hub();
    const first = client(h.url, alice);
    await waitFor(() => first.c.state === "ready");
    const second = client(h.url, alice);
    await waitFor(() => first.c.state === "superseded");
    await new Promise((r) => setTimeout(r, 200));
    expect(first.c.state).toBe("superseded");
    expect(second.c.state).toBe("ready");
    expect(await first.c.send(peerId(bob.signPub), SEALED)).toEqual({ ok: false, error: "superseded" });
  });

  test("reconnects after the hub restarts on the same port and path", async () => {
    const h = await hub();
    const a = client(h.url, alice);
    await waitFor(() => a.c.state === "ready");
    await h.close();
    await waitFor(() => a.c.state === "connecting");
    const again = await hub({ port: h.port, path: h.path });
    expect(again.url).toBe(h.url);
    await waitFor(() => a.c.state === "ready");
  });
});

describe("HubClient against a misbehaving hub", () => {
  test("a pending send fails as hub disconnected when the connection drops", async () => {
    const fake = await fakeHub({ afterReady: (ws) => ws.terminate() });
    const a = client(fake.url, alice);
    await waitFor(() => a.c.state === "ready");
    expect(await a.c.send(peerId(bob.signPub), SEALED)).toEqual({ ok: false, error: "hub disconnected" });
  });

  test("an ack that never comes times out", async () => {
    const fake = await fakeHub({ afterReady: () => {} });
    const a = client(fake.url, alice, { ackTimeoutMs: 100 });
    await waitFor(() => a.c.state === "ready");
    expect(await a.c.send(peerId(bob.signPub), SEALED)).toEqual({ ok: false, error: "timeout" });
  });

  test.each([
    ["a malformed frame", (ws: WebSocket) => ws.send("{nope")],
    ["ready before a challenge", (ws: WebSocket) => ws.send(JSON.stringify({ type: "ready" }))],
    ["a message before auth", (ws: WebSocket) => ws.send(JSON.stringify({ type: "msg", from: "A".repeat(43), ciphertext: "YQ", nonce: "N".repeat(32) }))],
  ])("%s ends the connection and a new one is tried", async (_name, reply) => {
    const fake = await fakeHub({ onHello: reply });
    const a = client(fake.url, alice);
    await waitFor(() => fake.connections() >= 2);
    expect(a.c.state).not.toBe("ready");
    expect(a.logs.some((l) => l.includes("dropping the hub connection"))).toBe(true);
  });

  test("a ping before the handshake completes doesn't reset the keepalive, so a stalled handshake still times out", async () => {
    const fake = await fakeHub({
      onHello: (ws) => {
        const t = setInterval(() => ws.ping(), 20);
        ws.on("close", () => clearInterval(t));
      },
    });
    const a = client(fake.url, alice, { keepaliveMs: 100 });
    await waitFor(() => a.logs.includes("cc-relay: no ping from the hub; reconnecting"));
    expect(a.c.state).not.toBe("ready");
  });

  test("a hub that stops pinging is dropped", async () => {
    const fake = await fakeHub();
    const a = client(fake.url, alice, { keepaliveMs: 100 });
    await waitFor(() => fake.connections() >= 2);
    expect(a.logs).toContain("cc-relay: no ping from the hub; reconnecting");
  });

  test("pings from the hub keep the connection alive", async () => {
    const fake = await fakeHub({
      onReady: (ws) => {
        const t = setInterval(() => ws.ping(), 30);
        ws.on("close", () => clearInterval(t));
      },
    });
    const a = client(fake.url, alice, { keepaliveMs: 100 });
    await waitFor(() => a.c.state === "ready");
    await new Promise((r) => setTimeout(r, 400));
    expect(fake.connections()).toBe(1);
    expect(a.c.state).toBe("ready");
  });

  test("backoff resets after each successful connection", async () => {
    const fake = await fakeHub({ onReady: (ws) => setTimeout(() => ws.terminate(), 5) });
    // backoffMinMs is kept well above MIN_BACKOFF_MS so this test's assertion
    // exercises the reset logic, not the floor from the test below.
    const a = client(fake.url, alice, { backoffMinMs: 200, backoffMaxMs: 5000, random: () => 1 });
    await waitFor(() => fake.connections() >= 5);
    const delays = a.logs.filter((l) => l.includes("retrying in")).map((l) => Number(/in (\d+)ms/.exec(l)?.[1]));
    expect(delays.length).toBeGreaterThanOrEqual(4);
    expect(delays.every((d) => d === 200)).toBe(true);
  });

  test("a send pending when the session is superseded is rejected as superseded, not hub disconnected", async () => {
    let serverWs: WebSocket | undefined;
    const fake = await fakeHub({ afterReady: (ws) => { serverWs = ws; } });
    const a = client(fake.url, alice);
    await waitFor(() => a.c.state === "ready");
    const pending = a.c.send(peerId(bob.signPub), SEALED);
    await waitFor(() => serverWs !== undefined);
    serverWs?.close(SUPERSEDED_CODE);
    expect(await pending).toEqual({ ok: false, error: "superseded" });
    expect(a.c.state).toBe("superseded");
  });

  test("late events on a socket the client has already replaced don't reach the current connection", async () => {
    const conns: WebSocket[] = [];
    const fake = await fakeHub({
      onReady: (ws) => conns.push(ws),
      afterReady: (ws, frame) => {
        // Only the second (current) connection gets an ack; the first is left
        // hanging so a stray ack routed to it can't be mistaken for a real reply.
        if (conns.indexOf(ws) === 1 && frame.type === "msg") ws.send(JSON.stringify({ type: "ack", ref: frame.ref }));
      },
    });
    const a = client(fake.url, alice);
    await waitFor(() => a.c.state === "ready");
    const oldWs = (a.c as unknown as { ws: WebSocket }).ws;

    oldWs.close();
    await waitFor(() => a.c.state === "ready" && conns.length >= 2);
    const newWs = (a.c as unknown as { ws: WebSocket }).ws;
    expect(newWs).not.toBe(oldWs);

    const pending = a.c.send(peerId(bob.signPub), SEALED);

    // These are events arriving on the socket the client has already moved
    // past: a frame that was in flight when the reconnect happened, and a
    // duplicate close/error the old socket fires afterward. Without the
    // per-socket guards, they'd be handled as if they came from the live
    // connection - resolving the wrong pending send and flipping a healthy
    // client back to "connecting".
    const emit = (ws: WebSocket, event: string, ...args: unknown[]) =>
      (ws as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit(event, ...args);
    emit(oldWs, "message", Buffer.from(JSON.stringify({ type: "error", ref: "s0", code: "unknown_peer" })), false);
    emit(oldWs, "close", 1000);
    emit(oldWs, "error", new Error("late error from a socket we've already replaced"));

    expect(a.c.state).toBe("ready");
    expect(a.logs.some((l) => l.includes("late error from a socket"))).toBe(false);
    expect(await pending).toEqual({ ok: true });
    expect(a.c.state).toBe("ready");
  });

  test("a second start() call is a no-op, not a second live connection", async () => {
    const fake = await fakeHub();
    const a = client(fake.url, alice);
    a.c.start();
    a.c.start();
    await waitFor(() => a.c.state === "ready");
    await new Promise((r) => setTimeout(r, 150));
    expect(fake.connections()).toBe(1);
  });

  test("stop() ends the loop for good", async () => {
    const fake = await fakeHub();
    const a = client(fake.url, alice);
    await waitFor(() => a.c.state === "ready");
    a.c.stop();
    const seen = fake.connections();
    await new Promise((r) => setTimeout(r, 200));
    expect(fake.connections()).toBe(seen);
    expect(a.c.state).toBe("closed");
  });
});

describe("HubClient with a throwing app callback", () => {
  test("onMessage throwing is caught and logged, without the raw message text, instead of killing the channel", async () => {
    const fake = await fakeHub({
      onReady: (ws) => ws.send(JSON.stringify({ type: "msg", from: peerId(bob.signPub), ...SEALED })),
    });
    const logs: string[] = [];
    let uncaught: unknown;
    const onUncaught = (err: unknown) => {
      uncaught = err;
    };
    process.on("uncaughtException", onUncaught);
    const c = new HubClient({
      url: fake.url,
      hubId: host.signPub,
      identity: alice,
      onMessage: () => {
        throw new Error("boom from onMessage");
      },
      log: (l) => logs.push(l),
      backoffMinMs: 20,
      backoffMaxMs: 100,
    });
    c.start();
    cleanup.push(() => c.stop());
    try {
      await waitFor(() => logs.some((l) => l.includes("boom from onMessage")));
      expect(uncaught).toBeUndefined();
      expect(logs.some((l) => l.includes(SEALED.ciphertext))).toBe(false);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  test("an internal error in the client's own frame handling (not onMessage) resets the connection promptly with an accurate label", async () => {
    // b64u() in frames.ts checks only the alphabet and length, so this passes the
    // ChallengeFrame schema, but fromB64u (called inside authFor) also requires the
    // canonical encoding and throws - a bug reachable from a real hub, not onMessage.
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const canonical = toB64u(nacl.randomBytes(32));
    const lastIndex = ALPHABET.indexOf(canonical.at(-1) as string);
    const nonCanonical = canonical.slice(0, -1) + ALPHABET[lastIndex ^ 1];

    const fake = await fakeHub({ onHello: (ws) => ws.send(JSON.stringify({ type: "challenge", nonce: nonCanonical })) });
    const a = client(fake.url, alice, { backoffMinMs: 5, backoffMaxMs: 20 });
    await waitFor(() => a.logs.some((l) => l.includes("internal error handling hub frame: EncodingError")));
    expect(a.logs.some((l) => l.includes("onMessage threw"))).toBe(false);
    // Confirms the connection was actually reset (bail -> terminate -> close ->
    // reconnect), not just logged, and that it happened well before the 75s
    // default keepalive timeout could have forced it.
    await waitFor(() => fake.connections() >= 2);
  });
});
