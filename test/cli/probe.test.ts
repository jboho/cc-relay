import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { sntpOffset } from "../../src/cli/probe.js";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("sntpOffset", () => {
  // sntp is a fixed macOS system binary (always /usr/bin/sntp), unlike the
  // Tailscale CLI, which is deliberately looked up on PATH because it's
  // installed in different places depending on how a user got it. Calling
  // sntp by an absolute path means a decoy earlier on PATH can never run in
  // its place.
  test("calls sntp by its absolute path, not through PATH", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-relay-sntp-"));
    tempDirs.push(dir);
    const marker = join(dir, "ran");
    const decoy = join(dir, "sntp");
    writeFileSync(decoy, `#!/bin/sh\ntouch ${marker}\necho "+999.0 +/- 0.1 decoy 0.0.0.0"\n`);
    chmodSync(decoy, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}:${originalPath ?? ""}`;
    try {
      await sntpOffset();
    } finally {
      process.env.PATH = originalPath;
    }
    expect(existsSync(marker)).toBe(false);
  });
});
