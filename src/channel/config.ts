import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { HubMode } from "../hub/bind.js";
import type { AllowedPeer } from "../hub/handshake.js";
import { HOST_RE, HUB_PATH_RE, type HubEndpoint } from "../protocol/card.js";
import { fromB64u, toB64u } from "../protocol/encoding.js";
import { ALIAS_RE, type Identity, IdentityError, parseIdentity, peerId, serializeIdentity } from "../protocol/identity.js";
import type { Peer } from "../protocol/receive.js";

export type ConfigErrorCode = "missing" | "exists" | "permissions" | "invalid";

export class ConfigError extends Error {
  override name = "ConfigError";
  constructor(
    message: string,
    readonly code: ConfigErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export const MAX_PEERS = 16;

// Whitespace is refused because the launch check recovers --settings from
// `ps` output, which joins argv with spaces: a path containing one can't be
// split back apart, so every relay session would be blocked.
export function relayHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const dir = env.CC_RELAY_HOME ?? join(home, ".config", "cc-relay");
  if (!isAbsolute(dir)) throw new ConfigError(`CC_RELAY_HOME must be an absolute path, got ${JSON.stringify(dir)}`, "invalid");
  if (/\s/.test(dir)) throw new ConfigError(`the cc-relay home must not contain whitespace: ${JSON.stringify(dir)}`, "invalid");
  return dir;
}

export const paths = (home: string) => ({
  identity: join(home, "identity.json"),
  peers: join(home, "peers.json"),
  hub: join(home, "hub.json"),
  link: join(home, "link.json"),
  settings: join(home, "settings.json"),
  mcp: join(home, "mcp.json"),
});

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code;
}

// The home holds the secret keys, so group/other access is refused rather than
// silently repaired: a loosened mode means something outside cc-relay touched it.
// Known limitation: this checks POSIX mode bits only; macOS ACLs (see `ls -le`)
// can grant access beyond the mode and are not inspected.
// `kind` rejects a mismatched filesystem object (a directory standing in for a
// config file, or vice versa) before anything tries to read it.
//
// Opens the path itself (rather than lstat-then-open) so a check and a
// subsequent read can share one fd: a separate lstat followed by a later open
// leaves a window where the path can be swapped for a symlink in between
// (TOCTOU). O_NOFOLLOW makes that swap fail closed (ELOOP) instead of quietly
// following it. O_NONBLOCK keeps a FIFO standing in for a config file from
// hanging this open() forever waiting for a writer; it's ignored for regular
// files and directories, so it has no effect on the common case.
function openPrivate(path: string, what: string, kind: "directory" | "file"): number {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    if (isErrno(err, "ENOENT")) throw new ConfigError(`${what} ${path} does not exist; run cc-relay init`, "missing", { cause: err });
    if (isErrno(err, "ELOOP")) throw new ConfigError(`${what} ${path} is a symlink; refusing to follow it`, "permissions", { cause: err });
    if (isErrno(err, "EACCES") || isErrno(err, "EPERM")) throw new ConfigError(`${what} ${path} is not accessible`, "permissions", { cause: err });
    if (isErrno(err, "ENOTDIR")) throw new ConfigError(`${what} ${path} is not accessible: a path segment is not a directory`, "invalid", { cause: err });
    throw err;
  }
  try {
    const st = fstatSync(fd);
    const matches = kind === "directory" ? st.isDirectory() : st.isFile();
    if (!matches) throw new ConfigError(`${what} ${path} is not a ${kind}`, "invalid");
    if ((st.mode & 0o077) !== 0) {
      throw new ConfigError(
        `${what} ${path} is accessible by other users (mode ${(st.mode & 0o777).toString(8)}); run chmod go-rwx ${path}`,
        "permissions",
      );
    }
    // Belt-and-braces alongside the mode check above: a file this user doesn't
    // own but happens to be readable some other way (e.g. an ACL, see the
    // limitation noted above) shouldn't be trusted as this identity's own.
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) {
      throw new ConfigError(`${what} ${path} is not owned by this user`, "permissions");
    }
    return fd;
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

// Defaults to "directory": doctor and other external callers still call this
// with the pre-existing two-argument shape to check a home folder.
export function checkPrivate(path: string, what: string, kind: "directory" | "file" = "directory"): void {
  closeSync(openPrivate(path, what, kind));
}

export function ensureHome(home: string): void {
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (isErrno(err, "ENOTDIR")) {
      throw new ConfigError(`cannot create cc-relay home ${home}: a path segment is not a directory (${code})`, "invalid", { cause: err });
    }
    if (isErrno(err, "EACCES") || isErrno(err, "EPERM")) {
      throw new ConfigError(`cannot create cc-relay home ${home} (${code})`, "permissions", { cause: err });
    }
    throw err;
  }
  checkPrivate(home, "cc-relay home", "directory");
}

