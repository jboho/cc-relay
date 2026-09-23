import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// Every runtime dependency is attack surface on both machines (R15), and none
// of these advertise anything over mDNS/Bonjour. Adding one is a design
// decision: update this list in the same commit, with the reason.
const ALLOWED = ["@modelcontextprotocol/sdk", "tweetnacl", "ws", "zod"];

test("runtime dependencies stay within the allowlist", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const runtime = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ];
  expect(runtime.filter((name) => !ALLOWED.includes(name))).toEqual([]);
});

test("tweetnacl is pinned to an exact version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies: Record<string, string>;
  };
  expect(pkg.dependencies.tweetnacl).toMatch(/^\d+\.\d+\.\d+$/);
});
