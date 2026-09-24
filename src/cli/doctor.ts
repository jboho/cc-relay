import { existsSync, readFileSync } from "node:fs";
import { type Interfaces, resolveBindHost } from "../hub/netif.js";
import { resolveTailscale, type ResolvedTailscale } from "../hub/tailscale.js";
import {
  checkPrivate,
  type HubConfig,
  type LinkConfig,
  loadHub,
  loadIdentity,
  loadLink,
  loadPeers,
  paths,
  relayHome,
  resolveEndpoint,
  type StoredPeer,
} from "../channel/config.js";
import { checkLaunch, findClaudeArgv, type ProcLookup } from "../channel/launch.js";
import { fingerprint } from "../protocol/card.js";
import type { Identity } from "../protocol/identity.js";
import type { Io } from "./io.js";
import { canConnect, probeHub, type ProbeOutcome, sntpOffset } from "./probe.js";

export type Status = "PASS" | "WARN" | "FAIL" | "SKIP";

export interface Check {
  status: Status;
  name: string;
  detail: string;
}

export interface DoctorDeps {
  ppid?: number;
  lookup?: ProcLookup;
  clockOffset?: () => Promise<number | null>;
  tailscale?: () => Promise<ResolvedTailscale>;
  probe?: (url: string, hubId: Uint8Array, self: Identity) => Promise<ProbeOutcome>;
  connectable?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  interfaces?: Interfaces;
  fileExists?: (path: string) => boolean;
}

export const CLOCK_WARN_S = 5;
// Matches the hub's HELLO_SKEW_MS: past this, every hello is rejected.
export const CLOCK_FAIL_S = 60;
// Services a Tailscale grant scoped to the hub's port must not expose:
// ssh, smb, afp, Apple Remote Desktop, vnc, and a common dev server.
export const GRANT_PROBE_PORTS = [22, 445, 548, 3283, 5900, 8080] as const;
const GRANT_PROBE_TIMEOUT_MS = 1500;

