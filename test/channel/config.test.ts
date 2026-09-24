import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import {
  checkPrivate,
  ConfigError,
  ensureHome,
  hubAllow,
  hubEndpoint,
  loadHub,
  loadIdentity,
  loadLink,
  loadPeers,
  makePeer,
  MAX_PEERS,
  paths,
  peerMap,
  relayHome,
  resolveEndpoint,
  saveHub,
  saveLink,
  savePeers,
  writeIdentity,
} from "../../src/channel/config.js";
import { toB64u } from "../../src/protocol/encoding.js";
import { generateIdentity, peerId } from "../../src/protocol/identity.js";
import { tempHomes } from "./helpers.js";

const nextHome = tempHomes("config");
const PATH22 = "A".repeat(22);

function initHome() {
  const home = nextHome();
  ensureHome(home);
  const self = generateIdentity("alice");
  writeIdentity(home, self);
  savePeers(home, self, []);
  return { home, self };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err.code;
    throw err;
  }
  return undefined;
}

describe("relayHome", () => {
  test("defaults to ~/.config/cc-relay", () => {
    expect(relayHome({}, "/Users/x")).toBe("/Users/x/.config/cc-relay");
  });

  test("honours an absolute CC_RELAY_HOME", () => {
    expect(relayHome({ CC_RELAY_HOME: "/opt/relay" }, "/Users/x")).toBe("/opt/relay");
  });

  test("refuses a relative CC_RELAY_HOME", () => {
    expect(codeOf(() => relayHome({ CC_RELAY_HOME: "relay" }, "/Users/x"))).toBe("invalid");
  });

  test("refuses whitespace anywhere in the path, including a default under a spaced home", () => {
    expect(codeOf(() => relayHome({ CC_RELAY_HOME: "/opt/my relay" }, "/Users/x"))).toBe("invalid");
    expect(codeOf(() => relayHome({}, "/Users/jo smith"))).toBe("invalid");
  });
});

