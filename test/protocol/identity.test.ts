import { describe, expect, test } from "vitest";
import { toB64u } from "../../src/protocol/encoding.js";
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
    expect(() => parseIdentity("{")).toThrow(IdentityError);
    expect(() => parseIdentity(JSON.stringify({ v: 1 }))).toThrow(IdentityError);
    const extra = { ...JSON.parse(serializeIdentity(generateIdentity("a"))), extra: 1 };
    expect(() => parseIdentity(JSON.stringify(extra))).toThrow(IdentityError);
  });

  test("rejects a key of the wrong length", () => {
    const file = JSON.parse(serializeIdentity(generateIdentity("a")));
    file.boxPub = toB64u(new Uint8Array(31));
    expect(() => parseIdentity(JSON.stringify(file))).toThrow(IdentityError);
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
});
