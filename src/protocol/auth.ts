import nacl from "tweetnacl";
import { concatBytes, u64be, utf8 } from "./encoding.js";
import type { Identity } from "./identity.js";

export const NONCE_BYTES = 32;
export const SIG_BYTES = nacl.sign.signatureLength;

// Domain-separation tags keep a hello signature from ever verifying as a
// challenge signature (or anything else signed with the same key). The NUL ends
// the tag; every field after it is fixed-length, so the encoding is unambiguous.
const HELLO_TAG = utf8("cc-relay/hello/v1\0");
const CHALLENGE_TAG = utf8("cc-relay/challenge/v1\0");

function assertLength(bytes: Uint8Array, length: number, what: string): void {
  if (bytes.length !== length) throw new RangeError(`${what} must be ${length} bytes`);
}

export function helloMessage(hubId: Uint8Array, ts: number, nonce: Uint8Array): Uint8Array {
  assertLength(hubId, nacl.sign.publicKeyLength, "hubId");
  assertLength(nonce, NONCE_BYTES, "nonce");
  return concatBytes(HELLO_TAG, hubId, u64be(ts), nonce);
}

export function challengeMessage(hubId: Uint8Array, challenge: Uint8Array): Uint8Array {
  assertLength(hubId, nacl.sign.publicKeyLength, "hubId");
  assertLength(challenge, NONCE_BYTES, "challenge");
  return concatBytes(CHALLENGE_TAG, hubId, challenge);
}

export function signHello(
  identity: Identity,
  hubId: Uint8Array,
  ts: number,
  nonce: Uint8Array,
): Uint8Array {
  return nacl.sign.detached(helloMessage(hubId, ts, nonce), identity.signSec);
}

export function signChallenge(
  identity: Identity,
  hubId: Uint8Array,
  challenge: Uint8Array,
): Uint8Array {
  return nacl.sign.detached(challengeMessage(hubId, challenge), identity.signSec);
}

function verify(message: () => Uint8Array, sig: Uint8Array, signPub: Uint8Array): boolean {
  try {
    return nacl.sign.detached.verify(message(), sig, signPub);
  } catch {
    // message() runs inside the try, so a malformed peer input (RangeError from
    // assertLength, EncodingError from u64be) is "invalid" too, same as tweetnacl's own length errors.
    return false;
  }
}

export function verifyHello(
  signPub: Uint8Array,
  hubId: Uint8Array,
  ts: number,
  nonce: Uint8Array,
  sig: Uint8Array,
): boolean {
  return verify(() => helloMessage(hubId, ts, nonce), sig, signPub);
}

export function verifyChallenge(
  signPub: Uint8Array,
  hubId: Uint8Array,
  challenge: Uint8Array,
  sig: Uint8Array,
): boolean {
  return verify(() => challengeMessage(hubId, challenge), sig, signPub);
}
