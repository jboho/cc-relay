import { chmodSync, mkdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { EX_USAGE, main, USAGE } from "../../src/cli/main.js";
import { loadHub, loadIdentity } from "../../src/channel/config.js";
import { tempHomes } from "../channel/helpers.js";
import { fakeIo } from "./helpers.js";

const nextHome = tempHomes("cli-main");

describe("main", () => {
  test("no command prints usage and exits 64; help exits 0", async () => {
    const io = fakeIo(nextHome());
    expect(await main([], io)).toBe(EX_USAGE);
    expect(io.stdout).toEqual([USAGE]);
    expect(await main(["--help"], fakeIo(nextHome()))).toBe(0);
  });

  test.each([
    [["frobnicate"], "unknown command: frobnicate"],
    [["init"], "init needs --alias"],
    [["init", "--alias", "a", "--bogus"], "Unknown option"],
    [["init", "--alias", "a", "--host", "--mode", "wan"], "--mode must be one of"],
    [["init", "--alias", "a", "--host", "--port", "70000"], "--port must be"],
    [["init", "--alias", "a", "--host", "--port", "1e3"], "--port must be"],
    [["add"], "expected exactly one card"],
    [["add", "x", "y"], "expected exactly one card"],
    [["add", "x", "--via", "carrier-pigeon"], "--via must be one of"],
    [["remove"], "expected exactly one alias"],
    [["list", "extra"], "list takes no arguments"],
  ])("%j is a usage error", async (argv, message) => {
    const io = fakeIo(nextHome());
    expect(await main(argv, io)).toBe(EX_USAGE);
    expect(io.stderr[0]).toContain(message);
    expect(io.stderr[1]).toBe(USAGE);
  });

  test("init parses its flags", async () => {
    const home = nextHome();
    expect(await main(["init", "--alias", "alice", "--host", "--mode", "loopback", "--port", "23456", "--name", "127.0.0.1"], fakeIo(home))).toBe(0);
    expect(loadIdentity(home).alias).toBe("alice");
    expect(loadHub(home)).toMatchObject({ mode: "loopback", port: 23456, name: "127.0.0.1" });
  });

  test("a problem the user can fix prints one line and exits 1, without a stack trace", async () => {
    const home = nextHome();
    const io = fakeIo(home);
    expect(await main(["list"], io)).toBe(1);
    expect(io.stderr).toHaveLength(1);
    expect(io.stderr[0]).toMatch(/^cc-relay: /);

    const open = nextHome();
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    const io2 = fakeIo(open);
    expect(await main(["init", "--alias", "bob"], io2)).toBe(1);
    expect(io2.stderr[0]).toContain("chmod");
  });

  test("a bad card is reported, not thrown", async () => {
    const home = nextHome();
    await main(["init", "--alias", "bob"], fakeIo(home));
    const io = fakeIo(home);
    expect(await main(["add", "not-a-card"], io)).toBe(1);
    expect(io.stderr[0]).toMatch(/^cc-relay: /);
  });
});
