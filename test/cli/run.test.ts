import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { add, card, init } from "../../src/cli/setup.js";
import { channel, hub } from "../../src/cli/run.js";
import { paths } from "../../src/channel/config.js";
import type { ProcLookup } from "../../src/channel/launch.js";
import { decodeCard, fingerprint } from "../../src/protocol/card.js";
import { tempHomes } from "../channel/helpers.js";
import { type FakeIo, fakeIo } from "./helpers.js";

const nextHome = tempHomes("cli-run");

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

// Like waitFor, but for a result that only settles asynchronously (e.g. a
// send that keeps succeeding until the hub notices the peer went away).
async function retryUntil<T>(fn: () => Promise<T>, match: (value: T) => boolean, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (match(value)) return value;
    if (Date.now() - start > ms) throw new Error("retryUntil timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Proves a hub's port was actually released, not just that hub() returned.
function expectPortClosed(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED") resolve();
      else reject(err);
    });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`expected port ${port} to be closed, but connected`));
    });
  });
}

function exchange(from: string, to: string): void {
  const io = fakeIo(from);
  card(io);
  const c = decodeCard(io.stdout[0] ?? "");
  expect(add(fakeIo(to), { card: io.stdout[0] ?? "", confirm: fingerprint(c.signPub, c.boxPub) })).toBe(0);
}

// A claude parent process launched with the relay settings, for findClaudeArgv/checkLaunch.
const launchedWith = (settings: string | null): ProcLookup => (pid) =>
  pid === 4242
    ? { ok: true, info: { ppid: 1, args: settings ? `claude --settings ${settings}` : "claude" } }
    : { ok: false, reason: `no process ${pid}` };

async function pair() {
  const aliceHome = nextHome();
  const bobHome = nextHome();
  await init(fakeIo(aliceHome), { alias: "alice", host: true, mode: "loopback" });
  await init(fakeIo(bobHome), { alias: "bob" });
  exchange(aliceHome, bobHome);
  exchange(bobHome, aliceHome);
  const hubIo = fakeIo(aliceHome);
  const done = hub(hubIo);
  cleanup.push(async () => {
    hubIo.stop();
    await done;
  });
  await waitFor(() => hubIo.stdout.length > 0);
  return { aliceHome, bobHome, hubIo, done };
}

interface Session {
  io: FakeIo;
  client: Client;
  notes: { content: string; meta: Record<string, string> }[];
  call(name: string, args?: Record<string, unknown>): Promise<string>;
  done: Promise<number>;
}