// Readers never see a half-written file: write a private temp file, then rename
// over the target (atomic within one directory). Flushing the temp file before
// the rename, and fsyncing the directory after it, guards against a crash
// losing the write or the rename's directory-entry update (no test: this only
// shows up after a real crash/power loss, which nothing in this suite can
// simulate). A short write can't be tested reliably either (it needs a full
// disk or a quota mid-write), so it's covered by using writeFileSync's own
// flush rather than a manual write loop: writeFileSync always writes the
// entire buffer or throws, unlike a single writeSync call, which can return
// having written fewer bytes than given and silently leave the rest off disk.
// Probed against this repo's Node (22.13.1): writeFileSync's flush option is
// supported and does write-then-fsync in one call, so there's no separate fd
// to leak or double-close on the way out.
export function writeJsonAtomic(path: string, value: unknown): void {
  checkPrivate(dirname(path), "cc-relay home", "directory");
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    // Buffer, not a string: writeFileSync's C++ fast path for a plain-string,
    // default-utf8 write bypasses both the write loop and flush entirely, so
    // a string here would silently skip the guarantees the comment above claims.
    writeFileSync(tmp, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), { mode: 0o600, flag: "wx", flush: true });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  // A plain fsync on macOS only reaches the drive's write cache, not the
  // platter/NAND itself (that needs F_FULLFSYNC); this is best-effort
  // durability against a process or OS crash, not against a power loss.
  const dirFd = openSync(dirname(path), fsConstants.O_RDONLY);
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

// A missing home or a missing file both read as "absent" (no folder means no
// file, same as before the home was checked at all), so callers like doctor
// can probe a not-yet-initialised machine without hitting an error. A home or
// file that exists but is loose, or is a symlink, still throws "permissions".
function readJson(path: string, what: string): unknown | undefined {
  try {
    checkPrivate(dirname(path), "cc-relay home", "directory");
  } catch (err) {
    if (err instanceof ConfigError && err.code === "missing") return undefined;
    throw err;
  }
  let fd: number;
  try {
    fd = openPrivate(path, what, "file");
  } catch (err) {
    if (err instanceof ConfigError && err.code === "missing") return undefined;
    throw err;
  }
  // Reading from the same fd that openPrivate validated (rather than a fresh
  // readFileSync(path)) is what closes the TOCTOU window: nothing can swap the
  // path for something else between the check and the read. Not covered by a
  // test: exercising the race would need a second process swapping the path
  // mid-syscall, which this suite has no way to simulate; reverting to
  // readFileSync(path) here still passes every test in this file.
  // No EACCES/EPERM mapping here: openPrivate already mapped that at open time
  // above, and a permission check on an already-open fd can't fail again on
  // read (POSIX enforces permissions at open(), not per read()).
  let text: string;
  try {
    text = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${what} ${path} is not valid JSON`, "invalid", { cause: err });
  }
}

function parseWith<T>(schema: z.ZodType<T>, raw: unknown, path: string, what: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new ConfigError(`${what} ${path} is invalid: ${detail}`, "invalid", { cause: parsed.error });
  }
  return parsed.data;
}

// ---- identity ----

// Written via a temp file + linkSync rather than writeFileSync's "wx" flag:
// linkSync's EEXIST is the same atomic create-if-not-exists guarantee (an
// existing identity is never overwritten, so its secret keys can never be
// silently lost), but leaves the write itself off the final path until the
// link succeeds. No fsync here (unlike writeJsonAtomic): out of scope for
// this change.
// A crash between the writeFileSync and the linkSync leaves the temp file
// behind: a 0600 identity.json.tmp-* holding the secret key, inside the
// already-private home directory. Not cleaned up by anything today; a future
// pass over the home could remove stale .tmp-* files on startup.
export function writeIdentity(home: string, identity: Identity): void {
  checkPrivate(home, "cc-relay home", "directory");
  const path = paths(home).identity;
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, serializeIdentity(identity), { mode: 0o600, flag: "wx" });
    linkSync(tmp, path);
  } catch (err) {
    if (isErrno(err, "EEXIST")) throw new ConfigError(`identity already exists at ${path}`, "exists", { cause: err });
    throw err;
  } finally {
    // Best-effort: a failure here (e.g. the temp file's parent vanished
    // between the write and this cleanup) must not replace the real result
    // above with an unrelated cleanup error.
    try {
      rmSync(tmp, { force: true });
    } catch {
      // ignored, see comment above
    }
  }
}

export function loadIdentity(home: string): Identity {
  const path = paths(home).identity;
  checkPrivate(home, "cc-relay home", "directory");
  const fd = openPrivate(path, "identity file", "file");
  try {
    // Same TOCTOU-closing reasoning as readJson: read from the fd openPrivate
    // just validated, not a fresh readFileSync(path). Not covered by a test,
    // for the same reason (needs a concurrent process swapping the path).
    // No EACCES/EPERM mapping here either: same as readJson, openPrivate
    // already mapped that at open time; a read on an already-open fd can't
    // fail with a fresh permission error.
    return parseIdentity(readFileSync(fd, "utf8"));
  } catch (err) {
    if (err instanceof IdentityError) throw new ConfigError(`${path}: ${err.message}`, "invalid", { cause: err });
    throw err;
  } finally {
    closeSync(fd);
  }
}

// ---- peers ----

const LOGIN_RE = /^[^\s]{1,256}$/;
const B64U_43 = /^[A-Za-z0-9_-]{43}$/;

const StoredPeerSchema = z
  .object({
    alias: z.string().regex(ALIAS_RE),
    signPub: z.string().regex(B64U_43),
    boxPub: z.string().regex(B64U_43),
    tailscaleLogin: z.string().regex(LOGIN_RE).optional(),
  })
  .strict();

const PeersFile = z.object({ v: z.literal(1), peers: z.array(StoredPeerSchema).max(MAX_PEERS) }).strict();

export interface StoredPeer extends Peer {
  tailscaleLogin?: string;
}

// The one place a peer's id is derived, so the channel's peer map and the
// hub's allowlist can't disagree about who a key belongs to.
export function makePeer(p: { alias: string; signPub: Uint8Array; boxPub: Uint8Array; tailscaleLogin?: string }): StoredPeer {
  return {
    id: peerId(p.signPub),
    alias: p.alias,
    signPub: p.signPub,
    boxPub: p.boxPub,
    ...(p.tailscaleLogin !== undefined ? { tailscaleLogin: p.tailscaleLogin } : {}),
  };
}

// Duplicate aliases would make `send` ambiguous; a duplicate key would make one
// peer's messages show up under two names; self in the list would let a
// session message itself through the hub and read it as a peer's.
export function checkPeers(self: Identity, peers: readonly StoredPeer[]): void {
  if (peers.length > MAX_PEERS) throw new ConfigError(`at most ${MAX_PEERS} peers are allowed`, "invalid");
  const selfId = peerId(self.signPub);
  const aliases = new Set<string>();
  const ids = new Set<string>();
  for (const p of peers) {
    if (p.id === selfId) throw new ConfigError(`peer ${p.alias} is this identity's own key`, "invalid");
    if (p.alias === self.alias) throw new ConfigError(`peer alias ${p.alias} is this identity's own alias`, "invalid");
    if (aliases.has(p.alias)) throw new ConfigError(`duplicate peer alias ${p.alias}`, "invalid");
    if (ids.has(p.id)) throw new ConfigError(`peer ${p.alias} has the same key as another peer`, "invalid");
    aliases.add(p.alias);
    ids.add(p.id);
  }
}

