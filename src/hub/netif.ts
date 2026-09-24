import { networkInterfaces } from "node:os";
import { BindError, type HubMode, validateBind } from "./bind.js";

export type Interfaces = ReturnType<typeof networkInterfaces>;

export const DEFAULT_LAN_IFACE = "en0";

function ipv4On(interfaces: Interfaces, name: string): string[] {
  return (interfaces[name] ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => a.address);
}

function describe(interfaces: Interfaces): string {
  const rows = Object.keys(interfaces).flatMap((name) => ipv4On(interfaces, name).map((ip) => `${name}=${ip}`));
  return rows.length === 0 ? "none" : rows.join(", ");
}

// Picks the one address the hub binds. LAN mode uses a named interface rather
// than "the only private address" because VM and container bridges (e.g.
// bridge100 = 192.168.64.1) also carry RFC1918 addresses; binding one of those
// would expose the hub to guests and hide it from the Wi-Fi peer.
export function resolveBindHost(
  mode: HubMode,
  { iface, interfaces = networkInterfaces() }: { iface?: string; interfaces?: Interfaces } = {},
): string {
  switch (mode) {
    case "loopback":
      return "127.0.0.1";
    case "lan": {
      const name = iface ?? DEFAULT_LAN_IFACE;
      const addrs = ipv4On(interfaces, name);
      if (addrs.length !== 1) {
        throw new BindError(
          `interface ${name} has ${addrs.length} IPv4 addresses; pass --iface. Candidates: ${describe(interfaces)}`,
        );
      }
      const host = addrs[0] as string;
      try {
        validateBind("lan", host);
      } catch (e) {
        if (!(e instanceof BindError)) throw e;
        throw new BindError(`${e.message}; pass --iface. Candidates: ${describe(interfaces)}`);
      }
      return host;
    }
    case "tailscale": {
      // Restricted to utun* (macOS Tailscale's tunnel interface) unless the
      // caller names one explicitly: ISPs and mobile hotspots also hand out
      // carrier-grade NAT addresses from 100.64.0.0/10 on physical interfaces
      // like en0, so if Tailscale is down that address would otherwise be the
      // single match and the hub would bind to the carrier network instead of
      // the tailnet.
      // utun isn't unique to Tailscale, either: Cloudflare WARP also assigns
      // itself a CGNAT address (100.96.0.0/12, inside the 100.64.0.0/10 range
      // checked below) on a utun interface, so if Tailscale is down and WARP
      // is up, WARP's address could become the single "match" here instead.
      // This utun* filter is macOS-only; Linux Tailscale uses tailscale0.
      const names = iface !== undefined ? [iface] : Object.keys(interfaces).filter((name) => name.startsWith("utun"));
      const hits = names.flatMap((name) =>
        ipv4On(interfaces, name).filter((ip) => {
          try {
            validateBind("tailscale", ip);
            return true;
          } catch (e) {
            if (e instanceof BindError) return false;
            throw e;
          }
        }),
      );
      if (hits.length !== 1) {
        // An explicit --iface already names the interface to use, so a
        // mismatch here isn't "Tailscale may be down" (the utun* search
        // wasn't even used) and there's nothing more to tell the caller to
        // pass --iface for; only the auto-detect path gets that hint.
        const where = iface !== undefined ? `on interface ${iface}` : "on a utun interface";
        const hint = iface === undefined && hits.length === 0 ? " (Tailscale may be down; pass --iface to pick an interface manually)" : "";
        throw new BindError(
          `expected exactly one tailscale (100.64.0.0/10) address ${where}, found ${hits.length}${hint}. Candidates: ${describe(interfaces)}`,
        );
      }
      return hits[0] as string;
    }
    default: {
      const unreachable: never = mode;
      throw new BindError(`unknown hub mode ${JSON.stringify(unreachable)}`);
    }
  }
}