async function session(home: string, settings: string | null = paths(home).settings, lookup: ProcLookup = launchedWith(settings)): Promise<Session> {
  const io = fakeIo(home);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const done = channel(io, { transport: serverSide, ppid: 4242, lookup });
  const client = new Client({ name: "test", version: "0" });
  const notes: Session["notes"] = [];
  client.setNotificationHandler(z.object({ method: z.literal("notifications/claude/channel"), params: z.any() }), (n) => {
    notes.push(n.params);
  });
  await client.connect(clientSide);
  cleanup.push(async () => {
    io.stop();
    await done;
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
    return r.content[0]?.text ?? "";
  };
  return { io, client, notes, call, done };
}

describe("hub command", () => {
  test("refuses to start without a hub config", async () => {
    const home = nextHome();
    await init(fakeIo(home), { alias: "bob" });
    await expect(hub(fakeIo(home))).rejects.toMatchObject({ code: "missing" });
  });

  test("listens on the configured loopback port, then stops cleanly", async () => {
    const { hubIo, done } = await pair();
    const listening = hubIo.stdout[0]?.match(/^cc-relay hub listening on 127\.0\.0\.1:(\d+) \(loopback mode, 1 peer\)$/);
    expect(listening).not.toBeNull();
    const port = Number(listening?.[1]);
    hubIo.stop();
    expect(await done).toBe(0);
    expect(hubIo.stdout.at(-1)).toBe("cc-relay hub stopped");
    // Proves running.close() actually ran, not just that hub() returned.
    await expectPortClosed(port);
  });
});

describe("channel command", () => {
  test("host and guest sessions message each other through the hub", async () => {
    const { aliceHome, bobHome } = await pair();
    const alice = await session(aliceHome);
    const bob = await session(bobHome);
    await waitFor(() => alice.io.stderr.includes("cc-relay: connected to hub") && bob.io.stderr.includes("cc-relay: connected to hub"));

    expect(await bob.call("send", { to: "alice", text: "hi from bob" })).toBe("sent");
    await waitFor(() => alice.notes.length === 1);
    expect(alice.notes[0]).toMatchObject({ content: "hi from bob", meta: { from: "bob" } });

    expect(await alice.call("send", { to: "bob", text: "hi back" })).toBe("sent");
    await waitFor(() => bob.notes.length === 1);
    expect(bob.notes[0]).toMatchObject({ content: "hi back", meta: { from: "alice" } });
  });

  test("the peers tool reports the hub state and whether send is enabled", async () => {
    const { bobHome } = await pair();
    const bob = await session(bobHome);
    await waitFor(() => bob.io.stderr.includes("cc-relay: connected to hub"));
    const text = await bob.call("peers");
    expect(text).toContain("hub: ready");
    expect(text).toContain("send: enabled");
    expect(text).toContain("alice");
  });

  test("a session launched without the relay settings can receive but not send", async () => {
    const { aliceHome, bobHome } = await pair();
    const alice = await session(aliceHome);
    const bob = await session(bobHome, null);
    expect(bob.io.stderr[0]).toMatch(/^cc-relay: send is blocked: claude was launched without --settings/);
    await waitFor(() => bob.io.stderr.includes("cc-relay: connected to hub"));
    expect(await bob.call("send", { to: "alice", text: "sneaky" })).toMatch(/^blocked: /);
    expect(await alice.call("send", { to: "bob", text: "still reaches you" })).toBe("sent");
    await waitFor(() => bob.notes.length === 1);
    expect(alice.notes).toEqual([]);
  });

  test("a process-lookup failure blocks sending with its own reason, not the generic no-ancestor message", async () => {
    const { bobHome } = await pair();
    const bob = await session(bobHome, undefined, () => ({ ok: false, reason: "ps timed out" }));
    expect(bob.io.stderr[0]).toBe("cc-relay: send is blocked: could not inspect process 4242: ps timed out");
    expect(await bob.call("send", { to: "alice", text: "sneaky" })).toMatch(/^blocked: could not inspect process 4242: ps timed out/);
  });

  test("a session blocked at startup stays blocked even if the settings file gains the ask rule later", async () => {
    const { aliceHome, bobHome } = await pair();
    const alice = await session(aliceHome);
    const settingsPath = paths(bobHome).settings;
    const original = readFileSync(settingsPath, "utf8");
    writeFileSync(settingsPath, JSON.stringify({ permissions: {} }));
    try {
      const bob = await session(bobHome);
      expect(bob.io.stderr[0]).toMatch(/^cc-relay: send is blocked: /);
      writeFileSync(settingsPath, original);
      await waitFor(() => bob.io.stderr.includes("cc-relay: connected to hub") && alice.io.stderr.includes("cc-relay: connected to hub"));
      expect(await bob.call("send", { to: "alice", text: "sneaky" })).toMatch(/^blocked: /);
    } finally {
      writeFileSync(settingsPath, original);
    }
  });

  test("re-reads the settings file on every send and peers call, so a mid-session edit takes effect", async () => {
    const { aliceHome, bobHome } = await pair();
    const alice = await session(aliceHome);
    const bob = await session(bobHome);
    await waitFor(() => bob.io.stderr.includes("cc-relay: connected to hub") && alice.io.stderr.includes("cc-relay: connected to hub"));
    expect(await bob.call("send", { to: "alice", text: "hi" })).toBe("sent");

    const settingsPath = paths(bobHome).settings;
    const original = readFileSync(settingsPath, "utf8");
    writeFileSync(settingsPath, JSON.stringify({ permissions: {} }));
    try {
      expect(await bob.call("send", { to: "alice", text: "sneaky" })).toMatch(/^blocked: /);
      expect(await bob.call("peers")).toContain("send: blocked (");
    } finally {
      writeFileSync(settingsPath, original);
    }
    expect(await bob.call("send", { to: "alice", text: "back again" })).toBe("sent");
    expect(await bob.call("peers")).toContain("send: enabled");
  });

  test("nothing is written to stdout, which belongs to the MCP transport", async () => {
    const { bobHome } = await pair();
    const bob = await session(bobHome);
    await waitFor(() => bob.io.stderr.includes("cc-relay: connected to hub"));
    await bob.call("send", { to: "alice", text: "x" });
    expect(bob.io.stdout).toEqual([]);
  });

  test("a guest whose link points at a non-peer refuses to start", async () => {
    const { bobHome } = await pair();
    writeFileSync(paths(bobHome).peers, JSON.stringify({ v: 1, peers: [] }), { mode: 0o600 });
    await expect(channel(fakeIo(bobHome), { transport: InMemoryTransport.createLinkedPair()[0], ppid: 4242, lookup: launchedWith(null) })).rejects.toMatchObject({ code: "invalid" });
  });

  test("stops when told to, and releases both the hub connection and the MCP session", async () => {
    const { aliceHome, bobHome } = await pair();
    const alice = await session(aliceHome);
    const bob = await session(bobHome);
    await waitFor(() => alice.io.stderr.includes("cc-relay: connected to hub") && bob.io.stderr.includes("cc-relay: connected to hub"));

    let mcpClosed = false;
    bob.client.onclose = () => {
      mcpClosed = true;
    };
    bob.io.stop();
    expect(await bob.done).toBe(0);

    // Proves created.server.close() actually ran: the MCP session on bob's
    // side closed too, not just channel()'s own promise resolving.
    expect(mcpClosed).toBe(true);

    // Proves client.stop() actually ran: the hub's websocket to bob closed,
    // so the hub now sees bob as offline instead of still routing to it.
    const result = await retryUntil(
      () => alice.call("send", { to: "bob", text: "are you still there?" }),
      (text) => text.startsWith("offline: "),
    );
    expect(result).toMatch(/^offline: bob has no relay session connected$/);
  });
});
