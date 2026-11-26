import { execFile } from "node:child_process";
import { isIPv4 } from "node:net";
import { z } from "zod";

export interface Whois {
  // The Tailscale login that owns the connecting node, or null if unknown.
  loginFor(address: string, port: number): Promise<string | null>;
}

// Only the field we use. `tailscale whois --json` prints more; zod strips it.
const WhoisJson = z.object({ UserProfile: z.object({ LoginName: z.string().min(1) }) });

// Distinguishes "the output wasn't JSON" from "JSON, but no usable login", so
// the caller can report a precise reason without echoing the raw output back.
export type ParsedWhois =
  | { status: "ok"; login: string }
  | { status: "not-json" }
  | { status: "no-login" };

export function parseWhois(stdout: string): ParsedWhois {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return { status: "not-json" };
  }
  const parsed = WhoisJson.safeParse(value);
  if (!parsed.success) return { status: "no-login" };
  return { status: "ok", login: parsed.data.UserProfile.LoginName };
}

export interface WhoisOptions {
  bin?: string;
  timeoutMs?: number;
  // Told why a lookup failed. The handshake stays silent toward the peer, so
  // without this an operator can't tell "not shared" from "tailscale is down".
  onError?: (reason: string) => void;
}

// onError is caller-supplied and must never take down the hub: a throwing
// handler (a logger with a bug, say) must not turn a routine lookup failure
// into an unhandled exception.
function reportSafely(onError: ((reason: string) => void) | undefined, reason: string): void {
  try {
    onError?.(reason);
  } catch {
    // Deliberately ignored: see reportSafely's doc comment above.
  }
}

// Any failure (tailscale missing, timeout, not a tailnet peer) returns null,
// which the handshake treats as a mismatch: fail closed.
export function tailscaleWhois({ bin = "tailscale", timeoutMs = 2000, onError }: WhoisOptions = {}): Whois {
  return {
    loginFor(address, port) {
      if (!isIPv4(address) || !Number.isInteger(port)) {
        reportSafely(onError, `whois skipped: ${JSON.stringify(address)} is not an IPv4 address`);
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        try {
          execFile(bin, ["whois", "--json", `${address}:${port}`], { timeout: timeoutMs }, (err, stdout) => {
            if (err) {
              reportSafely(onError, `whois ${address}:${port} failed: ${err.message.split("\n")[0]}`);
              return resolve(null);
            }
            const parsed = parseWhois(stdout);
            if (parsed.status !== "ok") {
              const reason =
                parsed.status === "not-json"
                  ? `whois ${address}:${port} printed output that isn't JSON`
                  : `whois ${address}:${port} printed no login`;
              reportSafely(onError, reason);
              return resolve(null);
            }
            resolve(parsed.login);
          });
        } catch (err) {
          // execFile itself can throw synchronously for a malformed bin
          // (e.g. a NUL byte), before it ever reaches the callback above.
          const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
          reportSafely(onError, `whois ${address}:${port} failed: ${message}`);
          resolve(null);
        }
      });
    },
  };
}
