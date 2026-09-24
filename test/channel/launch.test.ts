import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { checkLaunch, findClaudeArgv, makePsLookup, type ProcInfo, type ProcResult, psLookup, SEND_TOOL } from "../../src/channel/launch.js";

const GOOD = JSON.stringify({ permissions: { ask: [SEND_TOOL] } });
const files: Record<string, string> = {
  "/relay/settings.json": GOOD,
  "/relay/other.json": JSON.stringify({ permissions: { allow: [SEND_TOOL] } }),
  "/relay/bypass.json": JSON.stringify({ permissions: { ask: [SEND_TOOL], defaultMode: "bypassPermissions" } }),
  "/relay/broken.json": "{",
};
const read = (p: string) => {
  const text = files[p];
  if (text === undefined) throw new Error(`ENOENT: ${p}`);
  return text;
};
const claude = (...args: string[]) => ["/opt/homebrew/bin/claude", ...args];

describe("checkLaunch", () => {
  test("passes when a --settings file has the ask rule", () => {
    expect(checkLaunch(claude("--settings", "/relay/settings.json"), read)).toEqual({
      ok: true,
      settings: "/relay/settings.json",
    });
  });

  test("accepts --settings=<path> and inline JSON, and the last --settings wins", () => {
    expect(checkLaunch(claude("--settings=/relay/settings.json"), read).ok).toBe(true);
    expect(checkLaunch(claude("--settings", GOOD), read).ok).toBe(true);
    expect(checkLaunch(claude("--settings", "/relay/other.json", "--settings", "/relay/settings.json"), read).ok).toBe(true);
    const reversed = checkLaunch(claude("--settings", "/relay/settings.json", "--settings", "/relay/other.json"), read);
    expect(reversed).toMatchObject({ ok: false });
    expect((reversed as { reason: string }).reason).toContain("/relay/other.json");
  });

  test("an allow rule is not an ask rule", () => {
    expect(checkLaunch(claude("--settings", "/relay/other.json"), read)).toMatchObject({ ok: false });
  });

  test.each([
    [["--dangerously-skip-permissions"], /dangerously-skip-permissions/],
    [["--allow-dangerously-skip-permissions"], /allow-dangerously-skip-permissions/],
    [["--permission-mode", "bypassPermissions"], /bypassPermissions/],
    [["--permission-mode=bypassPermissions"], /bypassPermissions/],
  ])("refuses %j even with the ask rule loaded", (flags, reason) => {
    const result = checkLaunch(claude("--settings", "/relay/settings.json", ...flags), read);
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(reason);
  });

  test("refuses settings that make bypass the default mode", () => {
    expect(checkLaunch(claude("--settings", "/relay/bypass.json"), read)).toMatchObject({ ok: false });
  });

  test("allows the other permission modes", () => {
    for (const mode of ["default", "auto", "acceptEdits", "plan"]) {
      expect(checkLaunch(claude("--settings", "/relay/settings.json", "--permission-mode", mode), read).ok).toBe(true);
    }
  });

  test.each([
    [[], /without --settings/],
    [["--settings", "relay/settings.json"], /not an absolute path/],
    [["--settings", "/relay/missing.json"], /cannot read/],
    [["--settings", "/relay/broken.json"], /not valid JSON/],
    [["--settings", '{"permissions":'], /not valid JSON/],
    [["--settings"], /without --settings/],
  ])("fails closed for %j", (flags, reason) => {
    const result = checkLaunch(claude(...flags), read);
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(reason);
  });
});

describe("findClaudeArgv", () => {
  const table = (rows: Record<number, ProcInfo>) => (pid: number): ProcResult =>
    rows[pid] ? { ok: true, info: rows[pid] as ProcInfo } : { ok: false, reason: `no process ${pid}` };

  test("returns the parent's argv when the parent is claude", () => {
    const lookup = table({ 50: { ppid: 1, args: "/opt/homebrew/bin/claude --settings /r/s.json" } });
    expect(findClaudeArgv(50, lookup)).toEqual({ ok: true, argv: ["/opt/homebrew/bin/claude", "--settings", "/r/s.json"] });
  });

  test("recognises an npm-installed claude run through node", () => {
    const lookup = table({ 50: { ppid: 1, args: "node /usr/local/bin/claude --settings /r/s.json" } });
    const result = findClaudeArgv(50, lookup);
    expect(result.ok && result.argv[1]).toBe("/usr/local/bin/claude");
  });

  test("walks up through wrappers, but not forever", () => {
    const lookup = table({
      50: { ppid: 40, args: "/bin/sh -c node cli.js channel" },
      40: { ppid: 30, args: "claude --settings /r/s.json" },
    });
    const found = findClaudeArgv(50, lookup);
    expect(found.ok && found.argv[0]).toBe("claude");
    const deep: Record<number, ProcInfo> = {};
    for (let pid = 100; pid > 2; pid--) deep[pid] = { ppid: pid - 1, args: "sh" };
    deep[2] = { ppid: 1, args: "claude --settings /r/s.json" };
    expect(findClaudeArgv(100, table(deep))).toEqual({ ok: false, kind: "no-ancestor" });
  });

  test("a name that merely contains claude doesn't count", () => {
    const lookup = table({ 50: { ppid: 1, args: "/usr/bin/claude-relay-fake --settings /r/s.json" } });
    expect(findClaudeArgv(50, lookup)).toEqual({ ok: false, kind: "no-ancestor" });
  });

  test("a lookup failure is reported by pid and reason, not folded into 'not a claude process'", () => {
    expect(findClaudeArgv(50, () => ({ ok: false, reason: "ps timed out" }))).toEqual({
      ok: false,
      kind: "lookup-failed",
      reason: "could not inspect process 50: ps timed out",
    });
  });
});

describe("the real process table", () => {
  test("psLookup reads this test process's parent", () => {
    const result = psLookup(process.pid);
    expect(result.ok && result.info.ppid).toBe(process.ppid);
    expect(result.ok && result.info.args).toContain("node");
  });

  test("psLookup reports why it failed for a pid that doesn't exist", () => {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid as number;
    const result = psLookup(dead);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/ps failed/);
  });
});

describe("makePsLookup", () => {
  test("reports a timeout distinctly from a generic ps failure", () => {
    const timedOut = () => {
      throw Object.assign(new Error("ps did not respond"), { code: "ETIMEDOUT" });
    };
    expect(makePsLookup(timedOut)(50)).toEqual({ ok: false, reason: "ps timed out inspecting process 50" });
  });

  test("a non-timeout ps failure keeps its own message, not the timeout wording", () => {
    const enoent = () => {
      throw Object.assign(new Error("spawn ps ENOENT"), { code: "ENOENT" });
    };
    expect(makePsLookup(enoent)(50)).toEqual({ ok: false, reason: "ps failed: spawn ps ENOENT" });
  });

  test("reports unparsable ps output distinctly from ps failing to run", () => {
    const garbled = () => "not what ps normally prints";
    expect(makePsLookup(garbled)(50)).toEqual({ ok: false, reason: "ps produced output that didn't parse for process 50" });
  });
});
