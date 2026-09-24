import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, test } from "vitest";
import { doctor, type DoctorDeps, GRANT_PROBE_PORTS, runChecks } from "../../src/cli/doctor.js";
import { canConnect, parseSntp, probeHub } from "../../src/cli/probe.js";
import { channel, hub } from "../../src/cli/run.js";
import { add, card, init } from "../../src/cli/setup.js";
import { loadHub, loadIdentity, loadLink, paths, saveLink } from "../../src/channel/config.js";
import type { ProcLookup } from "../../src/channel/launch.js";
import { decodeCard, fingerprint } from "../../src/protocol/card.js";
import { generateIdentity } from "../../src/protocol/identity.js";
import { tempHomes } from "../channel/helpers.js";
import { fakeIo } from "./helpers.js";

const nextHome = tempHomes("cli-doctor");

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

function exchange(from: string, to: string): void {
  const io = fakeIo(from);
  card(io);
  const c = decodeCard(io.stdout[0] ?? "");
  add(fakeIo(to), { card: io.stdout[0] ?? "", confirm: fingerprint(c.signPub, c.boxPub) });
}

const launchedWith = (settings: string | null): ProcLookup => (pid) =>
  pid === 4242 ? { ppid: 1, args: settings ? `claude --settings ${settings}` : "claude" } : null;

// Healthy defaults for everything outside the relay home.
const healthy = (extra: DoctorDeps = {}): DoctorDeps => ({
  ppid: 4242,
  lookup: () => null,
  clockOffset: async () => 0.08,
  fileExists: () => true,
  ...extra,
});

async function pair({ startHub = true, guestAdded = true } = {}) {
  const hostHome = nextHome();
  const guestHome = nextHome();
  await init(fakeIo(hostHome), { alias: "alice", host: true, mode: "loopback" });
  await init(fakeIo(guestHome), { alias: "bob" });
  exchange(hostHome, guestHome);
  if (guestAdded) exchange(guestHome, hostHome);
  if (startHub) {
    const io = fakeIo(hostHome);
    const done = hub(io);
    cleanup.push(async () => {
      io.stop();
      await done;
    });
    await waitFor(() => io.stdout.length > 0);
  }
  return { hostHome, guestHome };
}

const byName = async (home: string, deps: DoctorDeps) =>
  Object.fromEntries((await runChecks(fakeIo(home), deps)).map((c) => [c.name, c]));

