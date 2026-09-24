import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
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

  test("a hand-edited peers.json is validated on load", () => {
    const { home, self } = initHome();
    const bob = generateIdentity("bob");
    const entry = { alias: "bob", signPub: toB64u(bob.signPub), boxPub: toB64u(bob.boxPub) };
    writeFileSync(paths(home).peers, JSON.stringify({ v: 1, peers: [entry, { ...entry, alias: "bobby" }] }));
    expect(codeOf(() => loadPeers(home, self))).toBe("invalid");
    writeFileSync(paths(home).peers, JSON.stringify({ v: 1, peers: [{ ...entry, extra: 1 }] }));
    expect(codeOf(() => loadPeers(home, self))).toBe("invalid");
    writeFileSync(paths(home).peers, "not json");
    expect(codeOf(() => loadPeers(home, self))).toBe("invalid");
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

  test("the link host can't smuggle URL structure", () => {
    const { home } = initHome();
    const base = { v: 1 as const, hubId: "A".repeat(43), via: "lan" as const, port: 24000, path: PATH22 };
    for (const host of ["evil.com/x", "a@b", "h:1", "h?x", ""]) {
      expect(codeOf(() => saveLink(home, { ...base, host }))).toBe("invalid");
    }
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
