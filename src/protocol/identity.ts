import nacl from "tweetnacl";
import { z } from "zod";
import { bytesEqual, fromB64u, toB64u } from "./encoding.js";

export class IdentityError extends Error {
  override name = "IdentityError";
}

export const ALIAS_RE = /^[a-z0-9_-]{1,32}$/;

// A peer's alias is shown to the model as the channel tag's from=; one of
// these would let a peer masquerade as the user or the assistant itself, so
// they're refused when an identity or peer is created. Not folded into
// ALIAS_RE: that regex also gates IdentityFile/StoredPeerSchema/CardSchema,
// which validate files and cards that may already exist on disk, and this
// check must not make an existing identity.json or peers.json unloadable.
const RESERVED_ALIASES = new Set(["user", "system", "assistant", "claude", "anthropic", "human", "cc-relay"]);

export function isReservedAlias(alias: string): boolean {
  return RESERVED_ALIASES.has(alias.toLowerCase());
}

export interface Identity {
  alias: string;
  signPub: Uint8Array;
  signSec: Uint8Array;
  boxPub: Uint8Array;
  boxSec: Uint8Array;
}

export function generateIdentity(alias: string): Identity {
  if (!ALIAS_RE.test(alias)) throw new IdentityError(`invalid alias: ${JSON.stringify(alias)}`);
  if (isReservedAlias(alias)) throw new IdentityError(`"${alias}" is a reserved alias; pick another one`);
  const sign = nacl.sign.keyPair();
  const box = nacl.box.keyPair();
  return {
    alias,
    signPub: sign.publicKey,
    signSec: sign.secretKey,
    boxPub: box.publicKey,
    boxSec: box.secretKey,
  };
}

export function peerId(signPub: Uint8Array): string {
  return toB64u(signPub);
}

const IdentityFile = z
  .object({
    v: z.literal(1),
    alias: z.string().regex(ALIAS_RE),
    signPub: z.string(),
    signSec: z.string(),
    boxPub: z.string(),
    boxSec: z.string(),
  })
  .strict();

export function serializeIdentity(identity: Identity): string {
  return JSON.stringify({
    v: 1,
    alias: identity.alias,
    signPub: toB64u(identity.signPub),
    signSec: toB64u(identity.signSec),
    boxPub: toB64u(identity.boxPub),
    boxSec: toB64u(identity.boxSec),
  });
}

function decodeField(field: string, value: string, length: number): Uint8Array {
  try {
    return fromB64u(value, length);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new IdentityError(`identity file has a malformed ${field}: ${detail}`, { cause: err });
  }
}

export function parseIdentity(json: string): Identity {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new IdentityError("identity file is not valid JSON");
  }
  const parsed = IdentityFile.safeParse(raw);
  if (!parsed.success) throw new IdentityError("identity file has the wrong shape");
  const identity: Identity = {
    alias: parsed.data.alias,
    signPub: decodeField("signPub", parsed.data.signPub, nacl.sign.publicKeyLength),
    signSec: decodeField("signSec", parsed.data.signSec, nacl.sign.secretKeyLength),
    boxPub: decodeField("boxPub", parsed.data.boxPub, nacl.box.publicKeyLength),
    boxSec: decodeField("boxSec", parsed.data.boxSec, nacl.box.secretKeyLength),
  };
  // tweetnacl's ed25519 secretKey is seed(32) || publicKey(32), and fromSecretKey
  // just copies that second half out rather than deriving it — so a secretKey built
  // from one party's seed paired with another party's real public key would pass
  // unnoticed. Re-derive the whole keypair from the seed instead: the declared
  // signPub must match the derived public key, and the stored signSec must match
  // the derived secretKey (seed + the pubkey actually derived from it) bit-for-bit.
  const signFromSeed = nacl.sign.keyPair.fromSeed(identity.signSec.subarray(0, 32));
  const boxFromSec = nacl.box.keyPair.fromSecretKey(identity.boxSec).publicKey;
  if (
    !bytesEqual(signFromSeed.secretKey, identity.signSec) ||
    !bytesEqual(signFromSeed.publicKey, identity.signPub) ||
    !bytesEqual(boxFromSec, identity.boxPub)
  ) {
    throw new IdentityError("identity file keys do not match");
  }
  return identity;
}
