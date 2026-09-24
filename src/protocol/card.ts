import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import { z } from "zod";
import { concatBytes, fromB64u, toB64u, utf8 } from "./encoding.js";
import { ALIAS_RE, type Identity } from "./identity.js";

export class CardError extends Error {
  override name = "CardError";
}

// Hostnames and IPv4 only: the guest builds ws://<host>:<port>/<path> from these,
// so anything that could change the URL's structure is rejected here.
export const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;
export const HUB_PATH_RE = /^[A-Za-z0-9_-]{22}$/;
const MAX_CARD_CHARS = 2048;

const HubEndpoint = z
  .object({
    tailscale: z.string().regex(HOST_RE).optional(),
    lan: z.string().regex(HOST_RE).optional(),
    port: z.number().int().min(1).max(65535),
    path: z.string().regex(HUB_PATH_RE),
  })
  .strict()
  .refine((hub) => hub.tailscale !== undefined || hub.lan !== undefined, {
    message: "hub needs a tailscale or lan host",
  });

export type HubEndpoint = z.infer<typeof HubEndpoint>;

const CardSchema = z
  .object({
    v: z.literal(1),
    alias: z.string().regex(ALIAS_RE),
    signPub: z.string().length(43),
    boxPub: z.string().length(43),
    hub: HubEndpoint.optional(),
  })
  .strict();

export interface Card {
  alias: string;
  signPub: Uint8Array;
  boxPub: Uint8Array;
  hub?: HubEndpoint;
}

export function cardFor(identity: Identity, hub?: HubEndpoint): Card {
  return {
    alias: identity.alias,
    signPub: identity.signPub,
    boxPub: identity.boxPub,
    ...(hub ? { hub } : {}),
  };
}

export function encodeCard(card: Card): string {
  const body = {
    v: 1,
    alias: card.alias,
    signPub: toB64u(card.signPub),
    boxPub: toB64u(card.boxPub),
    ...(card.hub ? { hub: card.hub } : {}),
  };
  if (!CardSchema.safeParse(body).success) throw new CardError("card is invalid");
  return toB64u(utf8(JSON.stringify(body)));
}

export function decodeCard(text: string): Card {
  if (text.length > MAX_CARD_CHARS) throw new CardError("card is too long");
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromB64u(text.trim())));
  } catch (err) {
    throw new CardError("card is not valid base64url JSON", { cause: err });
  }
  const parsed = CardSchema.safeParse(raw);
  if (!parsed.success) throw new CardError("card has the wrong shape");
  try {
    return {
      alias: parsed.data.alias,
      signPub: fromB64u(parsed.data.signPub, nacl.sign.publicKeyLength),
      boxPub: fromB64u(parsed.data.boxPub, nacl.box.publicKeyLength),
      ...(parsed.data.hub ? { hub: parsed.data.hub } : {}),
    };
  } catch (err) {
    throw new CardError("card has a malformed key", { cause: err });
  }
}

// 80 bits of SHA-256 over both public keys: short enough to read aloud, and a
// swapped card would need a second-preimage on that prefix to go unnoticed.
export function fingerprint(signPub: Uint8Array, boxPub: Uint8Array): string {
  const digest = createHash("sha256")
    .update(concatBytes(utf8("cc-relay/fp/v1\0"), signPub, boxPub))
    .digest("hex");
  return digest.slice(0, 20).match(/.{4}/g)!.join("-");
}
