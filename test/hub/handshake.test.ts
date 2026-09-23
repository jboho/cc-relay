import nacl from "tweetnacl";
import { describe, expect, test } from "vitest";
import { signChallenge, signHello } from "../../src/protocol/auth.js";
import { fromB64u, toB64u } from "../../src/protocol/encoding.js";
import type { HelloFrame } from "../../src/protocol/frames.js";
import { generateIdentity, type Identity, peerId } from "../../src/protocol/identity.js";
import { ReplayGuard } from "../../src/protocol/replay.js";
import {
  type AllowedPeer,
  Handshake,
  type HandshakeDeps,
  HELLO_NONCE_TTL_MS,
  HELLO_SKEW_MS,
} from "../../src/hub/handshake.js";

const NOW = 1_790_000_000_000;
const host = generateIdentity("host");
const alice = generateIdentity("alice");
const bob = generateIdentity("bob");
const mallory = generateIdentity("mallory");
const allowed: AllowedPeer = {
  id: peerId(alice.signPub),
  signPub: alice.signPub,
  tailscaleLogin: "alice@example.com",
};
const allowedBob: AllowedPeer = {
  id: peerId(bob.signPub),
  signPub: bob.signPub,
  tailscaleLogin: "bob@example.com",
};

function deps(overrides: Partial<HandshakeDeps> = {}): HandshakeDeps {
  return {
    mode: "lan",
    hubId: host.signPub,
    allow: new Map([[allowed.id, allowed]]),
    helloNonces: new ReplayGuard(HELLO_NONCE_TTL_MS),
    now: () => NOW,
    randomBytes: nacl.randomBytes,
    remote: { address: "100.64.0.9", port: 40000 },
    ...overrides,
  };
}

function hello(who: Identity, { ts = NOW, hubId = host.signPub } = {}): HelloFrame {
  const nonce = nacl.randomBytes(32);
  return {
    type: "hello",
    signPub: peerId(who.signPub),
    ts,
    nonce: toB64u(nonce),
    sig: toB64u(signHello(who, hubId, ts, nonce)),
  };
}

function answer(who: Identity, challenge: string) {
  return { type: "auth" as const, sig: toB64u(signChallenge(who, host.signPub, fromB64u(challenge))) };
}

// Like hello(), but the nonce is fixed by the caller and the signer can differ
// from the claimed identity, to build a hello whose signature will fail while
// still exercising a particular nonce.
function helloAs(
  claim: Identity,
  signer: Identity,
  nonce: Uint8Array,
  { ts = NOW }: { ts?: number } = {},
): HelloFrame {
  return {
    type: "hello",
    signPub: peerId(claim.signPub),
    ts,
    nonce: toB64u(nonce),
    sig: toB64u(signHello(signer, host.signPub, ts, nonce)),
  };
}

