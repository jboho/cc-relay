import nacl from "tweetnacl";
import { describe, expect, test } from "vitest";
import {
  challengeMessage,
  helloMessage,
  signChallenge,
  signHello,
  verifyChallenge,
  verifyHello,
} from "../../src/protocol/auth.js";
import { generateIdentity } from "../../src/protocol/identity.js";

const client = generateIdentity("alice");
const hub = generateIdentity("host");
const other = generateIdentity("mallory");
const nonce = nacl.randomBytes(32);
const ts = 1_790_000_000_000;

describe("hello", () => {
  test("verifies for the signer, hub, ts and nonce it was made for", () => {
    const sig = signHello(client, hub.signPub, ts, nonce);
    expect(verifyHello(client.signPub, hub.signPub, ts, nonce, sig)).toBe(true);
  });

  test("fails for a different key, hub, ts, or nonce", () => {
    const sig = signHello(client, hub.signPub, ts, nonce);
    expect(verifyHello(other.signPub, hub.signPub, ts, nonce, sig)).toBe(false);
    expect(verifyHello(client.signPub, other.signPub, ts, nonce, sig)).toBe(false);
    expect(verifyHello(client.signPub, hub.signPub, ts + 1, nonce, sig)).toBe(false);
    expect(verifyHello(client.signPub, hub.signPub, ts, nacl.randomBytes(32), sig)).toBe(false);
  });

  test("returns false (does not throw) for malformed inputs", () => {
    const sig = signHello(client, hub.signPub, ts, nonce);
    expect(verifyHello(client.signPub, hub.signPub, ts, nonce, sig.slice(1))).toBe(false);
    expect(verifyHello(client.signPub.slice(1), hub.signPub, ts, nonce, sig)).toBe(false);
    expect(verifyHello(client.signPub, hub.signPub, ts, nonce.slice(1), sig)).toBe(false);
    expect(verifyHello(client.signPub, hub.signPub, -1, nonce, sig)).toBe(false);
  });
});

describe("challenge", () => {
  test("verifies only for the exact challenge and hub", () => {
    const challenge = nacl.randomBytes(32);
    const sig = signChallenge(client, hub.signPub, challenge);
    expect(verifyChallenge(client.signPub, hub.signPub, challenge, sig)).toBe(true);
    expect(verifyChallenge(client.signPub, hub.signPub, nacl.randomBytes(32), sig)).toBe(false);
    expect(verifyChallenge(client.signPub, other.signPub, challenge, sig)).toBe(false);
  });

  test("a hello signature never verifies as a challenge signature", () => {
    // Same 32-byte value used as hello nonce and as challenge: tags must keep them apart.
    const helloSig = signHello(client, hub.signPub, ts, nonce);
    expect(verifyChallenge(client.signPub, hub.signPub, nonce, helloSig)).toBe(false);
  });

  test("messages are domain-separated and fixed-layout", () => {
    expect(helloMessage(hub.signPub, ts, nonce)).not.toEqual(challengeMessage(hub.signPub, nonce));
    expect(() => helloMessage(hub.signPub.slice(1), ts, nonce)).toThrow(RangeError);
    expect(() => challengeMessage(hub.signPub, nonce.slice(1))).toThrow(RangeError);
  });
});
