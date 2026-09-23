import { describe, expect, test } from "vitest";
import { toB64u, utf8 } from "../../src/protocol/encoding.js";
import { generateIdentity } from "../../src/protocol/identity.js";
import {
  cardFor,
  CardError,
  decodeCard,
  encodeCard,
  fingerprint,
} from "../../src/protocol/card.js";

const hub = { lan: "192.168.1.25", port: 24001, path: "A".repeat(22) };
const encodeRaw = (value: unknown) => toB64u(utf8(JSON.stringify(value)));

describe("cards", () => {
  test("round-trips a guest card and a host card", () => {
    const id = generateIdentity("alice");
    expect(decodeCard(encodeCard(cardFor(id)))).toEqual(cardFor(id));
    expect(decodeCard(encodeCard(cardFor(id, hub)))).toEqual(cardFor(id, hub));
  });

  test("tolerates surrounding whitespace from copy/paste", () => {
    const text = encodeCard(cardFor(generateIdentity("alice")));
    expect(decodeCard(`  ${text}\n`).alias).toBe("alice");
  });

  test("rejects garbage, oversize input, and extra fields", () => {
    expect(() => decodeCard("not a card!")).toThrow(CardError);
    expect(() => decodeCard("A".repeat(2049))).toThrow(/too long/);
    const id = generateIdentity("alice");
    const body = { v: 1, alias: "alice", signPub: toB64u(id.signPub), boxPub: toB64u(id.boxPub) };
    expect(() => decodeCard(encodeRaw({ ...body, extra: true }))).toThrow(CardError);
  });

  test("rejects a bad alias or a short key", () => {
    const id = generateIdentity("alice");
    const body = { v: 1, alias: "alice", signPub: toB64u(id.signPub), boxPub: toB64u(id.boxPub) };
    expect(() => decodeCard(encodeRaw({ ...body, alias: "Alice!" }))).toThrow(CardError);
    expect(() => decodeCard(encodeRaw({ ...body, boxPub: toB64u(new Uint8Array(16)) }))).toThrow(
      CardError,
    );
  });

  test("rejects hub hosts and paths that could alter the connect URL", () => {
    const id = generateIdentity("alice");
    const body = { v: 1, alias: "alice", signPub: toB64u(id.signPub), boxPub: toB64u(id.boxPub) };
    const bad = [
      { ...hub, lan: "evil.com/x?" },
      { ...hub, lan: "a@b" },
      { ...hub, tailscale: "evil.com/x?" },
      { ...hub, path: "short" },
      { ...hub, path: "../" + "A".repeat(19) },
      { port: 1, path: hub.path },
      { ...hub, port: 70000 },
    ];
    for (const h of bad) {
      expect(() => decodeCard(encodeRaw({ ...body, hub: h }))).toThrow(CardError);
    }
  });

  test("encodeCard refuses to produce an invalid card", () => {
    const id = generateIdentity("alice");
    expect(() => encodeCard({ ...cardFor(id), alias: "Bad Alias" })).toThrow(CardError);
    expect(() => encodeCard({ ...cardFor(id), boxPub: new Uint8Array(16) })).toThrow(CardError);
  });
});

describe("fingerprint", () => {
  test("is stable, formatted, and key-dependent", () => {
    const a = generateIdentity("a");
    const b = generateIdentity("b");
    const fp = fingerprint(a.signPub, a.boxPub);
    expect(fp).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){4}$/);
    expect(fingerprint(a.signPub, a.boxPub)).toBe(fp);
    expect(fingerprint(a.signPub, b.boxPub)).not.toBe(fp);
    expect(fingerprint(b.signPub, a.boxPub)).not.toBe(fp);
  });

  test("matches a known answer, pinning the domain prefix and format", () => {
    expect(fingerprint(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2))).toBe(
      "a520-0594-de3a-4b71-2633",
    );
  });
});