export function loadPeers(home: string, self: Identity): StoredPeer[] {
  const path = paths(home).peers;
  const raw = readJson(path, "peers file");
  if (raw === undefined) throw new ConfigError(`peers file ${path} does not exist; run cc-relay init`, "missing");
  const file = parseWith(PeersFile, raw, path, "peers file");
  let peers: StoredPeer[];
  try {
    peers = file.peers.map((p) =>
      makePeer({
        alias: p.alias,
        signPub: fromB64u(p.signPub, 32),
        boxPub: fromB64u(p.boxPub, 32),
        ...(p.tailscaleLogin !== undefined ? { tailscaleLogin: p.tailscaleLogin } : {}),
      }),
    );
  } catch (err) {
    throw new ConfigError(`peers file ${path} has a malformed key`, "invalid", { cause: err });
  }
  checkPeers(self, peers);
  return peers;
}

function peersFileFor(peers: readonly StoredPeer[]): { v: 1; peers: unknown[] } {
  return {
    v: 1,
    peers: peers.map((p) => ({
      alias: p.alias,
      signPub: toB64u(p.signPub),
      boxPub: toB64u(p.boxPub),
      ...(p.tailscaleLogin !== undefined ? { tailscaleLogin: p.tailscaleLogin } : {}),
    })),
  };
}

// The one check both savePeers and a caller that must validate a would-be peer
// list before touching any other file (add, before it writes link.json) run,
// so the two can't drift apart. Runs the same schema loadPeers enforces on
// read, so a field only a caller could get wrong (e.g. a tailscaleLogin with
// whitespace) throws "invalid" here instead of landing on disk.
export function validatePeers(home: string, self: Identity, peers: readonly StoredPeer[]): void {
  checkPeers(self, peers);
  const path = paths(home).peers;
  parseWith(PeersFile, peersFileFor(peers), path, "peers file");
}

export function savePeers(home: string, self: Identity, peers: readonly StoredPeer[]): void {
  validatePeers(home, self, peers);
  writeJsonAtomic(paths(home).peers, peersFileFor(peers));
}

