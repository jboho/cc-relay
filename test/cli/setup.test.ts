import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import nacl from "tweetnacl";
import { describe, expect, test } from "vitest";
import { add, card, init, list, remove } from "../../src/cli/setup.js";
import { UsageError } from "../../src/cli/io.js";
import { checkLaunch } from "../../src/channel/launch.js";
import {
  ConfigError,
  ensureHome,
  loadHub,
  loadIdentity,
  loadLink,
  loadPeers,
  makePeer,
  paths,
  saveHub,
  savePeers,
} from "../../src/channel/config.js";
import { decodeCard, encodeCard, fingerprint } from "../../src/protocol/card.js";
import { generateIdentity } from "../../src/protocol/identity.js";
import { tempHomes } from "../channel/helpers.js";
import { fakeIo } from "./helpers.js";

const nextHome = tempHomes("cli-setup");

async function fresh(alias: string, host = false) {
  const home = nextHome();
  const io = fakeIo(home);
  expect(await init(io, host ? { alias, host: true, mode: "loopback" } : { alias })).toBe(0);
  return { home, io };
}

function cardOf(home: string): { text: string; fp: string } {
  const io = fakeIo(home);
  card(io);
  const c = decodeCard(io.stdout[0] ?? "");
  return { text: io.stdout[0] ?? "", fp: fingerprint(c.signPub, c.boxPub) };
}

