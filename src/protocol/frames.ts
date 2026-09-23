import { z } from "zod";

// Exact base64url lengths: 32 bytes → 43 chars, 64 → 86, 24 → 32.
// These schemas check the alphabet and length only, so callers must still decode with
// fromB64u(value, bytes), which rejects non-canonical trailing bits, before using a value
// as bytes or as a replay key.
const b64u = (chars: number) => z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${chars}}$`));
const PeerId = b64u(43);
const Ref = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
// Stays under the hub's 128 KB frame cap once wrapped in JSON.
const Ciphertext = z.string().regex(/^[A-Za-z0-9_-]{1,120000}$/);

export const HelloFrame = z
  .object({
    type: z.literal("hello"),
    signPub: PeerId,
    ts: z.number().int().nonnegative(),
    nonce: b64u(43),
    sig: b64u(86),
  })
  .strict();

export const AuthFrame = z.object({ type: z.literal("auth"), sig: b64u(86) }).strict();

export const SendFrame = z
  .object({
    type: z.literal("msg"),
    ref: Ref,
    to: PeerId,
    ciphertext: Ciphertext,
    nonce: b64u(32),
  })
  .strict();

export const ClientFrame = z.discriminatedUnion("type", [HelloFrame, AuthFrame, SendFrame]);

export const ChallengeFrame = z.object({ type: z.literal("challenge"), nonce: b64u(43) }).strict();
export const ReadyFrame = z.object({ type: z.literal("ready") }).strict();
export const DeliverFrame = z
  .object({
    type: z.literal("msg"),
    from: PeerId,
    ciphertext: Ciphertext,
    nonce: b64u(32),
  })
  .strict();
export const AckFrame = z.object({ type: z.literal("ack"), ref: Ref }).strict();
export const ErrorCode = z.enum(["unknown_peer", "offline", "rate_limited"]);
export const ErrorFrame = z.object({ type: z.literal("error"), ref: Ref, code: ErrorCode }).strict();

export const HubFrame = z.discriminatedUnion("type", [
  ChallengeFrame,
  ReadyFrame,
  DeliverFrame,
  AckFrame,
  ErrorFrame,
]);

export type HelloFrame = z.infer<typeof HelloFrame>;
export type AuthFrame = z.infer<typeof AuthFrame>;
export type SendFrame = z.infer<typeof SendFrame>;
export type ClientFrame = z.infer<typeof ClientFrame>;
export type HubFrame = z.infer<typeof HubFrame>;
export type ErrorCode = z.infer<typeof ErrorCode>;

function parseWith<T>(schema: z.ZodType<T>, raw: string): T | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseClientFrame(raw: string): ClientFrame | null {
  return parseWith(ClientFrame, raw);
}

export function parseHubFrame(raw: string): HubFrame | null {
  return parseWith(HubFrame, raw);
}
