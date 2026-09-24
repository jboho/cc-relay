import { type ChildProcessByStdio, execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { paths } from "../../src/channel/config.js";
import { tempHomes } from "../channel/helpers.js";

const ROOT = resolve(import.meta.dirname, "../..");
const CLI = resolve(ROOT, "dist/cli.js");
const FAKE_CLAUDE = resolve(import.meta.dirname, "fixtures/claude");
const nextHome = tempHomes("e2e");

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function cli(home: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, CC_RELAY_HOME: home },
      encoding: "utf8",
      stdio: "pipe",
      timeout: 20_000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

// The fingerprint goes to stderr, so `add` without --confirm is how a person
// sees it; the test reads it the same way.
function exchange(from: string, to: string): void {
  const cardText = cli(from, "card").stdout.trim();
  const shown = cli(to, "add", cardText);
  expect(shown.status).toBe(2);
  const fp = /fingerprint ([0-9a-f-]{24})/.exec(shown.stderr)?.[1];
  expect(fp).toBeDefined();
  expect(cli(to, "add", cardText, "--confirm", fp ?? "").status).toBe(0);
}

// The hub's stdout/stderr on top of the ChildProcess: `out` and `err`
// accumulate everything printed so far, and `stopped` resolves once the
// process actually exits, with its exit code and final stdout -- used by the
// "stops cleanly" assertion below without adding another spawn helper.
interface Hub extends ChildProcessByStdio<null, Readable, Readable> {
  out: () => string;
  err: () => string;
  stopped: Promise<{ code: number | null; stdout: string }>;
}

function startHub(home: string): Promise<Hub> {
  const proc = spawn(process.execPath, [CLI, "hub"], { env: { ...process.env, CC_RELAY_HOME: home }, stdio: ["ignore", "pipe", "pipe"] }) as Hub;
  let out = "";
  let err = "";
  proc.out = () => out;
  proc.err = () => err;
  // stderr is piped but must be drained regardless of whether anything ever
  // reads it, or the hub can block writing to a full pipe; keeping it around
  // also means a startup failure's diagnostics aren't silently dropped.
  proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
  proc.stopped = new Promise((resolve) => proc.once("exit", (code) => resolve({ code, stdout: out })));
  cleanup.push(
    () =>
      new Promise<void>((done) => {
        if (proc.exitCode !== null) return done();
        proc.once("exit", () => done());
        proc.kill("SIGTERM");
      }),
  );
  return new Promise((ready, fail) => {
    proc.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      // Checked against the accumulated buffer, not the chunk that just came
      // in: "listening" can straddle two chunks under a small pipe buffer.
      if (out.includes("listening")) ready(proc);
    });
    proc.once("exit", (code) => fail(new Error(`hub exited ${code} before it started listening\nstderr:\n${err}`)));
  });
}

interface Session {
  client: Client;
  notes: { content: string; meta: Record<string, string> }[];
  stderr: () => string;
  send(to: string, text: string): Promise<string>;
  transport: StdioClientTransport;
}

async function session(home: string, { withSettings = true } = {}): Promise<Session> {
  const p = paths(home);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [FAKE_CLAUDE, "--mcp-config", p.mcp, ...(withSettings ? ["--settings", p.settings] : [])],
    env: { PATH: process.env.PATH ?? "" },
    stderr: "pipe",
  });
  let err = "";
  transport.stderr?.on("data", (d: Buffer) => (err += d.toString()));
  const client = new Client({ name: "e2e", version: "0" });
  const notes: Session["notes"] = [];
  client.setNotificationHandler(z.object({ method: z.literal("notifications/claude/channel"), params: z.any() }), (n) => {
    notes.push(n.params);
  });
  // Pushed before connect(): client.close() is a safe no-op if connect()
  // never finishes (it guards on the transport having actually spawned), but
  // if it's pushed only after a successful connect and the test throws first
  // -- or connect() itself hangs or rejects -- this session's fixture (and
  // the real channel process under it) is never cleaned up, and the next
  // test's session for the same identity fails with "superseded".
  cleanup.push(() => client.close());
  await client.connect(transport);
  const send = async (to: string, text: string) => {
    const r = (await client.callTool({ name: "send", arguments: { to, text } })) as { content: { text: string }[] };
    return r.content[0]?.text ?? "";
  };
  await waitFor(() => err.includes("cc-relay: connected to hub"));
  return { client, notes, stderr: () => err, send, transport };
}