describe("Handshake: gate", () => {
  test("a valid hello gets a 32-byte challenge; a valid answer authenticates", async () => {
    const hs = new Handshake(deps());
    const reply = await hs.onHello(hello(alice));
    expect(reply?.type).toBe("challenge");
    expect(fromB64u(reply!.nonce)).toHaveLength(32);
    expect(hs.onAuth(answer(alice, reply!.nonce))).toBe(allowed.id);
  });

  test("an unpaired key is rejected", async () => {
    expect(await new Handshake(deps()).onHello(hello(mallory))).toBeNull();
  });

  test("an allowlisted key with a signature from another key is rejected", async () => {
    const forged = { ...hello(mallory), signPub: peerId(alice.signPub) };
    expect(await new Handshake(deps()).onHello(forged)).toBeNull();
  });

  test("a hello made for a different hub is rejected", async () => {
    const other = generateIdentity("other-hub");
    expect(await new Handshake(deps()).onHello(hello(alice, { hubId: other.signPub }))).toBeNull();
  });

  test("a stale or future ts is rejected; the ±60 s edge is accepted", async () => {
    const d = deps();
    expect(await new Handshake(d).onHello(hello(alice, { ts: NOW - HELLO_SKEW_MS - 1 }))).toBeNull();
    expect(await new Handshake(d).onHello(hello(alice, { ts: NOW + HELLO_SKEW_MS + 1 }))).toBeNull();
    expect(await new Handshake(d).onHello(hello(alice, { ts: NOW - HELLO_SKEW_MS }))).not.toBeNull();
  });

  test("a reused hello nonce is rejected", async () => {
    const d = deps();
    const frame = hello(alice);
    expect(await new Handshake(d).onHello(frame)).not.toBeNull();
    expect(await new Handshake(d).onHello(frame)).toBeNull();
  });

  test("a second hello on the same connection fails the handshake", async () => {
    const hs = new Handshake(deps());
    const reply = await hs.onHello(hello(alice));
    expect(await hs.onHello(hello(alice))).toBeNull();
    expect(hs.onAuth(answer(alice, reply!.nonce))).toBeNull();
  });

  test("a rejected hello does not burn its nonce", async () => {
    const d = deps();
    const nonce = nacl.randomBytes(32);
    // Wrong signer for the claimed key.
    expect(await new Handshake(d).onHello(helloAs(alice, mallory, nonce))).toBeNull();
    // Right signer, but a stale ts.
    expect(
      await new Handshake(d).onHello(helloAs(alice, alice, nonce, { ts: NOW - HELLO_SKEW_MS - 1 })),
    ).toBeNull();
    // The nonce is still fresh: a fully valid hello with it succeeds.
    expect(await new Handshake(d).onHello(helloAs(alice, alice, nonce))).not.toBeNull();
  });

  test("the replay key is per peer", async () => {
    const d = deps({ allow: new Map([[allowed.id, allowed], [allowedBob.id, allowedBob]]) });
    const nonce = nacl.randomBytes(32);
    expect(await new Handshake(d).onHello(helloAs(alice, alice, nonce))).not.toBeNull();
    // Same nonce bytes, different peer: not a replay.
    expect(await new Handshake(d).onHello(helloAs(bob, bob, nonce))).not.toBeNull();
  });

  test("a non-canonical re-encoding of a used nonce is rejected", async () => {
    const d = deps();
    const frame = helloAs(alice, alice, nacl.randomBytes(32));
    expect(await new Handshake(d).onHello(frame)).not.toBeNull();

    // Flip the last base64url character's low bit: it lands on the two padding
    // bits of a 32-byte (256-bit) encoding, so the decoded bytes are unchanged
    // but the string is a different, non-canonical spelling of the same nonce.
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastIndex = ALPHABET.indexOf(frame.nonce.at(-1)!);
    const variantNonce = frame.nonce.slice(0, -1) + ALPHABET[lastIndex ^ 1];

    expect(variantNonce).not.toBe(frame.nonce);
    expect(new Uint8Array(Buffer.from(variantNonce, "base64url"))).toEqual(
      new Uint8Array(Buffer.from(frame.nonce, "base64url")),
    );

    expect(await new Handshake(d).onHello({ ...frame, nonce: variantNonce })).toBeNull();
  });
});