describe("home and identity", () => {
  test("ensureHome creates the directory 0700", () => {
    const home = nextHome();
    ensureHome(home);
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  test("ensureHome refuses an existing directory other users can read", () => {
    const home = nextHome();
    mkdirSync(home, { mode: 0o755 });
    chmodSync(home, 0o755);
    expect(codeOf(() => ensureHome(home))).toBe("permissions");
  });

  test("ensureHome's message includes the errno code, and a file standing in for a parent directory is invalid, not permissions", () => {
    const blocker = nextHome();
    writeFileSync(blocker, "not a directory", { mode: 0o600 });
    const home = `${blocker}/sub`;
    let caught: unknown;
    try {
      ensureHome(home);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).code).toBe("invalid");
    expect((caught as Error).message).toContain("ENOTDIR");
  });

  test("checkPrivate defaults to checking a directory when kind is omitted, for callers fixed to the old two-argument shape", () => {
    const home = nextHome();
    ensureHome(home);
    expect(() => checkPrivate(home, "x")).not.toThrow();
    const file = nextHome();
    writeFileSync(file, "not a directory", { mode: 0o600 });
    expect(codeOf(() => checkPrivate(file, "x"))).toBe("invalid");
  });

  test("checkPrivate maps ENOTDIR (a path segment is a file, not the target itself) to invalid, not a raw error", () => {
    const blocker = nextHome();
    writeFileSync(blocker, "not a directory", { mode: 0o600 });
    const nested = `${blocker}/sub`;
    expect(codeOf(() => checkPrivate(nested, "x"))).toBe("invalid");
  });

  test("the identity is written 0600 and loads back", () => {
    const { home, self } = initHome();
    expect(statSync(paths(home).identity).mode & 0o777).toBe(0o600);
    expect(peerId(loadIdentity(home).signPub)).toBe(peerId(self.signPub));
  });

  test("an existing identity is never overwritten", () => {
    const { home } = initHome();
    const before = readFileSync(paths(home).identity, "utf8");
    expect(codeOf(() => writeIdentity(home, generateIdentity("mallory")))).toBe("exists");
    expect(readFileSync(paths(home).identity, "utf8")).toBe(before);
  });

  test("loading refuses a group-readable identity file", () => {
    const { home } = initHome();
    chmodSync(paths(home).identity, 0o640);
    expect(codeOf(() => loadIdentity(home))).toBe("permissions");
  });

  test("loading maps an unreadable-by-owner identity file to a permissions error, not a raw EACCES", () => {
    const { home } = initHome();
    chmodSync(paths(home).identity, 0o000);
    try {
      expect(codeOf(() => loadIdentity(home))).toBe("permissions");
    } finally {
      chmodSync(paths(home).identity, 0o600);
    }
  });

  test("loading refuses a loosened home directory", () => {
    const { home } = initHome();
    chmodSync(home, 0o711);
    expect(codeOf(() => loadIdentity(home))).toBe("permissions");
  });

  test("loading refuses an identity that is a symlink", () => {
    const other = initHome();
    const home = nextHome();
    ensureHome(home);
    symlinkSync(paths(other.home).identity, paths(home).identity);
    expect(codeOf(() => loadIdentity(home))).toBe("permissions");
  });

  test("a missing identity is reported as missing, a corrupt one as invalid", () => {
    const home = nextHome();
    ensureHome(home);
    expect(codeOf(() => loadIdentity(home))).toBe("missing");
    writeFileSync(paths(home).identity, "{}", { mode: 0o600 });
    expect(codeOf(() => loadIdentity(home))).toBe("invalid");
  });

  test("writeIdentity refuses a loosened home directory", () => {
    const home = nextHome();
    mkdirSync(home, { mode: 0o755 });
    chmodSync(home, 0o755);
    expect(codeOf(() => writeIdentity(home, generateIdentity("alice")))).toBe("permissions");
  });

  test("a private, correctly-moded file or home owned by someone else is still refused", () => {
    const { home } = initHome();
    // In this sandbox the file's real owner IS this process's uid, so without
    // spoofing getuid the ownership check would never fire (mode 0600 already
    // passes). Spying on process.getuid is what actually exercises st.uid !==
    // uid, for both the file check inside loadIdentity and the home check.
    const realUid = process.getuid?.();
    if (realUid === undefined) return;
    const spy = vi.spyOn(process, "getuid").mockReturnValue(realUid + 1);
    try {
      expect(codeOf(() => loadIdentity(home))).toBe("permissions");
      expect(codeOf(() => checkPrivate(home, "cc-relay home", "directory"))).toBe("permissions");
    } finally {
      spy.mockRestore();
    }
  });

  test("openPrivate closes its fd even when it refuses the file", () => {
    const home = nextHome();
    mkdirSync(home, { mode: 0o755 });
    chmodSync(home, 0o755);
    const before = readdirSync("/dev/fd").length;
    expect(codeOf(() => checkPrivate(home, "x"))).toBe("permissions");
    expect(readdirSync("/dev/fd").length).toBe(before);
  });

  test("writeIdentity leaves no leftover temp file behind, whether it succeeds or an identity already exists", () => {
    const home = nextHome();
    ensureHome(home);
    writeIdentity(home, generateIdentity("alice"));
    expect(codeOf(() => writeIdentity(home, generateIdentity("mallory")))).toBe("exists");
    const leftovers = readdirSync(home).filter((name) => name.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("peers", () => {
  test("round-trips peers through peers.json, with ids derived from signPub", () => {
    const { home, self } = initHome();
    const bob = generateIdentity("bob");
    savePeers(home, self, [makePeer({ ...bob, alias: "bob", tailscaleLogin: "bob@example.com" })]);
    const [loaded] = loadPeers(home, self);
    expect(loaded?.id).toBe(peerId(bob.signPub));
    expect(loaded?.tailscaleLogin).toBe("bob@example.com");
    expect(statSync(paths(home).peers).mode & 0o777).toBe(0o600);
  });

  test("refuses duplicate aliases, duplicate keys, and self", () => {
    const { home, self } = initHome();
    const bob = generateIdentity("bob");
    const carol = generateIdentity("carol");
    const dupAlias = [makePeer(bob), makePeer({ ...carol, alias: "bob" })];
    const dupKey = [makePeer(bob), makePeer({ ...bob, alias: "bob2" })];
    const selfKey = [makePeer({ ...self, alias: "me" })];
    const selfAlias = [makePeer({ ...bob, alias: "alice" })];
    for (const peers of [dupAlias, dupKey, selfKey, selfAlias]) {
      expect(codeOf(() => savePeers(home, self, peers))).toBe("invalid");
    }
  });

  test(`refuses more than ${MAX_PEERS} peers`, () => {
    const { home, self } = initHome();
    const many = Array.from({ length: MAX_PEERS + 1 }, (_, i) => makePeer(generateIdentity(`p${i}`)));
    expect(codeOf(() => savePeers(home, self, many))).toBe("invalid");
  });

  test("savePeers refuses a malformed tailscaleLogin before writing, leaving the file untouched", () => {
    const { home, self } = initHome();
    const bob = generateIdentity("bob");
    const before = readFileSync(paths(home).peers, "utf8");
    expect(codeOf(() => savePeers(home, self, [makePeer({ ...bob, alias: "bob", tailscaleLogin: "a b" })]))).toBe("invalid");
    expect(readFileSync(paths(home).peers, "utf8")).toBe(before);
  });

  test("a hand-edited peers.json is validated on load", () => {
    const { home, self } = initHome();
    const bob = generateIdentity("bob");
    const entry = { alias: "bob", signPub: toB64u(bob.signPub), boxPub: toB64u(bob.boxPub) };
    writeFileSync(paths(home).peers, JSON.stringify({ v: 1, peers: [entry, { ...entry, alias: "bobby" }] }), { mode: 0o600 });
    expect(codeOf(() => loadPeers(home, self))).toBe("invalid");
    writeFileSync(paths(home).peers, JSON.stringify({ v: 1, peers: [{ ...entry, extra: 1 }] }), { mode: 0o600 });
    expect(codeOf(() => loadPeers(home, self))).toBe("invalid");
    writeFileSync(paths(home).peers, "not json", { mode: 0o600 });
    expect(codeOf(() => loadPeers(home, self))).toBe("invalid");
  });

  test("loading refuses a world-readable peers file", () => {
    const { home, self } = initHome();
    chmodSync(paths(home).peers, 0o644);
    expect(codeOf(() => loadPeers(home, self))).toBe("permissions");
  });

  test("loading refuses a write-only peers file: the mode bits look fine but this owner can't read it", () => {
    const { home, self } = initHome();
    chmodSync(paths(home).peers, 0o200);
    try {
      expect(codeOf(() => loadPeers(home, self))).toBe("permissions");
    } finally {
      chmodSync(paths(home).peers, 0o600);
    }
  });

  test("loading refuses a peers file that is a symlink, even to a private file outside the home", () => {
    const { home, self } = initHome();
    const outside = nextHome();
    writeFileSync(outside, "{}", { mode: 0o600 });
    rmSync(paths(home).peers, { force: true });
    symlinkSync(outside, paths(home).peers);
    expect(codeOf(() => loadPeers(home, self))).toBe("permissions");
  });

  test("loading peers refuses a loosened home directory", () => {
    const { home, self } = initHome();
    chmodSync(home, 0o777);
    expect(codeOf(() => loadPeers(home, self))).toBe("permissions");
    chmodSync(home, 0o700);
  });

  test("a missing peers file (identity otherwise intact) suggests recreating it, not the init command that would refuse", () => {
    const { home, self } = initHome();
    rmSync(paths(home).peers);
    let message = "";
    try {
      loadPeers(home, self);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toMatch(/run cc-relay init\b/);
    expect(message).toMatch(/peers file .* does not exist/);
  });

  test("saving peers refuses a loosened home directory", () => {
    const { home, self } = initHome();
    chmodSync(home, 0o755);
    expect(codeOf(() => savePeers(home, self, []))).toBe("permissions");
    chmodSync(home, 0o700);
  });

  test("a successful savePeers leaves no leftover temp files in the home", () => {
    const { home, self } = initHome();
    const bob = generateIdentity("bob");
    savePeers(home, self, [makePeer(bob)]);
    const leftovers = readdirSync(home).filter((name) => name.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  test("hubAllow refuses a peer whose id equals the host's own", () => {
    const self = generateIdentity("alice");
    const selfAsPeer = makePeer({ ...self, alias: "shadow" });
    expect(codeOf(() => hubAllow(self, [selfAsPeer]))).toBe("invalid");
  });

  test("peerMap and hubAllow key every entry by the id derived from its signPub; the hub list includes self", () => {
    const self = generateIdentity("alice");
    const bob = makePeer({ ...generateIdentity("bob"), tailscaleLogin: "bob@example.com" });
    expect([...peerMap([bob]).keys()]).toEqual([bob.id]);
    const allow = hubAllow(self, [bob], "alice@example.com");
    expect(allow.get(peerId(self.signPub))).toEqual({
      id: peerId(self.signPub),
      signPub: self.signPub,
      tailscaleLogin: "alice@example.com",
    });
    expect(allow.get(bob.id)).toEqual({ id: bob.id, signPub: bob.signPub, tailscaleLogin: "bob@example.com" });
  });
});

describe("hub, link, and endpoint", () => {
  const lanHub = { v: 1 as const, mode: "lan" as const, port: 24000, path: PATH22, name: "mac.local" };

  test("a missing hub or link file loads as undefined, not an error", () => {
    const { home } = initHome();
    expect(loadHub(home)).toBeUndefined();
    expect(loadLink(home)).toBeUndefined();
  });

  test("a nonexistent home reads as absent, same as before the home was checked at all", () => {
    const home = nextHome();
    const self = generateIdentity("alice");
    expect(loadHub(home)).toBeUndefined();
    expect(loadLink(home)).toBeUndefined();
    expect(codeOf(() => loadPeers(home, self))).toBe("missing");
  });

  test("a home that is a regular file is refused as invalid, not as a raw ENOTDIR", () => {
    const home = nextHome();
    writeFileSync(home, "not a directory", { mode: 0o600 });
    const self = generateIdentity("alice");
    expect(codeOf(() => loadHub(home))).toBe("invalid");
    expect(codeOf(() => savePeers(home, self, []))).toBe("invalid");
  });

  test("a directory named hub.json is refused as invalid, not parsed as JSON", () => {
    const { home } = initHome();
    mkdirSync(paths(home).hub, { mode: 0o700 });
    expect(codeOf(() => loadHub(home))).toBe("invalid");
  });

  test("loading refuses a hub file that is a symlink, even to a private file outside the home", () => {
    const { home } = initHome();
    const outside = nextHome();
    writeFileSync(outside, "{}", { mode: 0o600 });
    symlinkSync(outside, paths(home).hub);
    expect(codeOf(() => loadHub(home))).toBe("permissions");
  });

  test("hub.json round-trips; tailscale mode requires this machine's login", () => {
    const { home } = initHome();
    saveHub(home, lanHub);
    expect(loadHub(home)).toEqual(lanHub);
    expect(codeOf(() => saveHub(home, { ...lanHub, mode: "tailscale" }))).toBe("invalid");
  });

  test("a card built from hub.json puts the name under the mode's key", () => {
    expect(hubEndpoint(lanHub)).toEqual({ lan: "mac.local", port: 24000, path: PATH22 });
    expect(hubEndpoint({ ...lanHub, mode: "tailscale", tailscaleLogin: "a@b", name: "100.64.0.9" })).toEqual({
      tailscale: "100.64.0.9",
      port: 24000,
      path: PATH22,
    });
  });

  test("a host dials the address its hub binds, with its own key as hubId", () => {
    const { home, self } = initHome();
    saveHub(home, { ...lanHub, iface: "en5" });
    const seen: unknown[] = [];
    const endpoint = resolveEndpoint(home, self, [], (mode, iface) => {
      seen.push([mode, iface]);
      return "192.168.1.25";
    });
    expect(seen).toEqual([["lan", "en5"]]);
    expect(endpoint).toEqual({ hubId: self.signPub, url: `ws://192.168.1.25:24000/${PATH22}` });
  });

  test("a guest dials the linked hub only if the hub's key is one of its peers", () => {
    const { home, self } = initHome();
    const host = makePeer(generateIdentity("host"));
    saveLink(home, { v: 1, hubId: host.id, via: "lan", host: "mac.local", port: 24000, path: PATH22 });
    expect(loadLink(home)?.host).toBe("mac.local");
    const never = () => {
      throw new Error("guest must not resolve a bind host");
    };
    expect(codeOf(() => resolveEndpoint(home, self, [], never))).toBe("invalid");
    expect(resolveEndpoint(home, self, [host], never)).toEqual({
      hubId: host.signPub,
      url: `ws://mac.local:24000/${PATH22}`,
    });
  });

  test("link.json round-trips with via tailscale", () => {
    const { home } = initHome();
    const link = { v: 1 as const, hubId: "A".repeat(43), via: "tailscale" as const, host: "100.64.0.9", port: 24000, path: PATH22 };
    saveLink(home, link);
    expect(loadLink(home)).toEqual(link);
  });

  test("a hand-edited link.json is validated on load", () => {
    const { home } = initHome();
    const base = { v: 1, hubId: "A".repeat(43), host: "mac.local", port: 24000, path: PATH22 };
    writeFileSync(paths(home).link, JSON.stringify({ ...base, via: "wan" }), { mode: 0o600 });
    expect(codeOf(() => loadLink(home))).toBe("invalid");
    writeFileSync(paths(home).link, JSON.stringify({ ...base, via: "lan", extra: 1 }), { mode: 0o600 });
    expect(codeOf(() => loadLink(home))).toBe("invalid");
  });

  test("the link host can't smuggle URL structure", () => {
    const { home } = initHome();
    const base = { v: 1 as const, hubId: "A".repeat(43), via: "lan" as const, port: 24000, path: PATH22 };
    for (const host of ["evil.com/x", "a@b", "h:1", "h?x", ""]) {
      expect(codeOf(() => saveLink(home, { ...base, host }))).toBe("invalid");
    }
  });

  test("the missing-hub-or-link message doesn't point at a refusing init --host", () => {
    const { home, self } = initHome();
    const bind = () => "127.0.0.1";
    let message = "";
    try {
      resolveEndpoint(home, self, [], bind);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/no hub configured/);
    expect(message).not.toMatch(/init --host/);
    expect(message).toMatch(/add <host card>/);
  });

  test("no hub or link is missing; both at once is invalid", () => {
    const { home, self } = initHome();
    const bind = () => "127.0.0.1";
    expect(codeOf(() => resolveEndpoint(home, self, [], bind))).toBe("missing");
    saveHub(home, lanHub);
    saveLink(home, { v: 1, hubId: "A".repeat(43), via: "lan", host: "x", port: 1, path: PATH22 });
    expect(codeOf(() => resolveEndpoint(home, self, [], bind))).toBe("invalid");
  });
});
