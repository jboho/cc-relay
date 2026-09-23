import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { parseWhois, tailscaleWhois } from "../../src/hub/whois.js";

// Shape as documented for `tailscale whois --json`. Real output from a
// shared-in user is checked in M6.
const SAMPLE = JSON.stringify({
  Node: { ID: 1, Name: "peer-laptop.tail1234.ts.net." },
  UserProfile: { ID: 2, LoginName: "peer@example.com", DisplayName: "Peer" },
});

const tempDirs: string[] = [];

function fakeTailscale(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-relay-whois-"));
  tempDirs.push(dir);
  const bin = join(dir, "tailscale");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("parseWhois", () => {
  test("extracts the login name", () => {
    expect(parseWhois(SAMPLE)).toBe("peer@example.com");
  });

  test("returns null for bad JSON or a missing login", () => {
    expect(parseWhois("nope")).toBeNull();
    expect(parseWhois(JSON.stringify({ UserProfile: {} }))).toBeNull();
    expect(parseWhois(JSON.stringify({ UserProfile: { LoginName: "" } }))).toBeNull();
  });
});

describe("tailscaleWhois", () => {
  test("passes exactly ip:port as a single argument and parses the result", async () => {
    const bin = fakeTailscale(
      `[ $# -eq 3 ] && [ "$1 $2 $3" = "whois --json 100.64.0.5:41000" ] || exit 9\necho '${SAMPLE}'`,
    );
    expect(await tailscaleWhois({ bin }).loginFor("100.64.0.5", 41000)).toBe("peer@example.com");
  });

  test("returns null when the command fails or is missing", async () => {
    expect(await tailscaleWhois({ bin: fakeTailscale("exit 1") }).loginFor("100.64.0.5", 1)).toBeNull();
    expect(await tailscaleWhois({ bin: "/nonexistent/tailscale" }).loginFor("100.64.0.5", 1)).toBeNull();
    // A non-zero exit must win even when stdout looks valid: fail closed, not "parse whatever printed."
    expect(
      await tailscaleWhois({ bin: fakeTailscale(`echo '${SAMPLE}'\nexit 1`) }).loginFor("100.64.0.5", 1),
    ).toBeNull();
  });

  test("returns null on timeout", async () => {
    expect(
      await tailscaleWhois({ bin: fakeTailscale("sleep 5"), timeoutMs: 100 }).loginFor("100.64.0.5", 1),
    ).toBeNull();
    // Same as above, but the process also produced valid stdout before hanging.
    expect(
      await tailscaleWhois({ bin: fakeTailscale(`echo '${SAMPLE}'\nsleep 5`), timeoutMs: 100 }).loginFor(
        "100.64.0.5",
        1,
      ),
    ).toBeNull();
  });

  test("returns null for a non-integer port", async () => {
    const bin = fakeTailscale(`echo '${SAMPLE}'`);
    expect(await tailscaleWhois({ bin }).loginFor("100.64.0.5", 1.5)).toBeNull();
    expect(await tailscaleWhois({ bin }).loginFor("100.64.0.5", Number.NaN)).toBeNull();
  });

  test("never runs for a non-IPv4 address", async () => {
    const bin = fakeTailscale(`echo '${SAMPLE}'`);
    expect(await tailscaleWhois({ bin }).loginFor("100.64.0.5; rm -rf /", 1)).toBeNull();
    expect(await tailscaleWhois({ bin }).loginFor("::ffff:100.64.0.5", 1)).toBeNull();
    expect(await tailscaleWhois({ bin }).loginFor("", 1)).toBeNull();
  });
});