const PROBE_DETAIL: Record<Exclude<ProbeOutcome, "ok" | "unreachable">, string> = {
  refused: "connection refused: is cc-relay hub running on the host?",
  timeout: "no answer: check the Wi-Fi allows device-to-device traffic (client isolation), the host's firewall, and that the host is awake",
  unresolved: "the hub's host name doesn't resolve on this network",
  notfound: "the hub answered 404: the path is wrong, so re-add the host's current card",
  rejected: "the hub closed the connection: this machine isn't on its allowlist, the clocks differ by over 60 s, or the Tailscale login doesn't match",
};

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function runChecks(io: Io, deps: DoctorDeps = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (status: Status, name: string, detail: string) => checks.push({ status, name, detail });
  const home = relayHome(io.env);
  const p = paths(home);
  const fileExists = deps.fileExists ?? existsSync;

  try {
    checkPrivate(home, "relay home");
    add("PASS", "home", `${home} is private`);
  } catch (err) {
    add("FAIL", "home", errMessage(err));
  }

  let self: Identity | undefined;
  try {
    self = loadIdentity(home);
    add("PASS", "identity", `${self.alias}  ${fingerprint(self.signPub, self.boxPub)}`);
  } catch (err) {
    add("FAIL", "identity", errMessage(err));
  }

  let peers: StoredPeer[] | undefined;
  if (self) {
    try {
      peers = loadPeers(home, self);
      if (peers.length === 0) add("WARN", "peers", "no peers yet: add a card with cc-relay add");
      else add("PASS", "peers", `${peers.length}: ${peers.map((x) => x.alias).join(", ")}`);
    } catch (err) {
      add("FAIL", "peers", errMessage(err));
    }
  } else {
    add("SKIP", "peers", "needs a valid identity");
  }

  const settings = checkLaunch(["claude", "--settings", p.settings]);
  if (!settings.ok) {
    add("FAIL", "settings", settings.reason);
  } else {
    try {
      const parsed = JSON.parse(readFileSync(p.settings, "utf8"));
      if (parsed.permissions?.disableBypassPermissionsMode !== "disable") {
        add("WARN", "settings", `asks before every send, but ${p.settings} doesn't set permissions.disableBypassPermissionsMode to "disable"`);
      } else {
        add("PASS", "settings", "asks before every send, and bypass mode is disabled");
      }
    } catch (err) {
      add("FAIL", "settings", errMessage(err));
    }
  }

  checks.push(checkMcp(home, fileExists));

  const argv = findClaudeArgv(deps.ppid ?? process.ppid, deps.lookup);
  if (!argv.ok && argv.noAncestor) {
    add("SKIP", "session", "not run from a claude session; to check a relay session's launch flags, run `! cc-relay doctor` inside it");
  } else if (!argv.ok) {
    add("FAIL", "session", argv.reason);
  } else {
    const launch = checkLaunch(argv.argv);
    if (launch.ok) add("PASS", "session", `this session asks before every send (${launch.settings})`);
    else add("FAIL", "session", `${launch.reason}; send is blocked in this session`);
  }

  const offset = await (deps.clockOffset ?? sntpOffset)();
  if (offset === null) add("WARN", "clock", `couldn't reach a time server; the hub rejects clocks more than ${CLOCK_FAIL_S} s apart`);
  else if (Math.abs(offset) > CLOCK_FAIL_S) add("FAIL", "clock", `off by ${offset.toFixed(1)} s; the hub will reject this machine. Turn on Set time automatically`);
  else if (Math.abs(offset) > CLOCK_WARN_S) add("WARN", "clock", `off by ${offset.toFixed(1)} s; turn on Set time automatically`);
  else add("PASS", "clock", `off by ${offset.toFixed(3)} s`);

  let hub: HubConfig | undefined;
  let link: LinkConfig | undefined;
  try {
    hub = loadHub(home);
    link = loadLink(home);
  } catch (err) {
    add("FAIL", "hub", errMessage(err));
    return checks;
  }

  if (hub?.mode === "tailscale" || link?.via === "tailscale") {
    try {
      const ts = await (deps.tailscale ?? (() => resolveTailscale()))();
      add("PASS", "tailscale", `${ts.bin} (${ts.version})`);
    } catch (err) {
      add("FAIL", "tailscale", errMessage(err));
    }
  } else {
    add("SKIP", "tailscale", "this machine doesn't use Tailscale");
  }

  if (!self || !peers) {
    add("SKIP", "hub", "needs a valid identity and peers file");
    return checks;
  }
  let endpoint;
  try {
    endpoint = resolveEndpoint(home, self, peers, (mode, iface) =>
      resolveBindHost(mode, {
        ...(iface !== undefined ? { iface } : {}),
        ...(deps.interfaces ? { interfaces: deps.interfaces } : {}),
      }),
    );
  } catch (err) {
    add("FAIL", "hub", errMessage(err));
    return checks;
  }
  const outcome = await (deps.probe ?? probeHub)(endpoint.url, endpoint.hubId, self);
  if (outcome === "ok") add("PASS", "hub", `${endpoint.url.replace(/\/[^/]*$/, "/…")} accepted this machine's hello`);
  else if (outcome === "unreachable") {
    // No error text survives past probeHub's ProbeOutcome return type, so this stays
    // generic rather than carrying the raw socket error (EHOSTDOWN, EPERM, ...).
    const hostPort = /^ws:\/\/([^/]+)\//.exec(endpoint.url)?.[1] ?? endpoint.url;
    add("FAIL", "hub", `could not reach ${hostPort} (network error): check Tailscale/LAN connectivity and the macOS Local Network permission`);
  } else add("FAIL", "hub", PROBE_DETAIL[outcome]);

  if (link?.via === "tailscale") {
    // canConnect returns false both for "closed" and for "never got there", so an
    // all-false scan can't tell a clean grant from an unreachable host. Gate on the
    // hub probe's outcome with an allowlist, not a denylist: only outcomes that prove
    // a TCP connection actually reached the host count as reached. Any other or future
    // outcome (unreachable, or one not yet invented) skips rather than risks a false PASS.
    const reached = outcome === "ok" || outcome === "refused" || outcome === "notfound" || outcome === "rejected";
    if (!reached) {
      add("SKIP", "grant", `could not reach ${link.host}; grant not verified`);
    } else {
      const connectable = deps.connectable ?? canConnect;
      const ports = GRANT_PROBE_PORTS.filter((port) => port !== link.port);
      const open: number[] = [];
      for (const port of ports) {
        if (await connectable(link.host, port, GRANT_PROBE_TIMEOUT_MS)) open.push(port);
      }
      if (open.length > 0) {
        add("FAIL", "grant", `${link.host} also accepts ports ${open.join(", ")} from this machine; ask the host to scope the Tailscale grant to tcp:${link.port}`);
      } else {
        add("PASS", "grant", `${link.host} exposes none of ${ports.join(", ")} to this machine`);
      }
    }
  }
  return checks;
}

function checkMcp(home: string, fileExists: (path: string) => boolean): Check {
  const path = paths(home).mcp;
  const fail = (detail: string): Check => ({ status: "FAIL", name: "mcp", detail: `${path}: ${detail}` });
  let entry: { command?: unknown; args?: unknown; env?: { CC_RELAY_HOME?: unknown } } | undefined;
  try {
    entry = JSON.parse(readFileSync(path, "utf8"))?.mcpServers?.["cc-relay"];
  } catch (err) {
    return fail(errMessage(err));
  }
  if (!entry) return fail('no "cc-relay" server');
  if (typeof entry.command !== "string" || !fileExists(entry.command)) return fail(`command ${String(entry.command)} doesn't exist`);
  const args = Array.isArray(entry.args) ? entry.args : [];
  if (typeof args[0] !== "string" || !fileExists(args[0])) return fail(`${String(args[0])} doesn't exist; re-run cc-relay init after moving the install`);
  if (args[1] !== "channel" || args.length !== 2) return fail(`args must be [<cli>, "channel"]`);
  if (entry.env?.CC_RELAY_HOME !== home) return fail(`env.CC_RELAY_HOME must be ${home}`);
  return { status: "PASS", name: "mcp", detail: `launches ${args[0]} channel` };
}

export async function doctor(io: Io, deps: DoctorDeps = {}): Promise<number> {
  const checks = await runChecks(io, deps);
  for (const c of checks) io.out(`${c.status.padEnd(4)}  ${c.name}: ${c.detail}`);
  return checks.some((c) => c.status === "FAIL") ? 1 : 0;
}