describe("init", () => {
  test("writes a private identity, empty peers, settings with the ask rule, and an mcp config", async () => {
    const { home, io } = await fresh("alice");
    const p = paths(home);
    expect(loadIdentity(home).alias).toBe("alice");
    expect(statSync(p.identity).mode & 0o777).toBe(0o600);
    expect(loadPeers(home, loadIdentity(home))).toEqual([]);
    expect(checkLaunch(["claude", "--settings", p.settings])).toEqual({ ok: true, settings: p.settings });
    expect(JSON.parse(readFileSync(p.settings, "utf8")).permissions.disableBypassPermissionsMode).toBe("disable");
    expect(JSON.parse(readFileSync(p.mcp, "utf8"))).toEqual({
      mcpServers: {
        "cc-relay": { command: "/usr/local/bin/node", args: ["/opt/cc-relay/dist/cli.js", "channel"], env: { CC_RELAY_HOME: home } },
      },
    });
    expect(loadHub(home)).toBeUndefined();
    expect(io.stdout.join("\n")).toContain(`--mcp-config ${p.mcp} --settings ${p.settings} --permission-mode manual`);
  });

  test("refuses to run twice, and leaves the first identity alone", async () => {
    const { home } = await fresh("alice");
    const before = readFileSync(paths(home).identity, "utf8");
    await expect(init(fakeIo(home), { alias: "alice" })).rejects.toMatchObject({ code: "exists" });
    expect(readFileSync(paths(home).identity, "utf8")).toBe(before);
  });

  test("--host in loopback mode writes a hub on 127.0.0.1 with a random path and port", async () => {
    const { home } = await fresh("alice", true);
    const hub = loadHub(home);
    expect(hub).toMatchObject({ v: 1, mode: "loopback", name: "127.0.0.1" });
    expect(hub?.port).toBeGreaterThanOrEqual(20000);
    expect(hub?.path).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  test("bad input fails before anything is written, so a corrected re-run works", async () => {
    const home = nextHome();
    const p = paths(home);
    await expect(init(fakeIo(home), { alias: "alice", host: true, mode: "loopback", name: "evil/host" })).rejects.toBeInstanceOf(ConfigError);
    await expect(init(fakeIo(home), { alias: "Not Valid" })).rejects.toThrow();
    await expect(init(fakeIo(home), { alias: "alice", host: true, mode: "tailscale" })).rejects.toBeInstanceOf(UsageError);
    expect(() => loadIdentity(home)).toThrow(expect.objectContaining({ code: "missing" }));
    for (const f of [p.peers, p.settings, p.mcp, p.hub]) expect(existsSync(f)).toBe(false);
    expect(await init(fakeIo(home), { alias: "alice" })).toBe(0);
  });

  test("hub options without --host are a usage error", async () => {
    await expect(init(fakeIo(nextHome()), { alias: "alice", mode: "lan" })).rejects.toBeInstanceOf(UsageError);
  });

  test("a leftover peers.json from a run that failed before the identity was written does not block a retry", async () => {
    const home = nextHome();
    ensureHome(home);
    savePeers(home, generateIdentity("placeholder"), []);
    expect(await init(fakeIo(home), { alias: "alice" })).toBe(0);
    expect(loadIdentity(home).alias).toBe("alice");
  });

  test("a leftover peers.json with a stored peer survives a retry", async () => {
    const home = nextHome();
    ensureHome(home);
    const bob = generateIdentity("bob");
    savePeers(home, generateIdentity("placeholder"), [makePeer({ ...bob, alias: "bob" })]);
    expect(await init(fakeIo(home), { alias: "alice" })).toBe(0);
    expect(loadPeers(home, loadIdentity(home)).map((p) => p.alias)).toEqual(["bob"]);
  });

  test("a leftover peers.json whose peer alias collides with the new identity's alias is refused, and nothing is written", async () => {
    const home = nextHome();
    const p = paths(home);
    ensureHome(home);
    const bob = generateIdentity("bob");
    savePeers(home, generateIdentity("placeholder"), [makePeer({ ...bob, alias: "alice" })]);
    await expect(init(fakeIo(home), { alias: "alice" })).rejects.toBeInstanceOf(ConfigError);
    for (const f of [p.identity, p.settings, p.mcp, p.hub]) expect(existsSync(f)).toBe(false);
  });

  test("a leftover hub.json from an earlier failed --host attempt is removed by a plain init", async () => {
    const home = nextHome();
    ensureHome(home);
    saveHub(home, { v: 1, mode: "loopback", port: 20005, path: "A".repeat(22), name: "127.0.0.1" });
    expect(await init(fakeIo(home), { alias: "alice" })).toBe(0);
    expect(loadHub(home)).toBeUndefined();
  });

  test("a malformed --tailscale-login on a host is refused by the hub schema before any write", async () => {
    const home = nextHome();
    const p = paths(home);
    await expect(init(fakeIo(home), { alias: "alice", host: true, mode: "loopback", tailscaleLogin: "a b" })).rejects.toBeInstanceOf(ConfigError);
    for (const f of [p.identity, p.peers, p.settings, p.mcp, p.hub]) expect(existsSync(f)).toBe(false);
  });

  test("refuses a reserved alias for this machine", async () => {
    const home = nextHome();
    const p = paths(home);
    await expect(init(fakeIo(home), { alias: "user" })).rejects.toThrow(/reserved/);
    for (const f of [p.identity, p.peers, p.settings, p.mcp, p.hub]) expect(existsSync(f)).toBe(false);
  });
});

describe("card", () => {
  test("prints only the card on stdout and the fingerprint on stderr", async () => {
    const { home } = await fresh("alice", true);
    const io = fakeIo(home);
    expect(card(io)).toBe(0);
    expect(io.stdout).toHaveLength(1);
    const c = decodeCard(io.stdout[0] ?? "");
    expect(c.alias).toBe("alice");
    expect(c.hub).toMatchObject({ lan: "127.0.0.1", port: loadHub(home)?.port });
    expect(io.stderr.join("\n")).toContain(fingerprint(c.signPub, c.boxPub));
  });

  test("a guest's card has no hub", async () => {
    const { home } = await fresh("bob");
    expect(decodeCard(cardOf(home).text).hub).toBeUndefined();
  });
});

describe("add", () => {
  test("without --confirm it shows the fingerprint and exits 2 without adding", async () => {
    const host = await fresh("alice", true);
    const guest = await fresh("bob");
    const io = fakeIo(guest.home);
    const c = cardOf(host.home);
    expect(add(io, { card: c.text })).toBe(2);
    expect(io.stderr.join("\n")).toContain(c.fp);
    expect(loadPeers(guest.home, loadIdentity(guest.home))).toEqual([]);
  });

  test("a wrong --confirm exits 1 and adds nothing", async () => {
    const host = await fresh("alice", true);
    const guest = await fresh("bob");
    const io = fakeIo(guest.home);
    expect(add(io, { card: cardOf(host.home).text, confirm: "0000 0000" })).toBe(1);
    expect(io.stderr.join("\n")).toContain("mismatch");
    expect(io.stderr[0]).toMatch(/^cc-relay: /);
    expect(loadPeers(guest.home, loadIdentity(guest.home))).toEqual([]);
    expect(loadLink(guest.home)).toBeUndefined();
  });

  test("--confirm ignores dashes, spaces and case", async () => {
    const host = await fresh("alice", true);
    const guest = await fresh("bob");
    const c = cardOf(host.home);
    expect(add(fakeIo(guest.home), { card: c.text, confirm: c.fp.replaceAll("-", " ").toUpperCase() })).toBe(0);
  });

  test("a guest adding a host card records the peer and a link to its hub", async () => {
    const host = await fresh("alice", true);
    const guest = await fresh("bob");
    const c = cardOf(host.home);
    expect(add(fakeIo(guest.home), { card: c.text, confirm: c.fp })).toBe(0);
    const [peer] = loadPeers(guest.home, loadIdentity(guest.home));
    expect(peer?.alias).toBe("alice");
    const hub = loadHub(host.home);
    expect(loadLink(guest.home)).toEqual({ v: 1, hubId: peer?.id, via: "lan", host: "127.0.0.1", port: hub?.port, path: hub?.path });
  });

  test("the host adds the guest's card as a plain peer", async () => {
    const host = await fresh("alice", true);
    const guest = await fresh("bob");
    const c = cardOf(guest.home);
    expect(add(fakeIo(host.home), { card: c.text, confirm: c.fp })).toBe(0);
    expect(loadPeers(host.home, loadIdentity(host.home)).map((p) => p.alias)).toEqual(["bob"]);
    expect(loadLink(host.home)).toBeUndefined();
  });

  test("refuses a card whose alias is reserved", async () => {
    const guest = await fresh("bob");
    // Built from raw keys rather than generateIdentity, since generateIdentity
    // itself now refuses a reserved alias -- this proves add() enforces it too,
    // for a peer's card, independently of the identity-creation path.
    const sign = nacl.sign.keyPair();
    const box = nacl.box.keyPair();
    const badCard = encodeCard({ alias: "user", signPub: sign.publicKey, boxPub: box.publicKey });
    const fp = fingerprint(sign.publicKey, box.publicKey);
    expect(() => add(fakeIo(guest.home), { card: badCard, confirm: fp })).toThrow(/reserved/);
    expect(loadPeers(guest.home, loadIdentity(guest.home))).toEqual([]);
  });

  test("a host refuses another hub's card", async () => {
    const a = await fresh("alice", true);
    const b = await fresh("bob", true);
    const c = cardOf(b.home);
    expect(() => add(fakeIo(a.home), { card: c.text, confirm: c.fp })).toThrow(/host or a guest/);
  });

  test("a guest already linked to one hub refuses a second hub", async () => {
    const h1 = await fresh("alice", true);
    const h2 = await fresh("carol", true);
    const guest = await fresh("bob");
    const c1 = cardOf(h1.home);
    const c2 = cardOf(h2.home);
    add(fakeIo(guest.home), { card: c1.text, confirm: c1.fp });
    expect(() => add(fakeIo(guest.home), { card: c2.text, confirm: c2.fp })).toThrow(/another hub/);
    expect(loadPeers(guest.home, loadIdentity(guest.home)).map((p) => p.alias)).toEqual(["alice"]);
  });

  test("a card offering both lan and tailscale needs --via", async () => {
    const guest = await fresh("bob");
    const other = generateIdentity("alice");
    const text = encodeCard({ alias: "alice", signPub: other.signPub, boxPub: other.boxPub, hub: { lan: "alice.local", tailscale: "100.64.0.9", port: 21000, path: "P".repeat(22) } });
    const fp = fingerprint(other.signPub, other.boxPub);
    expect(() => add(fakeIo(guest.home), { card: text, confirm: fp })).toThrow(/--via/);
    expect(add(fakeIo(guest.home), { card: text, confirm: fp, via: "tailscale" })).toBe(0);
    expect(loadLink(guest.home)).toMatchObject({ via: "tailscale", host: "100.64.0.9" });
  });

  test("--via on a card without a hub is a usage error", async () => {
    const host = await fresh("alice", true);
    const guest = await fresh("bob");
    const c = cardOf(guest.home);
    expect(() => add(fakeIo(host.home), { card: c.text, confirm: c.fp, via: "lan" })).toThrow(UsageError);
  });

  test("a tailscale-mode host needs the peer's tailscale login", async () => {
    const host = await fresh("alice", true);
    const hub = loadHub(host.home);
    writeFileSync(paths(host.home).hub, JSON.stringify({ ...hub, mode: "tailscale", name: "100.64.0.1", tailscaleLogin: "alice@example.com" }), { mode: 0o600 });
    const guest = await fresh("bob");
    const c = cardOf(guest.home);
    expect(() => add(fakeIo(host.home), { card: c.text, confirm: c.fp })).toThrow(/--tailscale-login/);
    expect(add(fakeIo(host.home), { card: c.text, confirm: c.fp, tailscaleLogin: "bob@example.com" })).toBe(0);
    expect(loadPeers(host.home, loadIdentity(host.home))[0]?.tailscaleLogin).toBe("bob@example.com");
  });

  test("--tailscale-login is refused unless this machine's own hub runs in tailscale mode", async () => {
    const lanHost = await fresh("alice", true);
    const guest = await fresh("bob");
    const carol = await fresh("carol");
    expect(() => add(fakeIo(lanHost.home), { card: cardOf(guest.home).text, confirm: cardOf(guest.home).fp, tailscaleLogin: "bob@example.com" })).toThrow(/tailscale mode/);
    expect(() => add(fakeIo(guest.home), { card: cardOf(carol.home).text, confirm: cardOf(carol.home).fp, tailscaleLogin: "carol@example.com" })).toThrow(/tailscale mode/);
  });

  test("adding the same peer twice, or your own card, is refused", async () => {
    const host = await fresh("alice", true);
    const guest = await fresh("bob");
    const c = cardOf(guest.home);
    add(fakeIo(host.home), { card: c.text, confirm: c.fp });
    expect(() => add(fakeIo(host.home), { card: c.text, confirm: c.fp })).toThrow(ConfigError);
    const own = cardOf(host.home);
    expect(() => add(fakeIo(host.home), { card: own.text, confirm: own.fp })).toThrow(ConfigError);
  });

  test("a malformed --tailscale-login is refused by the peers schema, and list keeps working", async () => {
    // Needs a tailscale-mode host: a plain (non-tailscale) hub or a guest now
    // refuses --tailscale-login outright (see the usage-error test above),
    // before ever reaching the peers schema this test means to exercise.
    const host = await fresh("alice", true);
    const hub = loadHub(host.home);
    writeFileSync(paths(host.home).hub, JSON.stringify({ ...hub, mode: "tailscale", name: "100.64.0.1", tailscaleLogin: "alice@example.com" }), { mode: 0o600 });
    const guest = await fresh("bob");
    const c = cardOf(guest.home);
    expect(() => add(fakeIo(host.home), { card: c.text, confirm: c.fp, tailscaleLogin: "a b" })).toThrow(ConfigError);
    expect(loadPeers(host.home, loadIdentity(host.home))).toEqual([]);
    expect(loadLink(host.home)).toBeUndefined();
    const io = fakeIo(host.home);
    expect(list(io)).toBe(0);
  });

  test("a hub card whose alias matches an existing peer is refused before any write", async () => {
    const guest = await fresh("bob");
    const impostor = generateIdentity("carol");
    add(fakeIo(guest.home), {
      card: encodeCard({ alias: "alice", signPub: impostor.signPub, boxPub: impostor.boxPub }),
      confirm: fingerprint(impostor.signPub, impostor.boxPub),
    });
    const host = await fresh("alice", true);
    const c = cardOf(host.home);
    expect(() => add(fakeIo(guest.home), { card: c.text, confirm: c.fp })).toThrow(ConfigError);
    expect(loadLink(guest.home)).toBeUndefined();
    expect(loadPeers(guest.home, loadIdentity(guest.home)).map((p) => p.alias)).toEqual(["alice"]);
  });

  test("a hub card whose key matches an existing peer is refused before any write", async () => {
    const host = await fresh("alice", true);
    const guest = await fresh("bob");
    const c = cardOf(host.home);
    add(fakeIo(guest.home), { card: c.text, confirm: c.fp });
    const originalLink = loadLink(guest.home);
    const [existingPeer] = loadPeers(guest.home, loadIdentity(guest.home));
    const dup = encodeCard({
      alias: "eve",
      signPub: existingPeer!.signPub,
      boxPub: existingPeer!.boxPub,
      hub: { lan: "10.0.0.7", port: 21001, path: "R".repeat(22) },
    });
    const dupFp = fingerprint(existingPeer!.signPub, existingPeer!.boxPub);
    expect(() => add(fakeIo(guest.home), { card: dup, confirm: dupFp })).toThrow(ConfigError);
    expect(loadLink(guest.home)).toEqual(originalLink);
    expect(loadPeers(guest.home, loadIdentity(guest.home)).map((p) => p.alias)).toEqual(["alice"]);
  });

  test("--via lan on a card offering only tailscale is refused", async () => {
    const guest = await fresh("bob");
    const other = generateIdentity("alice");
    const text = encodeCard({
      alias: "alice",
      signPub: other.signPub,
      boxPub: other.boxPub,
      hub: { tailscale: "100.64.0.9", port: 21000, path: "P".repeat(22) },
    });
    const fp = fingerprint(other.signPub, other.boxPub);
    expect(() => add(fakeIo(guest.home), { card: text, confirm: fp, via: "lan" })).toThrow(/lan address/);
  });
});

describe("remove and list", () => {
  test("removing the hub's owner also removes the link", async () => {
    const host = await fresh("alice", true);
    const guest = await fresh("bob");
    const c = cardOf(host.home);
    add(fakeIo(guest.home), { card: c.text, confirm: c.fp });
    const io = fakeIo(guest.home);
    expect(remove(io, "alice")).toBe(0);
    expect(io.stdout[0]).toContain("link");
    expect(loadPeers(guest.home, loadIdentity(guest.home))).toEqual([]);
    expect(loadLink(guest.home)).toBeUndefined();
  });

  test("removing a peer on a host warns that the running hub still accepts them until it restarts", async () => {
    const host = await fresh("alice", true);
    const guest = await fresh("bob");
    const c = cardOf(guest.home);
    add(fakeIo(host.home), { card: c.text, confirm: c.fp });
    const io = fakeIo(host.home);
    expect(remove(io, "bob")).toBe(0);
    expect(io.stdout).toContain("Restart cc-relay hub to drop bob from its allowlist; until then the hub still accepts them.");
    expect(io.stdout).toContain("Restart any relay sessions to pick up the change.");
  });

  test("removing a peer on a guest (no hub here) does not print the hub-restart warning", async () => {
    const host = await fresh("alice", true);
    const guest = await fresh("bob");
    const c = cardOf(host.home);
    add(fakeIo(guest.home), { card: c.text, confirm: c.fp });
    const io = fakeIo(guest.home);
    expect(remove(io, "alice")).toBe(0);
    expect(io.stdout.some((l) => l.includes("Restart cc-relay hub"))).toBe(false);
    expect(io.stdout).toContain("Restart any relay sessions to pick up the change.");
  });

  test("a malformed hub.json fails remove() before peers.json is touched", async () => {
    const host = await fresh("alice", true);
    const guest = await fresh("bob");
    const c = cardOf(guest.home);
    add(fakeIo(host.home), { card: c.text, confirm: c.fp });
    const before = readFileSync(paths(host.home).peers, "utf8");
    writeFileSync(paths(host.home).hub, "not json", { mode: 0o600 });
    expect(() => remove(fakeIo(host.home), "bob")).toThrow(ConfigError);
    expect(readFileSync(paths(host.home).peers, "utf8")).toBe(before);
  });

  test("removing an unknown alias exits 1", async () => {
    const { home } = await fresh("bob");
    const io = fakeIo(home);
    expect(remove(io, "nobody")).toBe(1);
    expect(io.stderr[0]).toContain("nobody");
    expect(io.stderr[0]).toMatch(/^cc-relay: /);
  });

  test("list on a guest with no hub and no link doesn't point at init --host, which would refuse", async () => {
    const { home } = await fresh("bob");
    const io = fakeIo(home);
    expect(list(io)).toBe(0);
    expect(io.stdout[1]).toMatch(/no hub/);
    expect(io.stdout[1]).not.toMatch(/init --host/);
    expect(io.stdout[1]).toMatch(/add a host's card with cc-relay add <card>/);
  });

  test("list shows you, your role and each peer's fingerprint", async () => {
    const host = await fresh("alice", true);
    const guest = await fresh("bob");
    const hc = cardOf(host.home);
    const gc = cardOf(guest.home);
    add(fakeIo(guest.home), { card: hc.text, confirm: hc.fp });
    const io = fakeIo(guest.home);
    expect(list(io)).toBe(0);
    expect(io.stdout[0]).toBe(`you: bob  ${gc.fp}`);
    expect(io.stdout[1]).toMatch(/^linked to alice's hub at 127\.0\.0\.1:\d+ via lan$/);
    expect(io.stdout[2]).toBe(`alice  ${hc.fp}`);
  });
});
