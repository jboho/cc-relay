import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { resolveTailscale, TAILSCALE_CANDIDATES, TailscaleError } from "../../src/hub/tailscale.js";

const tempDirs: string[] = [];

function fakeBin(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-relay-ts-"));
  tempDirs.push(dir);
  const bin = join(dir, "tailscale");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("resolveTailscale", () => {
  test("returns the first candidate that answers `version`", async () => {
    const broken = fakeBin("exit 1");
    const good = fakeBin("echo 1.90.0; echo '  tailscale commit: abc'");
    const later = fakeBin("echo 9.9.9");
    expect(await resolveTailscale({ candidates: ["/nonexistent/tailscale", broken, good, later] })).toEqual({
      bin: good,
      version: "1.90.0",
    });
  });

  test("skips a candidate that exits 0 with no output", async () => {
    const silent = fakeBin("exit 0");
    const good = fakeBin("echo 1.90.0");
    expect((await resolveTailscale({ candidates: [silent, good] })).bin).toBe(good);
  });

  test("skips a candidate that hangs past the timeout", async () => {
    const hangs = fakeBin("sleep 5");
    const good = fakeBin("echo 1.90.0");
    // The timeout also covers the good candidate, so leave room for a slow
    // shell start while the rest of the suite (the e2e build) is running.
    expect((await resolveTailscale({ candidates: [hangs, good], timeoutMs: 1000 })).bin).toBe(good);
  });

  test("throws TailscaleError naming every path it tried", async () => {
    const broken = fakeBin("exit 1");
    const err = await resolveTailscale({ candidates: ["/nonexistent/a", broken] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TailscaleError);
    expect((err as Error).message).toContain("/nonexistent/a (ENOENT)");
    expect((err as Error).message).toContain(`${broken} (exit 1)`);
  });

  test("the default candidates try PATH first, then the macOS install locations", () => {
    expect(TAILSCALE_CANDIDATES[0]).toBe("tailscale");
    expect(TAILSCALE_CANDIDATES).toContain("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
  });
});
