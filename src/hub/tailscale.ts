import { execFile } from "node:child_process";

export class TailscaleError extends Error {
  override name = "TailscaleError";
}

// macOS installs the CLI in different places depending on the distribution
// (App Store app bundle, Homebrew on Apple silicon or Intel). PATH is tried
// first so a user's own choice wins.
export const TAILSCALE_CANDIDATES = [
  "tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
];

export interface ResolvedTailscale {
  bin: string;
  version: string;
}

function tryVersion(bin: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ["version"], { timeout: timeoutMs }, (err, stdout) => {
      const first = String(stdout).split("\n")[0]?.trim() ?? "";
      resolve(err || first === "" ? null : first);
    });
  });
}

// Tailscale mode depends on whois to bind a connection to a tailnet login, so
// a hub that can't find the CLI must not start: every handshake would fail.
export async function resolveTailscale({
  candidates = TAILSCALE_CANDIDATES,
  timeoutMs = 2000,
}: { candidates?: readonly string[]; timeoutMs?: number } = {}): Promise<ResolvedTailscale> {
  for (const bin of candidates) {
    const version = await tryVersion(bin, timeoutMs);
    if (version !== null) return { bin, version };
  }
  throw new TailscaleError(`tailscale CLI not found or not working; tried: ${candidates.join(", ")}`);
}
