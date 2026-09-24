import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { EX_USAGE, main, USAGE } from "../../src/cli/main.js";
import { loadHub, loadIdentity, paths } from "../../src/channel/config.js";
import { toB64u } from "../../src/protocol/encoding.js";
import { resolveTailscale, TailscaleError } from "../../src/hub/tailscale.js";
import { tempHomes } from "../channel/helpers.js";
import { fakeIo } from "./helpers.js";

// main() can't inject HubDeps, so a tailscale-mode hub() resolves its bind
// host against this Mac's real interfaces. That has nothing to do with what
// this suite tests (main's error-mapping), and this machine likely has no
// utun address, which would throw a BindError before resolveTailscale is
// even reached -- passing the assertions below for the wrong reason. Mocked
// here instead of via HubDeps so the real resolveBindHost keeps running for
// every other mode these tests use (loopback, lan).
vi.mock("../../src/hub/netif.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hub/netif.js")>();
  return {
    ...actual,
    resolveBindHost: (...args: Parameters<typeof actual.resolveBindHost>) =>
      args[0] === "tailscale" ? "100.101.102.103" : actual.resolveBindHost(...args),
  };
});

// A vi.fn() wrapping the real implementation by default, so every test in
// this file but the one below still exercises the actual resolveTailscale;
// that test overrides it for a single call with mockRejectedValueOnce.
vi.mock("../../src/hub/tailscale.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hub/tailscale.js")>();
  return { ...actual, resolveTailscale: vi.fn(actual.resolveTailscale) };
});

const nextHome = tempHomes("cli-main");