let hostHome: string;
let guestHome: string;

beforeAll(() => {
  execFileSync(process.execPath, [resolve(ROOT, "node_modules/typescript/bin/tsc"), "-p", resolve(ROOT, "tsconfig.json")], {
    stdio: "inherit",
    timeout: 20_000,
  });
  hostHome = nextHome();
  guestHome = nextHome();
  expect(cli(hostHome, "init", "--alias", "alice", "--host", "--mode", "loopback").status).toBe(0);
  expect(cli(guestHome, "init", "--alias", "bob").status).toBe(0);
  exchange(hostHome, guestHome);
  exchange(guestHome, hostHome);
}, 60_000);

describe("cc-relay end to end: real hub process, channels launched the way Claude Code launches them", () => {
  test("messages flow both ways between host and guest sessions", async () => {
    await startHub(hostHome);
    const alice = await session(hostHome);
    const bob = await session(guestHome);

    expect(await bob.send("alice", "hello from bob")).toBe("sent");
    await waitFor(() => alice.notes.length === 1);
    expect(alice.notes[0]).toMatchObject({ content: "hello from bob", meta: { from: "bob" } });

    expect(await alice.send("bob", "hello from alice")).toBe("sent");
    await waitFor(() => bob.notes.length === 1);
    expect(bob.notes[0]).toMatchObject({ content: "hello from alice", meta: { from: "alice" } });
  }, 30_000);

  test("a session launched without the relay settings receives but cannot send", async () => {
    await startHub(hostHome);
    const alice = await session(hostHome);
    const bob = await session(guestHome, { withSettings: false });
    expect(bob.stderr()).toContain("cc-relay: send is blocked: claude was launched without --settings");
    expect(await bob.send("alice", "sneaky")).toMatch(/^blocked: /);
    expect(await alice.send("bob", "you can still hear me")).toBe("sent");
    await waitFor(() => bob.notes.length === 1);
    // Not a race: bob's blocked send fails in the channel's own launch check
    // (src/channel/server.ts) before it ever calls hub.send, so nothing
    // reaches the wire for alice to receive, regardless of timing.
    expect(alice.notes).toEqual([]);
  }, 30_000);

  test("the channel exits when the session closes, instead of lingering on the hub", async () => {
    await startHub(hostHome);
    const bob = await session(guestHome);
    const pid = Number(/CHANNEL_PID (\d+)/.exec(bob.stderr())?.[1]);
    expect(pid).toBeGreaterThan(0);
    await bob.client.close();
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await waitFor(() => !alive());
    // The fixture prints this once the real channel process (CHANNEL_PID
    // above) has actually exited; confirms a clean shutdown, not a signal kill.
    expect(bob.stderr()).toContain("CHANNEL_EXIT 0");
  }, 30_000);

  test("stopping the hub with SIGTERM makes it exit 0 and announce it on stdout", async () => {
    const hubProc = await startHub(hostHome);
    // src/cli/run.ts's hub() now calls io.until() (which registers the
    // SIGINT/SIGTERM handler synchronously) before printing the "listening"
    // line, so a SIGTERM sent the instant "listening" is observed can no
    // longer race the handler -- no delay needed here.
    hubProc.kill("SIGTERM");
    const { code, stdout } = await hubProc.stopped;
    expect(code).toBe(0);
    expect(stdout).toContain("cc-relay hub stopped");
  }, 15_000);

  test("doctor passes on both machines while the hub runs", async () => {
    await startHub(hostHome);
    for (const home of [hostHome, guestHome]) {
      const r = cli(home, "doctor");
      // The session check looks at whoever launched the test run. Under a plain
      // terminal it skips; inside Claude Code it rightly fails, so leave it out.
      const lines = r.stdout.split("\n").filter((l) => !l.includes("  session: "));
      expect(lines.filter((l) => l.startsWith("FAIL"))).toEqual([]);
      expect(r.stdout).toMatch(/^PASS  hub: /m);
    }
  }, 60_000);
});
