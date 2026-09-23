import { describe, expect, test } from "vitest";
import { parseClientFrame, parseHubFrame } from "../../src/protocol/frames.js";

const id = "A".repeat(43);
const sig = "B".repeat(86);
const boxNonce = "C".repeat(32);

describe("client frames", () => {
  test("parses hello, auth, and msg", () => {
    const hello = { type: "hello", signPub: id, ts: 1, nonce: id, sig };
    const auth = { type: "auth", sig };
    const msg = { type: "msg", ref: "r1", to: id, ciphertext: "abc", nonce: boxNonce };
    expect(parseClientFrame(JSON.stringify(hello))).toEqual(hello);
    expect(parseClientFrame(JSON.stringify(auth))).toEqual(auth);
    expect(parseClientFrame(JSON.stringify(msg))).toEqual(msg);
  });

  test("rejects a client-supplied from on msg", () => {
    const msg = { type: "msg", ref: "r1", to: id, from: id, ciphertext: "abc", nonce: boxNonce };
    expect(parseClientFrame(JSON.stringify(msg))).toBeNull();
  });

  test("rejects bad JSON, unknown types, wrong lengths, and bad characters", () => {
    expect(parseClientFrame("{")).toBeNull();
    expect(parseClientFrame(JSON.stringify({ type: "nope" }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ type: "auth", sig: sig.slice(1) }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ type: "auth", sig: "+".repeat(86) }))).toBeNull();
    const hello = { type: "hello", signPub: id, ts: -1, nonce: id, sig };
    expect(parseClientFrame(JSON.stringify(hello))).toBeNull();
  });

  test("rejects oversize ciphertext", () => {
    const msg = { type: "msg", ref: "r", to: id, ciphertext: "a".repeat(120001), nonce: boxNonce };
    expect(parseClientFrame(JSON.stringify(msg))).toBeNull();
  });
});

describe("hub frames", () => {
  test("parses every hub frame type", () => {
    const frames = [
      { type: "challenge", nonce: id },
      { type: "ready" },
      { type: "msg", from: id, ciphertext: "abc", nonce: boxNonce },
      { type: "ack", ref: "r1" },
      { type: "error", ref: "r1", code: "offline" },
    ];
    for (const f of frames) expect(parseHubFrame(JSON.stringify(f))).toEqual(f);
  });

  test("rejects an unknown error code", () => {
    expect(parseHubFrame(JSON.stringify({ type: "error", ref: "r", code: "boom" }))).toBeNull();
  });
});
