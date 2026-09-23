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

// Any failure (tailscale missing, timeout, not a tailnet peer) returns null,
// which the handshake treats as a mismatch: fail closed.
export function tailscaleWhois({ bin = "tailscale", timeoutMs = 2000 } = {}): Whois {
  return {
    loginFor(address, port) {
      if (!isIPv4(address) || !Number.isInteger(port)) return Promise.resolve(null);
      return new Promise((resolve) => {
        execFile(bin, ["whois", "--json", `${address}:${port}`], { timeout: timeoutMs }, (err, stdout) =>
          resolve(err ? null : parseWhois(stdout)),
        );
      });
    },
  };
}
