import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

export const SEND_TOOL = "mcp__cc-relay__send";

export type LaunchCheck = { ok: true; settings: string } | { ok: false; reason: string };

export interface ProcInfo {
  ppid: number;
  args: string;
}

export type ProcLookup = (pid: number) => ProcInfo | null;

export const psLookup: ProcLookup = (pid) => {
  let out: string;
  try {
    out = execFileSync("ps", ["-o", "ppid=,args=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
  } catch {
    return null;
  }
  const m = /^\s*(\d+)\s+(.*)$/.exec(out.trimEnd());
  return m ? { ppid: Number(m[1]), args: m[2] as string } : null;
};

function isClaude(tokens: readonly string[]): boolean {
  const first = basename(tokens[0] ?? "");
  if (first === "claude") return true;
  // An npm install runs the CLI as `node <...>/claude`.
  return first === "node" && basename(tokens[1] ?? "") === "claude";
}

// `ps` joins argv with spaces, so an argument containing a space can't be
// recovered exactly. That's acceptable here because every failure mode of a
// lossy split is a failed check (blocked), never a false pass.
export function findClaudeArgv(startPid: number, lookup: ProcLookup = psLookup, maxDepth = 8): string[] | null {
  let pid = startPid;
  for (let depth = 0; depth < maxDepth && pid > 1; depth++) {
    const info = lookup(pid);
    if (!info) return null;
    const tokens = info.args.split(/\s+/).filter((t) => t !== "");
    if (isClaude(tokens)) return tokens;
    pid = info.ppid;
  }
  return null;
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
    return `--settings ${value.startsWith("{") ? "(inline)" : value} is not valid JSON`;
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
  let found: string | undefined;
  for (const value of settings) {
    const perms = permissionsOf(value, read);
    if (typeof perms === "string") return { ok: false, reason: perms };
    if (perms.defaultMode === "bypassPermissions") {
      return { ok: false, reason: `--settings ${value} sets defaultMode bypassPermissions` };
    }
    if (Array.isArray(perms.ask) && perms.ask.includes(SEND_TOOL)) found ??= value;
  }
  if (found === undefined) return { ok: false, reason: `no --settings file has permissions.ask ["${SEND_TOOL}"]` };
  return { ok: true, settings: found };
}

// Run once at channel start; a session can't change its own argv afterwards.
export function checkThisSession(ppid: number = process.ppid, lookup: ProcLookup = psLookup): LaunchCheck {
  const argv = findClaudeArgv(ppid, lookup);
  if (!argv) return { ok: false, reason: "not running under a claude process" };
  return checkLaunch(argv);
}
