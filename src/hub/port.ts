import { randomBytes, randomInt } from "node:crypto";
import { createServer } from "node:net";

// Below the macOS (49152+) and Linux (32768+) ephemeral ranges, so an outgoing
// connection can't happen to be holding the hub's port.
export const PORT_MIN = 20000;
export const PORT_MAX = 32767;

export class PortError extends Error {
  override name = "PortError";
}

export function randomPort(): number {
  return randomInt(PORT_MIN, PORT_MAX + 1);
}

export function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ host, port, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

export async function pickPort(
  host: string,
  { attempts = 10, candidate = randomPort }: { attempts?: number; candidate?: () => number } = {},
): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    const port = candidate();
    if (await isPortFree(host, port)) return port;
  }
  throw new PortError(`no free port on ${host} after ${attempts} attempts`);
}

// 16 random bytes → 22 base64url chars.
export function generatePath(): string {
  return randomBytes(16).toString("base64url");
}
