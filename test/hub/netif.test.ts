import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, test } from "vitest";
import { BindError } from "../../src/hub/bind.js";
import { type Interfaces, resolveBindHost } from "../../src/hub/netif.js";

function v4(address: string, internal = false): NetworkInterfaceInfo {
  return { address, netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal, cidr: null };
}

function v6(address: string): NetworkInterfaceInfo {
  return { address, netmask: "ffff::", family: "IPv6", mac: "00:00:00:00:00:00", internal: false, cidr: null, scopeid: 0 };
}

// Shape of this Mac on 2026-09-23: Wi-Fi on en0 plus a VM bridge.
const MAC: Interfaces = {
  lo0: [v4("127.0.0.1", true), v6("::1")],
  en0: [v6("fe80::1"), v4("192.168.1.25")],
  bridge100: [v4("192.168.64.1")],
};

describe("resolveBindHost", () => {
  test("loopback always binds 127.0.0.1", () => {
    expect(resolveBindHost("loopback", { interfaces: {} })).toBe("127.0.0.1");
  });

  test("lan picks en0 by default, not the VM bridge", () => {
    expect(resolveBindHost("lan", { interfaces: MAC })).toBe("192.168.1.25");
  });

  test("lan honours an explicit interface", () => {
    expect(resolveBindHost("lan", { iface: "bridge100", interfaces: MAC })).toBe("192.168.64.1");
  });

  test("lan throws BindError listing candidates when the interface has no IPv4 address", () => {
    expect(() => resolveBindHost("lan", { iface: "en7", interfaces: MAC })).toThrow(BindError);
    expect(() => resolveBindHost("lan", { iface: "en7", interfaces: MAC })).toThrow(/en0=192\.168\.1\.25/);
  });

  test("lan throws when the interface has more than one IPv4 address", () => {
    const two: Interfaces = { en0: [v4("192.168.1.25"), v4("192.168.1.26")] };
    expect(() => resolveBindHost("lan", { interfaces: two })).toThrow(/has 2 IPv4 addresses/);
  });

  test("lan refuses a public address on the interface", () => {
    expect(() => resolveBindHost("lan", { interfaces: { en0: [v4("203.0.113.9")] } })).toThrow(BindError);
  });

  test("tailscale picks the one 100.64/10 address on any interface", () => {
    expect(resolveBindHost("tailscale", { interfaces: { ...MAC, utun4: [v4("100.101.102.103")] } })).toBe(
      "100.101.102.103",
    );
  });

  test("tailscale ignores 100.x addresses outside 100.64/10", () => {
    expect(() => resolveBindHost("tailscale", { interfaces: { utun4: [v4("100.128.0.1")] } })).toThrow(/found 0/);
  });

  test("tailscale throws when there is none, or more than one", () => {
    expect(() => resolveBindHost("tailscale", { interfaces: MAC })).toThrow(/found 0/);
    const two: Interfaces = { utun4: [v4("100.64.0.1")], utun5: [v4("100.64.0.2")] };
    expect(() => resolveBindHost("tailscale", { interfaces: two })).toThrow(/found 2/);
  });
});
