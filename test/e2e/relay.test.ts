import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
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
    const stdout = execFileSync(process.execPath, [CLI, ...args], { env: { ...process.env, CC_RELAY_HOME: home }, encoding: "utf8", stdio: "pipe" });
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

function startHub(home: string): Promise<ChildProcess> {
  const proc = spawn(process.execPath, [CLI, "hub"], { env: { ...process.env, CC_RELAY_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
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
      if (d.toString().includes("listening")) ready(proc);
    });
    proc.once("exit", (code) => fail(new Error(`hub exited ${code}`)));
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
  await client.connect(transport);
  cleanup.push(() => client.close());
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
  execFileSync(process.execPath, [resolve(ROOT, "node_modules/typescript/bin/tsc"), "-p", resolve(ROOT, "tsconfig.json")], { stdio: "inherit" });
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
  }, 30_000);

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