describe("main", () => {
  // Only one test below queues a mockRejectedValueOnce on resolveTailscale. If
  // that test failed before main(["hub"]) consumed it, the queued rejection
  // would otherwise leak into whichever test runs next and reject a call that
  // expected the real passthrough behavior. mockReset() alone would also wipe
  // out that passthrough (vi.fn(actual.resolveTailscale)'s own initial
  // implementation), so it's restored right after.
  afterEach(async () => {
    const actual = await vi.importActual<typeof import("../../src/hub/tailscale.js")>("../../src/hub/tailscale.js");
    vi.mocked(resolveTailscale).mockReset();
    vi.mocked(resolveTailscale).mockImplementation(actual.resolveTailscale);
  });

  test("help, --help and -h print usage on stdout and exit 0", async () => {
    for (const argv of [["help"], ["--help"], ["-h"]]) {
      const io = fakeIo(nextHome());
      expect(await main(argv, io)).toBe(0);
      expect(io.stdout).toEqual([USAGE]);
      expect(io.stderr).toEqual([]);
    }
  });

  test("a subcommand followed by --help or -h prints usage on stdout and exits 0, same as bare --help", async () => {
    for (const argv of [["init", "--help"], ["add", "-h"], ["list", "--help"], ["remove", "--help"]]) {
      const io = fakeIo(nextHome());
      expect(await main(argv, io)).toBe(0);
      expect(io.stdout).toEqual([USAGE]);
      expect(io.stderr).toEqual([]);
    }
  });

  test.each([
    [[], "no command given"],
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
    [["channel", "extra"], "channel takes no arguments"],
    [["frobnicate", "--help"], "unknown command: frobnicate"],
  ])("%j is a usage error", async (argv, message) => {
    const io = fakeIo(nextHome());
    expect(await main(argv, io)).toBe(EX_USAGE);
    expect(io.stdout).toEqual([]);
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

  test("hub reports a port already in use as a setup error, not a stack trace", async () => {
    const home = nextHome();
    await main(
      ["init", "--alias", "alice", "--host", "--mode", "loopback", "--port", "23997", "--name", "127.0.0.1"],
      fakeIo(home),
    );
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen({ host: "127.0.0.1", port: 23997, exclusive: true }, () => resolve());
    });
    try {
      const io = fakeIo(home);
      expect(await main(["hub"], io)).toBe(1);
      expect(io.stderr).toHaveLength(1);
      expect(io.stderr[0]).toMatch(/^cc-relay: /);
      expect(io.stderr[0]).toContain("23997");
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  test("errno causes are appended to any expected setup error's message, not just PortError's", async () => {
    const home = nextHome();
    await main(["init", "--alias", "alice"], fakeIo(home));
    chmodSync(paths(home).identity, 0o000);
    try {
      const io = fakeIo(home);
      expect(await main(["list"], io)).toBe(1);
      expect(io.stderr).toHaveLength(1);
      expect(io.stderr[0]).toMatch(/^cc-relay: /);
      expect(io.stderr[0]).toContain("EACCES");
    } finally {
      chmodSync(paths(home).identity, 0o600);
    }
  });

  test("an errno already embedded in the thrower's own message is not appended a second time", async () => {
    const blocker = nextHome();
    writeFileSync(blocker, "not a directory", { mode: 0o600 });
    const home = `${blocker}/sub`;
    const io = fakeIo(home);
    expect(await main(["init", "--alias", "alice"], io)).toBe(1);
    expect(io.stderr).toHaveLength(1);
    const line = io.stderr[0] ?? "";
    expect(line).toMatch(/^cc-relay: /);
    expect(line.match(/\(ENOTDIR\)/g)).toHaveLength(1);
  });

  test("hub reports a tailscale setup problem as a setup error, not a stack trace", async () => {
    const home = nextHome();
    // Fine to init --mode tailscale directly here (unlike hub(), which needs
    // this Mac's absent real utun address): resolveBindHost is mocked above
    // for the tailscale case, and an explicit --port skips the real
    // port-picking probe that would otherwise try to bind that fake address.
    await main(
      [
        "init",
        "--alias",
        "alice",
        "--host",
        "--mode",
        "tailscale",
        "--port",
        "23998",
        "--tailscale-login",
        "alice@example.com",
      ],
      fakeIo(home),
    );
    expect(loadHub(home)).toMatchObject({ mode: "tailscale" });
    vi.mocked(resolveTailscale).mockRejectedValueOnce(
      new TailscaleError("tailscale CLI not found or not working; tried: none"),
    );
    const io = fakeIo(home);
    expect(await main(["hub"], io)).toBe(1);
    expect(io.stderr).toHaveLength(1);
    expect(io.stderr[0]).toMatch(/^cc-relay: /);
    expect(io.stderr[0]).toContain("tailscale CLI not found or not working; tried: none");
  });

  test("init under an unwritable parent reports a setup error, not a stack trace", async () => {
    const parent = mkdtempSync(join(tmpdir(), "cc-relay-main-locked-"));
    chmodSync(parent, 0o500);
    try {
      const io = fakeIo(join(parent, "home"));
      expect(await main(["init", "--alias", "dave"], io)).toBe(1);
      expect(io.stderr).toHaveLength(1);
      expect(io.stderr[0]).toMatch(/^cc-relay: /);
    } finally {
      chmodSync(parent, 0o700);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a card that is valid base64url but not valid UTF-8 does not leak a Node-internal error code", async () => {
    const home = nextHome();
    await main(["init", "--alias", "alice"], fakeIo(home));
    const io = fakeIo(home);
    // 0xff alone is not a valid UTF-8 byte sequence, but any byte string has a
    // canonical base64url encoding, so this clears decodeCard's base64url
    // check and fails only at the fatal TextDecoder step, the same path a
    // Node-internal ERR_ENCODING_INVALID_ENCODED_DATA would come from.
    const badCard = toB64u(new Uint8Array([0xff]));
    expect(await main(["add", badCard], io)).toBe(1);
    expect(io.stderr).toHaveLength(1);
    expect(io.stderr[0]).toMatch(/^cc-relay: /);
    expect(io.stderr[0]).not.toContain("ERR_");
  });

  test("an error that is not a known setup problem is rethrown, not turned into exit 1", async () => {
    const home = nextHome();
    await main(["init", "--alias", "carol"], fakeIo(home));
    const io = fakeIo(home);
    const boom = new Error("boom");
    io.out = () => {
      throw boom;
    };
    await expect(main(["list"], io)).rejects.toBe(boom);
  });
});
