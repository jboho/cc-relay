import { existsSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { type HubMode } from "../hub/bind.js";
import { resolveBindHost } from "../hub/netif.js";
import { generatePath, pickPort } from "../hub/port.js";
import { cardFor, decodeCard, encodeCard, fingerprint } from "../protocol/card.js";
import { generateIdentity } from "../protocol/identity.js";
import {
  ConfigError,
  ensureHome,
  type HubConfig,
  hubEndpoint,
  loadHub,
  loadIdentity,
  loadLink,
  loadPeers,
  makePeer,
  paths,
  relayHome,
  removeLink,
  saveHub,
  saveLink,
  savePeers,
  validateHub,
  validatePeers,
  writeIdentity,
  writeJsonAtomic,
} from "../channel/config.js";
import { SEND_TOOL } from "../channel/launch.js";
import { type Io, UsageError } from "./io.js";

// disableBypassPermissionsMode is defense in depth: the launch check already
// refuses the bypass flags, and this makes Claude Code itself refuse them too.
// Documented to work from any settings scope, including --settings.
export function relaySettings(): unknown {
  return { permissions: { ask: [SEND_TOOL], disableBypassPermissionsMode: "disable" } };
}

export function mcpConfig(io: Io, home: string): unknown {
  return {
    mcpServers: {
      "cc-relay": { command: io.nodePath, args: [io.cliPath, "channel"], env: { CC_RELAY_HOME: home } },
    },
  };
}

export function launchAlias(home: string): string {
  const p = paths(home);
  return `alias claude-relay='claude --mcp-config ${p.mcp} --settings ${p.settings} --permission-mode manual --dangerously-load-development-channels server:cc-relay'`;
}

export interface InitOptions {
  alias: string;
  host?: boolean;
  mode?: HubMode;
  name?: string;
  iface?: string;
  port?: number;
  tailscaleLogin?: string;
}

async function hubConfigFor(opts: InitOptions): Promise<HubConfig> {
  const mode = opts.mode ?? "lan";
  if (mode === "tailscale" && !opts.tailscaleLogin) {
    throw new UsageError("tailscale mode needs --tailscale-login <this machine's Tailscale login>");
  }
  const bind = resolveBindHost(mode, opts.iface !== undefined ? { iface: opts.iface } : {});
  const port = opts.port ?? (await pickPort(bind));
  const name = opts.name ?? (mode === "lan" ? hostname() : bind);
  return {
    v: 1,
    mode,
    port,
    path: generatePath(),
    name,
    ...(opts.iface !== undefined ? { iface: opts.iface } : {}),
    ...(opts.tailscaleLogin !== undefined ? { tailscaleLogin: opts.tailscaleLogin } : {}),
  };
}

export async function init(io: Io, opts: InitOptions): Promise<number> {
  if (!opts.host && (opts.mode || opts.name || opts.iface || opts.port || opts.tailscaleLogin)) {
    throw new UsageError("--mode, --name, --iface, --port and --tailscale-login only apply with --host");
  }
  const home = relayHome(io.env);
  ensureHome(home);
  const p = paths(home);
  // The identity is the only file that means "initialised": writeIdentity
  // itself refuses to overwrite one. Guarding on peers.json too would make a
  // run that got that far before a later write failed (ENOSPC, EACCES) claim
  // to be already initialised forever, with no identity a re-run could use.
  if (existsSync(p.identity)) throw new ConfigError(`already initialised: ${p.identity} exists`, "exists");
  // Everything that can fail on bad input runs before the first write, and the
  // identity goes last: a failed init leaves no identity, so a re-run works.
  const hub = opts.host ? validateHub(await hubConfigFor(opts)) : undefined;
  const identity = generateIdentity(opts.alias);
  // Only write peers.json if it isn't already there, so a retry never wipes
  // peers a partially-completed earlier run had already stored. A kept file
  // still has to fit the new identity though (e.g. its own alias can't match
  // a peer already on the list, left over from an earlier attempt under a
  // different alias) -- loadPeers runs the same checkPeers validation
  // savePeers would, so a bad fit is refused here with the same clear message
  // loadPeers already gives, instead of a separate validatePeers call that
  // would just duplicate it.
  if (existsSync(p.peers)) loadPeers(home, identity);
  else savePeers(home, identity, []);
  writeJsonAtomic(p.settings, relaySettings());
  writeJsonAtomic(p.mcp, mcpConfig(io, home));
  // A retry without --host clears any hub.json left by an earlier failed
  // --host attempt, so the machine doesn't silently keep acting as a host.
  if (hub) saveHub(home, hub);
  else rmSync(p.hub, { force: true });
  writeIdentity(home, identity);

  io.out(`cc-relay initialised in ${home} as ${identity.alias}`);
  io.out(`fingerprint: ${fingerprint(identity.signPub, identity.boxPub)}`);
  if (hub) io.out(`hub: ${hub.mode} mode, guests dial ${hub.name}:${hub.port}`);
  io.out("Add this to ~/.zshrc, then start relay sessions with claude-relay:");
  io.out(launchAlias(home));
  io.out("Next: send your card (cc-relay card) to a peer, and add theirs with cc-relay add.");
  return 0;
}

export function card(io: Io): number {
  const home = relayHome(io.env);
  const identity = loadIdentity(home);
  const hub = loadHub(home);
  io.out(encodeCard(cardFor(identity, hub ? hubEndpoint(hub) : undefined)));
  // stderr, so `cc-relay card | pbcopy` copies only the card.
  io.err(`fingerprint: ${fingerprint(identity.signPub, identity.boxPub)} (read it to your peer when they add the card)`);
  return 0;
}

// People read fingerprints aloud and retype them; dashes, spaces and case
// carry no information.
const normalizeFp = (fp: string) => fp.replace(/[\s-]/g, "").toLowerCase();

export interface AddOptions {
  card: string;
  confirm?: string;
  via?: "lan" | "tailscale";
  tailscaleLogin?: string;
}

export function add(io: Io, opts: AddOptions): number {
  const home = relayHome(io.env);
  const peerCard = decodeCard(opts.card);
  const fp = fingerprint(peerCard.signPub, peerCard.boxPub);
  if (opts.confirm === undefined) {
    io.err(`card for ${peerCard.alias}, fingerprint ${fp}`);
    io.err("Check this fingerprint with them over a channel you trust (a call, in person), then re-run with --confirm <fingerprint>.");
    return 2;
  }
  if (normalizeFp(opts.confirm) !== normalizeFp(fp)) {
    io.err(`fingerprint mismatch: the card says ${fp}, you confirmed ${opts.confirm}. Nothing was added.`);
    return 1;
  }
  const self = loadIdentity(home);
  const peers = loadPeers(home, self);
  const hub = loadHub(home);
  if (hub?.mode === "tailscale" && opts.tailscaleLogin === undefined) {
    throw new UsageError("this hub runs in tailscale mode: pass --tailscale-login <the peer's Tailscale login>");
  }
  if (hub?.mode !== "tailscale" && opts.tailscaleLogin !== undefined) {
    throw new UsageError("--tailscale-login only applies when this machine's own hub runs in tailscale mode");
  }
  const peer = makePeer({
    alias: peerCard.alias,
    signPub: peerCard.signPub,
    boxPub: peerCard.boxPub,
    ...(opts.tailscaleLogin !== undefined ? { tailscaleLogin: opts.tailscaleLogin } : {}),
  });

  let link: Parameters<typeof saveLink>[1] | undefined;
  if (peerCard.hub) {
    if (hub) throw new ConfigError("that is a hub card, and this machine runs its own hub; a machine is a host or a guest", "invalid");
    const offered = (["lan", "tailscale"] as const).filter((k) => peerCard.hub?.[k] !== undefined);
    const via = opts.via ?? (offered.length === 1 ? offered[0] : undefined);
    if (via === undefined) throw new UsageError(`the card offers ${offered.join(" and ")}: pass --via lan or --via tailscale`);
    const host = peerCard.hub[via];
    if (host === undefined) throw new UsageError(`the card has no ${via} address`);
    const existing = loadLink(home);
    if (existing && existing.hubId !== peer.id) {
      throw new ConfigError("already linked to another hub; remove that peer first", "invalid");
    }
    link = { v: 1, hubId: peer.id, via, host, port: peerCard.hub.port, path: peerCard.hub.path };
  } else if (opts.via !== undefined) {
    throw new UsageError("--via only applies to a hub card");
  }

  // Validate the complete peer list before touching any file: a duplicate
  // alias/key or an invalid stored field (e.g. a malformed tailscaleLogin)
  // must fail before link.json is written, or a rejected add would leave a
  // link to a hub whose owner was never actually stored as a peer.
  validatePeers(home, self, [...peers, peer]);
  savePeers(home, self, [...peers, peer]);
  if (link) saveLink(home, link);
  io.out(`added ${peer.alias} (${fp})${link ? `, hub at ${link.host}:${link.port} via ${link.via}` : ""}`);
  io.out(hub ? "Restart cc-relay hub and any relay sessions to pick up the new peer." : "Restart any relay sessions to pick up the new peer.");
  return 0;
}

export function remove(io: Io, alias: string): number {
  const home = relayHome(io.env);
  const self = loadIdentity(home);
  const peers = loadPeers(home, self);
  const target = peers.find((p) => p.alias === alias);
  if (!target) {
    io.err(`cc-relay: no peer named ${alias}`);
    return 1;
  }
  savePeers(home, self, peers.filter((p) => p !== target));
  if (loadLink(home)?.hubId === target.id) {
    removeLink(home);
    io.out(`removed ${alias} and the link to their hub`);
  } else {
    io.out(`removed ${alias}`);
  }
  // The hub reads its allowlist only at startup (run.ts's hub()): removing a
  // peer here doesn't drop them from an already-running hub until it restarts.
  const hub = loadHub(home);
  if (hub) io.out(`Restart cc-relay hub to drop ${alias} from its allowlist; until then the hub still accepts them.`);
  io.out("Restart any relay sessions to pick up the change.");
  return 0;
}

export function list(io: Io): number {
  const home = relayHome(io.env);
  const self = loadIdentity(home);
  const peers = loadPeers(home, self);
  const hub = loadHub(home);
  const link = loadLink(home);
  io.out(`you: ${self.alias}  ${fingerprint(self.signPub, self.boxPub)}`);
  if (hub) io.out(`hub: ${hub.mode} mode, guests dial ${hub.name}:${hub.port}`);
  else if (link) io.out(`linked to ${peers.find((p) => p.id === link.hubId)?.alias ?? "an unknown peer"}'s hub at ${link.host}:${link.port} via ${link.via}`);
  else io.out("no hub: run cc-relay init --host, or add a host's card");
  if (peers.length === 0) io.out("no peers yet");
  for (const p of peers) {
    io.out(`${p.alias}  ${fingerprint(p.signPub, p.boxPub)}${p.tailscaleLogin ? `  ${p.tailscaleLogin}` : ""}`);
  }
  return 0;
}
