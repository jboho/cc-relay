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

// Declared explicitly (rather than relying on Node's execFile default of the
// same size) so the overflow message below always names the limit actually
// in effect, even if that default changes in a future Node version.
export const MAX_OUTPUT_BYTES = 1024 * 1024;

function tryVersion(bin: string, timeoutMs: number): Promise<{ version: string } | { reason: string }> {
  return new Promise((resolve) => {
    execFile(bin, ["version"], { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES }, (err, stdout, stderr) => {
      if (err) {
        // err.killed is only true for a kill node itself issued (our
        // timeout); a signal sent by anything else (the process killing
        // itself, an operator's `kill`) leaves it false with err.signal set,
        // so check killed first to keep those apart.
        if (err.killed) return resolve({ reason: `timed out after ${timeoutMs}ms` });
        // A maxBuffer overflow kills the child too, but Node resolves it with
        // its own error (a RangeError, code ERR_CHILD_PROCESS_STDIO_MAXBUFFER)
        // instead of setting err.killed/err.signal, so it never reaches the
        // err.killed branch above; it gets its own reason rather than being
        // reported as a timeout, since the two causes call for different fixes.
        if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          return resolve({ reason: `output exceeded ${MAX_OUTPUT_BYTES} bytes` });
        }
        if (err.signal) return resolve({ reason: `killed by ${err.signal}` });
        if (typeof err.code === "number") {
          const firstErrLine = String(stderr).split("\n")[0]?.trim() ?? "";
          return resolve({ reason: firstErrLine ? `exit ${err.code}: ${firstErrLine}` : `exit ${err.code}` });
        }
        if (typeof err.code === "string") return resolve({ reason: err.code });
        return resolve({ reason: err.message.split("\n")[0] ?? err.message });
      }
      const first = String(stdout).split("\n")[0]?.trim() ?? "";
      resolve(first === "" ? { reason: "no output" } : { version: first });
    });
  });
}

// Tailscale mode depends on whois to bind a connection to a tailnet login, so
// a hub that can't find the CLI must not start: every handshake would fail.
export async function resolveTailscale({
  candidates = TAILSCALE_CANDIDATES,
  timeoutMs = 2000,
}: { candidates?: readonly string[]; timeoutMs?: number } = {}): Promise<ResolvedTailscale> {
  const tried: string[] = [];
  for (const bin of candidates) {
    const result = await tryVersion(bin, timeoutMs);
    if ("version" in result) return { bin, version: result.version };
    tried.push(`${bin} (${result.reason})`);
  }
  throw new TailscaleError(`tailscale CLI not found or not working; tried: ${tried.join(", ")}`);
}
