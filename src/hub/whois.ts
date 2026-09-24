import { execFile } from "node:child_process";
import { isIPv4 } from "node:net";
import { z } from "zod";

export interface Whois {
  // The Tailscale login that owns the connecting node, or null if unknown.
  loginFor(address: string, port: number): Promise<string | null>;
}

// Only the field we use. `tailscale whois --json` prints more; zod strips it.
const WhoisJson = z.object({ UserProfile: z.object({ LoginName: z.string().min(1) }) });

export function parseWhois(stdout: string): string | null {
  try {
    const parsed = WhoisJson.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data.UserProfile.LoginName : null;
  } catch {
    return null;
  }
}

export interface WhoisOptions {
  bin?: string;
  timeoutMs?: number;
  // Told why a lookup failed. The handshake stays silent toward the peer, so
  // without this an operator can't tell "not shared" from "tailscale is down".
  onError?: (reason: string) => void;
}

// Any failure (tailscale missing, timeout, not a tailnet peer) returns null,
// which the handshake treats as a mismatch: fail closed.
export function tailscaleWhois({ bin = "tailscale", timeoutMs = 2000, onError }: WhoisOptions = {}): Whois {
  return {
    loginFor(address, port) {
      if (!isIPv4(address) || !Number.isInteger(port)) {
        onError?.(`whois skipped: ${JSON.stringify(address)} is not an IPv4 address`);
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        execFile(bin, ["whois", "--json", `${address}:${port}`], { timeout: timeoutMs }, (err, stdout) => {
          if (err) {
            onError?.(`whois ${address}:${port} failed: ${err.message.split("\n")[0]}`);
            return resolve(null);
          }
          const login = parseWhois(stdout);
          if (login === null) onError?.(`whois ${address}:${port} printed no login`);
          resolve(login);
        });
      });
    },
  };
}
