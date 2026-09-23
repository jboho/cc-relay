import nacl from "tweetnacl";
import { z } from "zod";
import { bytesEqual, fromB64u, toB64u } from "./encoding.js";

export class IdentityError extends Error {
  override name = "IdentityError";
}

export const ALIAS_RE = /^[a-z0-9_-]{1,32}$/;

export interface Identity {
  alias: string;
  signPub: Uint8Array;
  signSec: Uint8Array;
  boxPub: Uint8Array;
  boxSec: Uint8Array;
}

export function generateIdentity(alias: string): Identity {
  if (!ALIAS_RE.test(alias)) throw new IdentityError(`invalid alias: ${JSON.stringify(alias)}`);
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

export function parseIdentity(json: string): Identity {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new IdentityError("identity file is not valid JSON");
  }
  const parsed = IdentityFile.safeParse(raw);
  if (!parsed.success) throw new IdentityError("identity file has the wrong shape");
  let identity: Identity;
  try {
    identity = {
      alias: parsed.data.alias,
      signPub: fromB64u(parsed.data.signPub, nacl.sign.publicKeyLength),
      signSec: fromB64u(parsed.data.signSec, nacl.sign.secretKeyLength),
      boxPub: fromB64u(parsed.data.boxPub, nacl.box.publicKeyLength),
      boxSec: fromB64u(parsed.data.boxSec, nacl.box.secretKeyLength),
    };
  } catch {
    throw new IdentityError("identity file has a malformed key");
  }
  // A public key that doesn't match its secret key means a corrupted or hand-edited file.
  const signFromSec = nacl.sign.keyPair.fromSecretKey(identity.signSec).publicKey;
  const boxFromSec = nacl.box.keyPair.fromSecretKey(identity.boxSec).publicKey;
  if (!bytesEqual(signFromSec, identity.signPub) || !bytesEqual(boxFromSec, identity.boxPub)) {
    throw new IdentityError("identity file keys do not match");
  }
  return identity;
}