describe("Handshake: tailscale mode", () => {
  const whoisReturning = (login: string | null) => ({ loginFor: async () => login });

  test("accepts when whois matches the expected login", async () => {
    const hs = new Handshake(deps({ mode: "tailscale", whois: whoisReturning("alice@example.com") }));
    expect(await hs.onHello(hello(alice))).not.toBeNull();
  });

  test("rejects a whois mismatch, a whois failure, or a missing whois", async () => {
    for (const whois of [whoisReturning("mallory@example.com"), whoisReturning(null), undefined]) {
      const hs = new Handshake(deps({ mode: "tailscale", ...(whois ? { whois } : {}) }));
      expect(await hs.onHello(hello(alice))).toBeNull();
    }
  });

  test("rejects a peer with no expected login", async () => {
    const noLogin = { id: allowed.id, signPub: allowed.signPub };
    const hs = new Handshake(
      deps({ mode: "tailscale", allow: new Map([[noLogin.id, noLogin]]), whois: whoisReturning("x") }),
    );
    expect(await hs.onHello(hello(alice))).toBeNull();
  });

  test("passes the remote address and port to whois", async () => {
    const calls: [string, number][] = [];
    const whois = {
      loginFor: async (a: string, p: number) => (calls.push([a, p]), "alice@example.com"),
    };
    await new Handshake(deps({ mode: "tailscale", whois })).onHello(hello(alice));
    expect(calls).toEqual([["100.64.0.9", 40000]]);
  });

  test("a whois-rejected hello does not burn its nonce", async () => {
    const guard = new ReplayGuard(HELLO_NONCE_TTL_MS);
    const nonce = nacl.randomBytes(32);

    const mismatched = new Handshake(
      deps({ mode: "tailscale", helloNonces: guard, whois: whoisReturning("mallory@example.com") }),
    );
    expect(await mismatched.onHello(helloAs(alice, alice, nonce))).toBeNull();

    const matched = new Handshake(
      deps({ mode: "tailscale", helloNonces: guard, whois: whoisReturning("alice@example.com") }),
    );
    expect(await matched.onHello(helloAs(alice, alice, nonce))).not.toBeNull();
  });

  test("a second hello during an in-flight whois keeps the handshake failed", async () => {
    let release!: (login: string | null) => void;
    const whois = { loginFor: () => new Promise<string | null>((resolve) => (release = resolve)) };
    const hs = new Handshake(deps({ mode: "tailscale", whois }));

    const first = hs.onHello(hello(alice));
    expect(await hs.onHello(hello(alice))).toBeNull();

    release("alice@example.com");
    expect(await first).toBeNull();
  });
});

describe("Handshake: challenge", () => {
  test("a wrong-key answer fails", async () => {
    const hs = new Handshake(deps());
    const reply = await hs.onHello(hello(alice));
    expect(hs.onAuth(answer(mallory, reply!.nonce))).toBeNull();
  });

  test("an answer can't be used twice on the same connection", async () => {
    const hs = new Handshake(deps());
    const reply = await hs.onHello(hello(alice));
    const auth = answer(alice, reply!.nonce);
    expect(hs.onAuth(auth)).toBe(allowed.id);
    expect(hs.onAuth(auth)).toBeNull();
  });

  test("a failed answer burns the challenge", async () => {
    const hs = new Handshake(deps());
    const reply = await hs.onHello(hello(alice));
    expect(hs.onAuth(answer(mallory, reply!.nonce))).toBeNull();
    expect(hs.onAuth(answer(alice, reply!.nonce))).toBeNull();
  });

  test("an answer captured on one connection fails on another", async () => {
    const d = deps();
    const first = new Handshake(d);
    const captured = answer(alice, (await first.onHello(hello(alice)))!.nonce);
    const second = new Handshake(d);
    await second.onHello(hello(alice));
    expect(second.onAuth(captured)).toBeNull();
  });

  test("auth before hello fails", () => {
    expect(new Handshake(deps()).onAuth({ type: "auth", sig: toB64u(new Uint8Array(64)) })).toBeNull();
  });

  test("a replayed hello after a hub restart passes the gate but fails the challenge", async () => {
    // A restart means a fresh nonce cache, so the recorded hello gets through step 1.
    const recorded = hello(alice);
    const legit = new Handshake(deps());
    const legitAnswer = answer(alice, (await legit.onHello(recorded))!.nonce);

    const restarted = new Handshake(deps());
    expect(await restarted.onHello(recorded)).not.toBeNull();
    expect(restarted.onAuth(legitAnswer)).toBeNull();
  });
});
