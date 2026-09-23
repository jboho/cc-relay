import { describe, expect, test } from "vitest";
import { BindError, type HubMode, validateBind } from "../../src/hub/bind.js";

describe("validateBind", () => {
  test("accepts each mode's own range", () => {
    expect(() => validateBind("tailscale", "100.64.0.1")).not.toThrow();
    expect(() => validateBind("tailscale", "100.127.255.254")).not.toThrow();
    expect(() => validateBind("lan", "192.168.1.25")).not.toThrow();
    expect(() => validateBind("lan", "10.1.2.3")).not.toThrow();
    expect(() => validateBind("lan", "172.31.0.1")).not.toThrow();
    expect(() => validateBind("loopback", "127.0.0.1")).not.toThrow();
    expect(() => validateBind("lan", "10.0.0.0")).not.toThrow();
    expect(() => validateBind("lan", "10.255.255.255")).not.toThrow();
    expect(() => validateBind("lan", "172.16.0.0")).not.toThrow();
    expect(() => validateBind("lan", "172.31.255.255")).not.toThrow();
    expect(() => validateBind("lan", "192.168.0.0")).not.toThrow();
    expect(() => validateBind("lan", "192.168.255.255")).not.toThrow();
  });

  test("refuses wildcards and non-IPv4 hosts in every mode", () => {
    for (const mode of ["tailscale", "lan", "loopback"] as const) {
      for (const host of ["0.0.0.0", "::", "localhost", "", "192.168.1.256", "::ffff:127.0.0.1"]) {
        expect(() => validateBind(mode, host)).toThrow(BindError);
      }
    }
  });

  test("refuses addresses from the wrong range", () => {
    expect(() => validateBind("tailscale", "100.63.255.255")).toThrow(BindError);
    expect(() => validateBind("tailscale", "100.128.0.0")).toThrow(BindError);
    expect(() => validateBind("tailscale", "192.168.1.25")).toThrow(BindError);
    expect(() => validateBind("lan", "100.64.0.1")).toThrow(BindError);
    expect(() => validateBind("lan", "172.32.0.1")).toThrow(BindError);
    expect(() => validateBind("lan", "8.8.8.8")).toThrow(BindError);
    expect(() => validateBind("loopback", "127.0.0.2")).toThrow(BindError);
    expect(() => validateBind("lan", "9.255.255.255")).toThrow(BindError);
    expect(() => validateBind("lan", "11.0.0.0")).toThrow(BindError);
    expect(() => validateBind("lan", "172.15.255.255")).toThrow(BindError);
    expect(() => validateBind("lan", "172.32.0.0")).toThrow(BindError);
    expect(() => validateBind("lan", "192.167.255.255")).toThrow(BindError);
    expect(() => validateBind("lan", "192.169.0.0")).toThrow(BindError);
  });

  test("refuses an unknown hub mode", () => {
    expect(() => validateBind("wan" as HubMode, "127.0.0.1")).toThrow(BindError);
  });
});
