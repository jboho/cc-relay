import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type Interfaces, resolveBindHost } from "../hub/netif.js";
import { PortError } from "../hub/port.js";
import { startHub } from "../hub/server.js";
import { resolveTailscale } from "../hub/tailscale.js";
import { tailscaleWhois, type Whois } from "../hub/whois.js";
import { HubClient } from "../channel/client.js";
import { ConfigError, hubAllow, loadHub, loadIdentity, loadPeers, paths, relayHome, resolveEndpoint } from "../channel/config.js";
import { checkThisSession, type ProcLookup } from "../channel/launch.js";
import { createChannelServer } from "../channel/server.js";
import type { InboundFrame } from "../protocol/receive.js";
import type { Io } from "./io.js";

export interface HubDeps {
  interfaces?: Interfaces;
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
  if (!config) throw new ConfigError(`no hub on this machine (${paths(home).hub} is missing): run cc-relay init --host`, "missing");
  const host = resolveBindHost(config.mode, {
    ...(config.iface !== undefined ? { iface: config.iface } : {}),
    ...(deps.interfaces ? { interfaces: deps.interfaces } : {}),
  });
  let whois: Whois | undefined;
  if (config.mode === "tailscale") {
    const { bin } = await resolveTailscale();
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
  io.out(`cc-relay hub listening on ${host}:${running.port} (${config.mode} mode, ${peers.length} peer${peers.length === 1 ? "" : "s"})`);
  try {
    await io.until();
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
  const launch = checkThisSession(deps.ppid ?? process.ppid, deps.lookup);
  if (!launch.ok) io.err(`cc-relay: send is blocked: ${launch.reason}`);

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