export function peerMap(peers: readonly StoredPeer[]): Map<string, Peer> {
  return new Map(peers.map((p) => [p.id, p]));
}

// The host's own channel connects to its own hub too, so self is on the list.
export function hubAllow(self: Identity, peers: readonly StoredPeer[], selfLogin?: string): Map<string, AllowedPeer> {
  checkPeers(self, peers);
  const entries: AllowedPeer[] = [
    { id: peerId(self.signPub), signPub: self.signPub, ...(selfLogin !== undefined ? { tailscaleLogin: selfLogin } : {}) },
    ...peers.map((p) => ({
      id: p.id,
      signPub: p.signPub,
      ...(p.tailscaleLogin !== undefined ? { tailscaleLogin: p.tailscaleLogin } : {}),
    })),
  ];
  return new Map(entries.map((e) => [e.id, e]));
}

// ---- hub (host only) and link (guest only) ----

const HubFileSchema = z
  .object({
    v: z.literal(1),
    mode: z.enum(["tailscale", "lan", "loopback"]),
    port: z.number().int().min(1).max(65535),
    path: z.string().regex(HUB_PATH_RE),
    iface: z.string().regex(/^[A-Za-z0-9]{1,15}$/).optional(),
    // What guests dial: goes into the card, never used for binding.
    name: z.string().regex(HOST_RE),
    tailscaleLogin: z.string().regex(LOGIN_RE).optional(),
  })
  .strict()
  .refine((h) => h.mode !== "tailscale" || h.tailscaleLogin !== undefined, {
    message: "tailscale mode needs tailscaleLogin (this machine's own Tailscale login)",
  });

export type HubConfig = z.infer<typeof HubFileSchema>;

const LinkFileSchema = z
  .object({
    v: z.literal(1),
    hubId: z.string().regex(B64U_43),
    // Which of the card's addresses this guest dials; doctor uses it to decide
    // whether the Tailscale checks apply.
    via: z.enum(["lan", "tailscale"]),
    host: z.string().regex(HOST_RE),
    port: z.number().int().min(1).max(65535),
    path: z.string().regex(HUB_PATH_RE),
  })
  .strict();

export type LinkConfig = z.infer<typeof LinkFileSchema>;

export function loadHub(home: string): HubConfig | undefined {
  const path = paths(home).hub;
  const raw = readJson(path, "hub file");
  return raw === undefined ? undefined : parseWith(HubFileSchema, raw, path, "hub file");
}

// For checking --host options before init writes anything.
export function validateHub(hub: HubConfig): HubConfig {
  return parseWith(HubFileSchema, hub, "from the --host options", "hub config");
}

export function saveHub(home: string, hub: HubConfig): void {
  writeJsonAtomic(paths(home).hub, parseWith(HubFileSchema, hub, paths(home).hub, "hub config"));
}

export function loadLink(home: string): LinkConfig | undefined {
  const path = paths(home).link;
  const raw = readJson(path, "link file");
  return raw === undefined ? undefined : parseWith(LinkFileSchema, raw, path, "link file");
}

export function saveLink(home: string, link: LinkConfig): void {
  writeJsonAtomic(paths(home).link, parseWith(LinkFileSchema, link, paths(home).link, "link config"));
}

export function removeLink(home: string): void {
  rmSync(paths(home).link, { force: true });
}

export function hubEndpoint(hub: HubConfig): HubEndpoint {
  const where = hub.mode === "tailscale" ? { tailscale: hub.name } : { lan: hub.name };
  return { ...where, port: hub.port, path: hub.path };
}

export interface Endpoint {
  hubId: Uint8Array;
  url: string;
}

// A host dials its own hub on the address the hub binds; a guest dials what the
// host's card said, and only if that hub's key belongs to a peer it added.
export function resolveEndpoint(
  home: string,
  self: Identity,
  peers: readonly StoredPeer[],
  bindHost: (mode: HubMode, iface?: string) => string,
): Endpoint {
  const hub = loadHub(home);
  const link = loadLink(home);
  if (hub && link) throw new ConfigError(`both ${paths(home).hub} and ${paths(home).link} exist; a machine is a host or a guest, not both`, "invalid");
  if (hub) {
    return { hubId: self.signPub, url: `ws://${bindHost(hub.mode, hub.iface)}:${hub.port}/${hub.path}` };
  }
  if (link) {
    const owner = peers.find((p) => p.id === link.hubId);
    if (!owner) throw new ConfigError(`link.json points at a hub whose key is not one of your peers`, "invalid");
    return { hubId: owner.signPub, url: `ws://${link.host}:${link.port}/${link.path}` };
  }
  throw new ConfigError("no hub configured: run `cc-relay init --host` or `cc-relay add <host card>`", "missing");
}
