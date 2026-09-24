import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkLaunch, checkThisSession, findClaudeArgv, type ProcInfo, type ProcResult, psLookup, SEND_TOOL } from "../../src/channel/launch.js";
import { tempHomes } from "./helpers.js";

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
    expect(findClaudeArgv(100, table(deep))).toEqual({ ok: false, reason: "not running under a claude process", noAncestor: true });
  });

  test("a name that merely contains claude doesn't count", () => {
    const lookup = table({ 50: { ppid: 1, args: "/usr/bin/claude-relay-fake --settings /r/s.json" } });
    expect(findClaudeArgv(50, lookup)).toEqual({ ok: false, reason: "not running under a claude process", noAncestor: true });
  });

  test("a lookup failure is reported by pid and reason, not folded into 'not a claude process'", () => {
    expect(findClaudeArgv(50, () => ({ ok: false, reason: "ps timed out" }))).toEqual({
      ok: false,
      reason: "could not inspect process 50: ps timed out",
      noAncestor: false,
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

  test("outside claude, the session check is blocked", () => {
    expect(checkThisSession(process.pid, () => ({ ok: true, info: { ppid: 1, args: "zsh" } }))).toEqual({
      ok: false,
      reason: "not running under a claude process",
    });
  });

  test("a lookup failure surfaces its own reason, distinct from 'not running under a claude process'", () => {
    expect(checkThisSession(process.pid, () => ({ ok: false, reason: "ps timed out" }))).toEqual({
      ok: false,
      reason: `could not inspect process ${process.pid}: ps timed out`,
    });
  });
});

describe("checkThisSession, end to end", () => {
  const nextHome = tempHomes("launch");

  test("passes when the claude ancestor's --settings file has the ask rule", () => {
    const home = nextHome();
    mkdirSync(home, { recursive: true });
    const settingsPath = join(home, "settings.json");
    writeFileSync(settingsPath, GOOD);
    chmodSync(settingsPath, 0o600);
    const lookup = (pid: number): ProcResult =>
      pid === 50 ? { ok: true, info: { ppid: 1, args: `/opt/homebrew/bin/claude --settings ${settingsPath}` } } : { ok: false, reason: `no process ${pid}` };
    expect(checkThisSession(50, lookup)).toEqual({ ok: true, settings: settingsPath });
  });
});
