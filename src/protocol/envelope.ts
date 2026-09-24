import nacl from "tweetnacl";
import { z } from "zod";
import { fromB64u, toB64u, utf8 } from "./encoding.js";

// "wiring" is a local key bug, "invalid" a malformed message, "too_large" an
// oversized one. Callers map only "too_large" to a user-facing error.
export type EnvelopeErrorCode = "wiring" | "invalid" | "too_large";

export class EnvelopeError extends Error {
  override name = "EnvelopeError";

  constructor(
    message: string,
    readonly code: EnvelopeErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export const MAX_TEXT_BYTES = 32 * 1024;
// JSON escaping can inflate text up to 6x (control characters become \u00XX),
// so the sealed plaintext gets its own cap. 64 KB of plaintext is about 87 KB
// of base64url ciphertext, under the frame schema's 120,000-char limit.
export const MAX_PLAINTEXT_BYTES = 64 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const PEER_ID_RE = /^[A-Za-z0-9_-]{43}$/;

export const InnerSchema = z
  .object({
    v: z.literal(1),
    id: z.string().regex(ID_RE),
    ts: z.number().int().nonnegative(),
    from: z.string().regex(PEER_ID_RE),
    to: z.string().regex(PEER_ID_RE),
    text: z.string().refine((t) => Buffer.byteLength(t, "utf8") <= MAX_TEXT_BYTES),
  })
  .strict();

export type Inner = z.infer<typeof InnerSchema>;

export interface Sealed {
  ciphertext: string;
  nonce: string;
}

export function newMessageId(): string {
  return toB64u(nacl.randomBytes(16));
}

// Local key-wiring bugs (wrong-length keys) must throw, not fail silently as
// null: the caller's own keys are never attacker-controlled, so throwing here
// gives no oracle to a peer, and it surfaces a misconfiguration immediately
// instead of making every message look like tampering.
function assertBoxKeys(publicKey: Uint8Array, secretKey: Uint8Array): void {
  if (publicKey.length !== nacl.box.publicKeyLength) {
    throw new EnvelopeError("box public key has the wrong length", "wiring");
  }
  if (secretKey.length !== nacl.box.secretKeyLength) {
    throw new EnvelopeError("box secret key has the wrong length", "wiring");
  }
}

// The nonce is deliberately not a parameter. nacl.box is XSalsa20-Poly1305, and
// reusing a nonce with the same key pair leaks plaintext and breaks
// authentication, so every seal draws 24 fresh CSPRNG bytes. Never a counter.
export function seal(inner: Inner, recipientBoxPub: Uint8Array, senderBoxSec: Uint8Array): Sealed {
  assertBoxKeys(recipientBoxPub, senderBoxSec);
  const parsed = InnerSchema.safeParse(inner);
  if (!parsed.success) throw new EnvelopeError("message is invalid", "invalid", { cause: parsed.error });
  const plaintext = utf8(JSON.stringify(parsed.data));
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new EnvelopeError("message is too large", "too_large");
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ciphertext = nacl.box(
    plaintext,
    nonce,
    recipientBoxPub,
    senderBoxSec,
  );
  return { ciphertext: toB64u(ciphertext), nonce: toB64u(nonce) };
}

// Returns null for every failure of PEER-supplied data (bad encoding, wrong
// key, tampering, bad JSON, wrong shape). The caller only needs "accept or
// drop"; distinguishing them here would give a sender an oracle. Local key
// lengths are validated separately, outside this try, because they are our
// own wiring and a sender cannot influence them.
export function open(
  sealed: Sealed,
  senderBoxPub: Uint8Array,
  recipientBoxSec: Uint8Array,
): Inner | null {
  assertBoxKeys(senderBoxPub, recipientBoxSec);
  let ciphertext: Uint8Array;
  let nonce: Uint8Array;
  try {
    ciphertext = fromB64u(sealed.ciphertext);
    nonce = fromB64u(sealed.nonce, nacl.box.nonceLength);
  } catch {
    return null;
  }
  const plaintext = nacl.box.open(ciphertext, nonce, senderBoxPub, recipientBoxSec);
  if (!plaintext) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } catch {
    return null;
  }
  const parsed = InnerSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
