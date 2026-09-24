import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type Interfaces, resolveBindHost } from "../hub/netif.js";
import { PortError } from "../hub/port.js";
import { startHub } from "../hub/server.js";
import { resolveTailscale } from "../hub/tailscale.js";
import { tailscaleWhois, type Whois } from "../hub/whois.js";
import { HubClient } from "../channel/client.js";
import { ConfigError, hubAllow, loadHub, loadIdentity, loadPeers, paths, relayHome, resolveEndpoint } from "../channel/config.js";
import { checkLaunch, findClaudeArgv, type LaunchCheck, type ProcLookup } from "../channel/launch.js";
import { createChannelServer } from "../channel/server.js";
import type { InboundFrame } from "../protocol/receive.js";
import type { Io } from "./io.js";

export interface HubDeps {
  interfaces?: Interfaces;
  // Overridable so tailscale-mode hub() can be tested without a real
  // tailscale binary; defaults to the real resolveTailscale.
  resolveTailscale?: typeof resolveTailscale;
}

// Node's net/http listen() attaches address/port to the error it emits, but
// NodeJS.ErrnoException doesn't declare them.
interface ListenErrno extends NodeJS.ErrnoException {
  address?: string;
  port?: number;
}

// Node reports a listen/bind failure's errno without a human-readable summary;
// spell out the common ones so the message doesn't force the operator to look
// up EADDRINUSE.
function describeListenErrno(code: string | undefined): string {
  switch (code) {
    case "EADDRINUSE":
      return "address already in use";
    case "EACCES":
      return "permission denied";
    case "EADDRNOTAVAIL":
      return "address not available";
    default:
      return "listen failed";
  }
}

export async function hub(io: Io, deps: HubDeps = {}): Promise<number> {
  const home = relayHome(io.env);
  const self = loadIdentity(home);
  const peers = loadPeers(home, self);
  const config = loadHub(home);
  if (!config) {
    throw new ConfigError(
      `this machine was set up as a guest (${paths(home).hub} is missing): the hub runs on the host machine, not here`,
      "missing",
    );
  }
  const host = resolveBindHost(config.mode, {
    ...(config.iface !== undefined ? { iface: config.iface } : {}),
    ...(deps.interfaces ? { interfaces: deps.interfaces } : {}),
  });
  let whois: Whois | undefined;
  if (config.mode === "tailscale") {
    const { bin } = await (deps.resolveTailscale ?? resolveTailscale)();
    whois = tailscaleWhois({ bin, onError: (why) => io.err(`cc-relay hub: ${why}`) });
  }
  let running: Awaited<ReturnType<typeof startHub>>;
  try {
    running = await startHub({
      mode: config.mode,
      host,
      port: config.port,
      path: config.path,
      hubId: self.signPub,
      allow: hubAllow(self, peers, config.tailscaleLogin),
      ...(whois ? { whois } : {}),
    });
  } catch (err) {
    // Node sets .syscall to "listen"/"bind" only for a failure of that actual
    // call (EADDRINUSE, EACCES, EADDRNOTAVAIL, ...); anything else (a bad
    // whois binary, a wiring bug) must keep its stack, not read as a port problem.
    const errno = err as ListenErrno;
    if (errno?.syscall === "listen" || errno?.syscall === "bind") {
      const boundHost = errno.address ?? host;
      const boundPort = errno.port ?? config.port;
      const hint = errno.code === "EADDRINUSE" ? "; is another cc-relay hub running?" : "";
      throw new PortError(
        `cannot listen on ${boundHost}:${boundPort}: ${describeListenErrno(errno.code)} (${errno.code})${hint}`,
        { cause: err },
      );
    }
    throw err;
  }
  // Call until() (which registers the SIGINT/SIGTERM handlers synchronously)
  // before printing the listening line: anyone watching stdout for that line
  // must not be able to send a signal that arrives before the handler does.
  const stopped = io.until();
  io.out(`cc-relay hub listening on ${host}:${running.port} (${config.mode} mode, ${peers.length} peer${peers.length === 1 ? "" : "s"})`);
  try {
    await stopped;
  } finally {
    await running.close();
  }
  io.out("cc-relay hub stopped");
  return 0;
}

export interface ChannelRunDeps {
  // Tests pass an in-memory transport; Claude Code talks to the real one over stdio.
  transport?: Transport;
  ppid?: number;
  lookup?: ProcLookup;
  interfaces?: Interfaces;
}

// stdout belongs to the MCP transport: everything human-readable goes to stderr,
// which Claude Code keeps in its MCP log.
export async function channel(io: Io, deps: ChannelRunDeps = {}): Promise<number> {
  const home = relayHome(io.env);
  const self = loadIdentity(home);
  const peers = loadPeers(home, self);
  const endpoint = resolveEndpoint(home, self, peers, (mode, iface) =>
    resolveBindHost(mode, {
      ...(iface !== undefined ? { iface } : {}),
      ...(deps.interfaces ? { interfaces: deps.interfaces } : {}),
    }),
  );
  // The claude ancestor's argv is found once, since a process's argv can't
  // change; but its --settings file can be edited mid-session, so checkLaunch
  // re-reads it on every call rather than caching the result here. That can
  // only take permission away, though, never grant it: nothing shows Claude
  // Code reloads a --settings file after startup, so a session that started
  // without the ask rule keeps the settings it loaded, whatever the file says
  // later, and must stay blocked for its whole lifetime rather than unblock
  // the moment the file looks right.
  const argv = findClaudeArgv(deps.ppid ?? process.ppid, deps.lookup);
  const initial: LaunchCheck = argv.ok
    ? checkLaunch(argv.argv)
    : { ok: false, reason: argv.kind === "no-ancestor" ? "not running under a claude process" : argv.reason };
  if (!initial.ok) io.err(`cc-relay: send is blocked: ${initial.reason}`);
  const launch = (): LaunchCheck => (initial.ok && argv.ok ? checkLaunch(argv.argv) : initial);

  // Replaced by created.deliver below, before client.start() begins passing
  // inbound frames through onMessage; no frame can reach this placeholder.
  let deliver: (frame: InboundFrame) => Promise<void> = async () => {};
  const client = new HubClient({
    url: endpoint.url,
    hubId: endpoint.hubId,
    identity: self,
    onMessage: (frame) => void deliver(frame),
    log: io.err,
  });
  const created = createChannelServer({ identity: self, peers, hub: client, launch, now: Date.now, log: io.err });
  deliver = created.deliver;
  await created.server.connect(deps.transport ?? new StdioServerTransport());
  client.start();
  try {
    await io.until();
  } finally {
    client.stop();
    await created.server.close();
  }
  return 0;
}