describe("doctor", () => {
  test("a healthy guest passes everything that applies, and prints one line per check", async () => {
    const { guestHome } = await pair();
    const io = fakeIo(guestHome);
    expect(await doctor(io, healthy({ lookup: launchedWith(paths(guestHome).settings) }))).toBe(0);
    expect(io.stdout.map((l) => l.split(":")[0])).toEqual([
      "PASS  home",
      "PASS  identity",
      "PASS  peers",
      "PASS  settings",
      "PASS  mcp",
      "PASS  session",
      "PASS  clock",
      "SKIP  tailscale",
      "PASS  hub",
    ]);
  });

  test("the hub probe doesn't disturb a live relay session with the same identity", async () => {
    const { guestHome } = await pair();
    const io = fakeIo(guestHome);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const done = channel(io, { transport: serverSide, ppid: 4242, lookup: launchedWith(paths(guestHome).settings) });
    const client = new Client({ name: "t", version: "0" });
    await client.connect(clientSide);
    cleanup.push(async () => {
      io.stop();
      await done;
    });
    await waitFor(() => io.stderr.includes("cc-relay: connected to hub"));
    expect((await byName(guestHome, healthy())).hub?.status).toBe("PASS");
    const r = (await client.callTool({ name: "peers", arguments: {} })) as { content: { text: string }[] };
    expect(r.content[0]?.text).toContain("hub: ready");
  });

  test("hub failures say what to check", async () => {
    const stopped = await pair({ startHub: false });
    expect((await byName(stopped.guestHome, healthy())).hub).toMatchObject({ status: "FAIL", detail: expect.stringContaining("is cc-relay hub running") });

    const unknown = await pair({ guestAdded: false });
    expect((await byName(unknown.guestHome, healthy())).hub).toMatchObject({ status: "FAIL", detail: expect.stringContaining("allowlist") });

    const moved = await pair();
    const link = loadLink(moved.guestHome);
    if (!link) throw new Error("expected a link");
    saveLink(moved.guestHome, { ...link, path: "Z".repeat(22) });
    expect((await byName(moved.guestHome, healthy())).hub).toMatchObject({ status: "FAIL", detail: expect.stringContaining("404") });

    expect((await byName(stopped.guestHome, healthy({ probe: async () => "timeout" }))).hub).toMatchObject({
      status: "FAIL",
      detail: expect.stringContaining("client isolation"),
    });
  });

  test("the host probes its own hub", async () => {
    const { hostHome } = await pair();
    expect((await byName(hostHome, healthy())).hub?.status).toBe("PASS");
  });

  test("the session check fails a relay session launched without the settings, and skips outside claude", async () => {
    const { guestHome } = await pair({ startHub: false });
    expect((await byName(guestHome, healthy({ lookup: launchedWith(null) }))).session).toMatchObject({
      status: "FAIL",
      detail: expect.stringContaining("without --settings"),
    });
    expect((await byName(guestHome, healthy())).session?.status).toBe("SKIP");
  });

  test("settings without the ask rule fail; without the bypass lock they warn", async () => {
    const { guestHome } = await pair({ startHub: false });
    const p = paths(guestHome).settings;
    writeFileSync(p, JSON.stringify({ permissions: { ask: ["mcp__cc-relay__send"] } }));
    expect((await byName(guestHome, healthy())).settings?.status).toBe("WARN");
    writeFileSync(p, JSON.stringify({ permissions: { allow: ["mcp__cc-relay__send"] } }));
    expect((await byName(guestHome, healthy())).settings).toMatchObject({ status: "FAIL", detail: expect.stringContaining("permissions.ask") });
  });

  test("an mcp config pointing at a missing cli fails", async () => {
    const { guestHome } = await pair({ startHub: false });
    const cli = JSON.parse(readFileSync(paths(guestHome).mcp, "utf8")).mcpServers["cc-relay"].args[0];
    const checks = await byName(guestHome, healthy({ fileExists: (f) => f !== cli }));
    expect(checks.mcp).toMatchObject({ status: "FAIL", detail: expect.stringContaining("re-run cc-relay init") });
  });

  test.each([
    [0.5, "PASS"],
    [-12, "WARN"],
    [95, "FAIL"],
    [null, "WARN"],
  ] as const)("a clock offset of %s s is %s", async (offset, status) => {
    const { guestHome } = await pair({ startHub: false });
    expect((await byName(guestHome, healthy({ clockOffset: async () => offset }))).clock?.status).toBe(status);
  });

  test("a readable home or a missing identity fails, and later checks skip instead of crashing", async () => {
    const { guestHome } = await pair({ startHub: false });
    chmodSync(guestHome, 0o755);
    expect((await byName(guestHome, healthy())).home?.status).toBe("FAIL");
    chmodSync(guestHome, 0o700);

    const empty = nextHome();
    const io = fakeIo(empty);
    expect(await doctor(io, healthy())).toBe(1);
    const checks = await byName(empty, healthy());
    expect(checks.identity?.status).toBe("FAIL");
    expect(checks.peers?.status).toBe("SKIP");
    expect(checks.hub?.status).toBe("SKIP");
  });

  describe("a guest linked over tailscale", () => {
    async function tailscaleGuest() {
      const { guestHome } = await pair({ startHub: false });
      const link = loadLink(guestHome);
      if (!link) throw new Error("expected a link");
      saveLink(guestHome, { ...link, via: "tailscale", host: "100.64.0.7" });
      return guestHome;
    }
    const ok = { tailscale: async () => ({ bin: "/opt/homebrew/bin/tailscale", version: "1.90.0" }), probe: async () => "ok" as const };

    test("passes when only the hub port is reachable", async () => {
      const home = await tailscaleGuest();
      const tried: number[] = [];
      const checks = await byName(home, healthy({ ...ok, connectable: async (_h, port) => (tried.push(port), false) }));
      expect(tried).toEqual([...GRANT_PROBE_PORTS]);
      expect(checks.tailscale?.status).toBe("PASS");
      expect(checks.grant?.status).toBe("PASS");
    });

    test("fails when the grant also exposes other services", async () => {
      const home = await tailscaleGuest();
      const checks = await byName(home, healthy({ ...ok, connectable: async (_h, port) => port === 22 || port === 5900 }));
      expect(checks.grant).toMatchObject({ status: "FAIL", detail: expect.stringContaining("22, 5900") });
    });

    test("fails when the tailscale binary can't be found", async () => {
      const home = await tailscaleGuest();
      const checks = await byName(home, healthy({ ...ok, connectable: async () => false, tailscale: async () => { throw new Error("no tailscale binary"); } }));
      expect(checks.tailscale).toMatchObject({ status: "FAIL", detail: "no tailscale binary" });
    });

    test("skips rather than PASS when the host can't be reached at all", async () => {
      const home = await tailscaleGuest();
      const tried: number[] = [];
      const checks = await byName(
        home,
        healthy({ ...ok, probe: async () => "timeout" as const, connectable: async (_h, port) => (tried.push(port), false) }),
      );
      expect(checks.grant).toMatchObject({ status: "SKIP", detail: expect.stringContaining("could not reach") });
      expect(tried).toEqual([]);
    });

    test("excludes the hub's own port from the grant probe", async () => {
      const home = await tailscaleGuest();
      const link = loadLink(home);
      if (!link) throw new Error("expected a link");
      saveLink(home, { ...link, port: 8080 });
      const tried: number[] = [];
      const checks = await byName(home, healthy({ ...ok, connectable: async (_h, port) => (tried.push(port), false) }));
      expect(tried).not.toContain(8080);
      expect(checks.grant?.status).toBe("PASS");
    });
  });
});

