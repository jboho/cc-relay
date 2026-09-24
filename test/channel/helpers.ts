import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Every test home lives under one per-file root that afterAll removes, so a
// failing test never leaves secret-key files behind in $TMPDIR.
export function tempHomes(prefix: string): () => string {
  const root = mkdtempSync(join(tmpdir(), `cc-relay-${prefix}-`));
  let n = 0;
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  return () => join(root, `h${n++}`);
}
