import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

export const SEND_TOOL = "mcp__cc-relay__send";

export type LaunchCheck = { ok: true; settings: string } | { ok: false; reason: string };

export interface ProcInfo {
  ppid: number;
  args: string;
}

// A failure here (ps couldn't run, timed out, or its output didn't parse) says
// nothing about whether the target is a claude process, so it's kept distinct
// from "no info" — findClaudeArgv only reads "not a claude process" off the
// end of a walk where every lookup actually succeeded.
export type ProcResult = { ok: true; info: ProcInfo } | { ok: false; reason: string };

export type ProcLookup = (pid: number) => ProcResult;

export const psLookup: ProcLookup = (pid) => {
  let out: string;
  try {
    out = execFileSync("ps", ["-o", "ppid=,args=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // execFileSync sets .code to ETIMEDOUT (not a signal) when its own timeout
    // option killed the child, distinct from the process legitimately failing.
    if (e.code === "ETIMEDOUT") return { ok: false, reason: `ps timed out inspecting process ${pid}` };
    return { ok: false, reason: `ps failed: ${e.message}` };
  }
  const m = /^\s*(\d+)\s+(.*)$/.exec(out.trimEnd());
  if (!m) return { ok: false, reason: `ps produced output that didn't parse for process ${pid}` };
  return { ok: true, info: { ppid: Number(m[1]), args: m[2] as string } };
};

function isClaude(tokens: readonly string[]): boolean {
  const first = basename(tokens[0] ?? "");
  if (first === "claude") return true;
  // An npm install runs the CLI as `node <...>/claude`.
  return first === "node" && basename(tokens[1] ?? "") === "claude";
}

// `ps` joins argv with spaces, so an argument containing a space can't be
// recovered exactly, and free text that happens to contain a flag-shaped
// token pair — e.g. `claude "use --settings /abs/relay.json"` — splits into
// what looks like a real --settings flag. This parser can't tell that case
// apart from a genuine one.
// noAncestor is true only when the walk completed with every lookup succeeding
// and simply found no claude ancestor; a lookup failure gets noAncestor: false
// so callers (doctor's session check) can tell "nothing to check" from "we
// couldn't tell", instead of both reading as the same generic message.
export type ArgvResult = { ok: true; argv: string[] } | { ok: false; reason: string; noAncestor: boolean };

export function findClaudeArgv(startPid: number, lookup: ProcLookup = psLookup, maxDepth = 8): ArgvResult {
  let pid = startPid;
  for (let depth = 0; depth < maxDepth && pid > 1; depth++) {
    const result = lookup(pid);
    if (!result.ok) return { ok: false, reason: `could not inspect process ${pid}: ${result.reason}`, noAncestor: false };
    const tokens = result.info.args.split(/\s+/).filter((t) => t !== "");
    if (isClaude(tokens)) return { ok: true, argv: tokens };
    pid = result.info.ppid;
  }
  return { ok: false, reason: "not running under a claude process", noAncestor: true };
}

function flagValues(argv: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === flag && i + 1 < argv.length) values.push(argv[++i] as string);
    else if (arg.startsWith(`${flag}=`)) values.push(arg.slice(flag.length + 1));
  }
  return values;
}

function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.some((a) => a === flag || a.startsWith(`${flag}=`));
}

interface PermissionsBlock {
  ask?: unknown;
  defaultMode?: unknown;
}

function describeSettings(value: string): string {
  return value.startsWith("{") ? "(inline)" : value;
}

function permissionsOf(value: string, read: (path: string) => string): PermissionsBlock | string {
  let text: string;
  if (value.startsWith("{")) {
    text = value;
  } else {
    if (!isAbsolute(value)) return `--settings ${value} is not an absolute path`;
    try {
      text = read(value);
    } catch (err) {
      return `cannot read --settings ${value}: ${(err as Error).message}`;
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `--settings ${describeSettings(value)} is not valid JSON`;
  }
  const perms = (parsed as { permissions?: unknown } | null)?.permissions;
  return typeof perms === "object" && perms !== null ? (perms as PermissionsBlock) : {};
}

// The gate result (gate/RESULT.md): an ask rule on the send tool makes Claude
// Code prompt before every send, in manual and auto mode, and beats a matching
// allow rule. Only a session without the rule sends silently. So the check is
// "was the rule loaded", read from the claude process's own argv, plus a
// refusal of every flag that switches prompting off entirely.
export function checkLaunch(argv: readonly string[], read: (path: string) => string = (p) => readFileSync(p, "utf8")): LaunchCheck {
  for (const flag of ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"]) {
    if (hasFlag(argv, flag)) return { ok: false, reason: `claude was launched with ${flag}` };
  }
  if (flagValues(argv, "--permission-mode").includes("bypassPermissions")) {
    return { ok: false, reason: "claude was launched with --permission-mode bypassPermissions" };
  }
  const settings = flagValues(argv, "--settings");
  if (settings.length === 0) return { ok: false, reason: "claude was launched without --settings (use the claude-relay alias)" };
  // Claude Code keeps only the LAST --settings value when the flag repeats, so
  // that's the only one whose ask rule matters. Every value is still checked
  // for a bypass default and for being readable/valid JSON — those failure
  // modes are stricter, so applying them to every value, not just the last
  // one, never turns an unsafe launch into a pass.
  let lastPerms: PermissionsBlock | undefined;
  for (const value of settings) {
    const perms = permissionsOf(value, read);
    if (typeof perms === "string") return { ok: false, reason: perms };
    if (perms.defaultMode === "bypassPermissions") {
      return { ok: false, reason: `--settings ${value} sets defaultMode bypassPermissions` };
    }
    lastPerms = perms;
  }
  const last = settings[settings.length - 1] as string;
  if (!lastPerms || !Array.isArray(lastPerms.ask) || !lastPerms.ask.includes(SEND_TOOL)) {
    return { ok: false, reason: `the last --settings (${describeSettings(last)}) lacks permissions.ask ["${SEND_TOOL}"]` };
  }
  return { ok: true, settings: last };
}

// Run once at channel start; a session can't change its own argv afterwards.
export function checkThisSession(ppid: number = process.ppid, lookup: ProcLookup = psLookup): LaunchCheck {
  const argv = findClaudeArgv(ppid, lookup);
  if (!argv.ok) return { ok: false, reason: argv.reason };
  return checkLaunch(argv.argv);
}
