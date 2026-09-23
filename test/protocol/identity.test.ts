import { describe, expect, test } from "vitest";
import { fromB64u, toB64u } from "../../src/protocol/encoding.js";
import {
  generateIdentity,
  IdentityError,
  parseIdentity,
  peerId,
  serializeIdentity,
} from "../../src/protocol/identity.js";

describe("identity", () => {
  test("generates keys of the right sizes", () => {
    const id = generateIdentity("alice");
    expect(id.signPub).toHaveLength(32);
    expect(id.signSec).toHaveLength(64);
    expect(id.boxPub).toHaveLength(32);
    expect(id.boxSec).toHaveLength(32);
    expect(peerId(id.signPub)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("rejects bad aliases", () => {
    for (const alias of ["", "Alice", "a b", "a".repeat(33), "../x", "é"]) {
      expect(() => generateIdentity(alias)).toThrow(IdentityError);
    }
  });

  test("round-trips through serialize/parse", () => {
    const id = generateIdentity("alice");
    expect(parseIdentity(serializeIdentity(id))).toEqual(id);
  });

  test("rejects invalid JSON, wrong shape, and extra fields", () => {
    expect(() => parseIdentity("{")).toThrow("not valid JSON");
    expect(() => parseIdentity(JSON.stringify({ v: 1 }))).toThrow("wrong shape");
    const extra = { ...JSON.parse(serializeIdentity(generateIdentity("a"))), extra: 1 };
    expect(() => parseIdentity(JSON.stringify(extra))).toThrow("wrong shape");
    const wrongVersion = { ...JSON.parse(serializeIdentity(generateIdentity("a"))), v: 2 };
    expect(() => parseIdentity(JSON.stringify(wrongVersion))).toThrow("wrong shape");
    const badAlias = { ...JSON.parse(serializeIdentity(generateIdentity("a"))), alias: "Bad" };
    expect(() => parseIdentity(JSON.stringify(badAlias))).toThrow("wrong shape");
  });

  test("rejects a key of the wrong length", () => {
    const file = JSON.parse(serializeIdentity(generateIdentity("a")));
    file.boxPub = toB64u(new Uint8Array(31));
    expect(() => parseIdentity(JSON.stringify(file))).toThrow("malformed boxPub");

    const wrongSignSec = JSON.parse(serializeIdentity(generateIdentity("a")));
    wrongSignSec.signSec = toB64u(new Uint8Array(63));
    expect(() => parseIdentity(JSON.stringify(wrongSignSec))).toThrow("malformed signSec");

    const nonCanonical = JSON.parse(serializeIdentity(generateIdentity("a")));
    // A base64url encoding of a 32-byte key always ends in a char whose index is a
    // multiple of 4 (the trailing 2 padding bits must be zero); "B" (index 1) never
    // satisfies that, so this always breaks the canonical round trip.
    nonCanonical.signPub = nonCanonical.signPub.slice(0, -1) + "B";
    expect(() => parseIdentity(JSON.stringify(nonCanonical))).toThrow("malformed signPub");
  });

  test("rejects public keys that don't match the secret keys", () => {
    const a = JSON.parse(serializeIdentity(generateIdentity("a")));
    const b = JSON.parse(serializeIdentity(generateIdentity("b")));
    expect(() => parseIdentity(JSON.stringify({ ...a, signPub: b.signPub }))).toThrow(
      "keys do not match",
    );
    expect(() => parseIdentity(JSON.stringify({ ...a, boxPub: b.boxPub }))).toThrow(
      "keys do not match",
    );
  });

  test("rejects a signSec whose seed half belongs to a different key", () => {
    const a = JSON.parse(serializeIdentity(generateIdentity("a")));
    const b = JSON.parse(serializeIdentity(generateIdentity("b")));
    const bSignSec = fromB64u(b.signSec, 64);
    const aSignPub = fromB64u(a.signPub, 32);
    const mixed = new Uint8Array(64);
    mixed.set(bSignSec.subarray(0, 32), 0);
    mixed.set(aSignPub, 32);
    expect(() =>
      parseIdentity(JSON.stringify({ ...a, signSec: toB64u(mixed) })),
    ).toThrow("keys do not match");
  });
});
