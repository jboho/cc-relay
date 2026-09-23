import { isIPv4 } from "node:net";

export type HubMode = "tailscale" | "lan" | "loopback";

export class BindError extends Error {
  override name = "BindError";
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
}

// Division, not >>> or &: bitwise ops in JS coerce to signed 32-bit ints,
// which corrupts addresses >=128.x; division keeps the math unsigned and exact.
function inCidr(ip: string, base: string, bits: number): boolean {
  const size = 2 ** (32 - bits);
  return Math.floor(ipv4ToInt(ip) / size) === Math.floor(ipv4ToInt(base) / size);
}

const TAILSCALE_CGNAT: [string, number] = ["100.64.0.0", 10];
const RFC1918: [string, number][] = [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
];

// The hub binds exactly one interface. Wildcards would expose it on every
// network the Mac joins, so they're refused in every mode.
export function validateBind(mode: HubMode, host: string): void {
  if (!isIPv4(host)) throw new BindError(`bind host must be an IPv4 address, got ${JSON.stringify(host)}`);
  // Defense in depth: no mode's range below contains 0.0.0.0 today, but this
  // check must stay even if one someday would, so it's never dead code to prune.
  if (host === "0.0.0.0") throw new BindError("refusing to bind 0.0.0.0 (all interfaces)");
  let ok: boolean;
  switch (mode) {
    case "tailscale":
      ok = inCidr(host, ...TAILSCALE_CGNAT);
      break;
    case "lan":
      ok = RFC1918.some(([base, bits]) => inCidr(host, base, bits));
      break;
    case "loopback":
      ok = host === "127.0.0.1";
      break;
    default: {
      const unreachable: never = mode;
      throw new BindError(`unknown hub mode ${JSON.stringify(unreachable)}`);
    }
  }
  if (!ok) throw new BindError(`${host} is not a valid ${mode} address`);
}