describe("probe helpers", () => {
  test("parseSntp reads the offset from sntp's first line", () => {
    expect(parseSntp("+0.077707 +/- 0.037125 time.apple.com 17.253.4.45\n")).toBeCloseTo(0.077707);
    expect(parseSntp("-61.5 +/- 0.1 time.apple.com 17.253.4.45")).toBe(-61.5);
    expect(parseSntp("sntp: Exchange failed: DNS lookup failure\n")).toBeNull();
  });

  test("probeHub times out against a socket that never answers, and closes its connection", async () => {
    let closed = false;
    // resume() so the server reads, and so sees the probe's FIN.
    const silent: Server = createServer((s) => s.resume().on("close", () => (closed = true)));
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
    cleanup.push(() => new Promise((r) => silent.close(r)));
    const port = (silent.address() as { port: number }).port;
    const self = generateIdentity("x");
    expect(await probeHub(`ws://127.0.0.1:${port}/${"P".repeat(22)}`, self.signPub, self, 200)).toBe("timeout");
    await waitFor(() => closed);
  });

  test("probeHub reports an unresolvable host", async () => {
    const self = generateIdentity("x");
    expect(await probeHub(`ws://cc-relay-test.invalid:1/${"P".repeat(22)}`, self.signPub, self, 3000)).toBe("unresolved");
  });

  test("canConnect tells an open port from a closed one", async () => {
    const open: Server = createServer((s) => s.destroy());
    await new Promise<void>((r) => open.listen(0, "127.0.0.1", r));
    const port = (open.address() as { port: number }).port;
    expect(await canConnect("127.0.0.1", port, 500)).toBe(true);
    await new Promise((r) => open.close(r));
    expect(await canConnect("127.0.0.1", port, 500)).toBe(false);
  });
});
