import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import {
  generatePath,
  isPortFree,
  pickPort,
  PORT_MAX,
  PORT_MIN,
  PortError,
  randomPort,
} from "../../src/hub/port.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function occupy(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

async function freePort(): Promise<number> {
  const port = await occupy();
  await new Promise((r) => servers.pop()!.close(r));
  return port;
}

describe("ports", () => {
  test("randomPort stays in 20000-32767", () => {
    for (let i = 0; i < 2000; i++) {
      const port = randomPort();
      expect(port).toBeGreaterThanOrEqual(PORT_MIN);
      expect(port).toBeLessThanOrEqual(PORT_MAX);
    }
  });

  test("isPortFree reports an occupied port", async () => {
    const taken = await occupy();
    expect(await isPortFree("127.0.0.1", taken)).toBe(false);
  });

  test("pickPort moves past an occupied port", async () => {
    const taken = await occupy();
    const free = await freePort();
    const sequence = [taken, taken, free];
    expect(await pickPort("127.0.0.1", { candidate: () => sequence.shift()! })).toBe(free);
  });

  test("pickPort gives up after the attempt limit", async () => {
    const taken = await occupy();
    let calls = 0;
    await expect(
      pickPort("127.0.0.1", {
        attempts: 3,
        candidate: () => {
          calls++;
          return taken;
        },
      }),
    ).rejects.toThrow(PortError);
    expect(calls).toBe(3);
  });

  test("pickPort surfaces a host that is not on this machine instead of rerolling", async () => {
    let calls = 0;
    const candidate = () => {
      calls++;
      return 25000;
    };
    // 192.0.2.1 is TEST-NET-1 (RFC 5737): reserved for documentation, never assigned
    // to a real machine, so binding it reliably fails with EADDRNOTAVAIL.
    const err: unknown = await pickPort("192.0.2.1", { candidate }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortError);
    expect((err as PortError & { cause: NodeJS.ErrnoException }).cause.code).toBe(
      "EADDRNOTAVAIL",
    );
    expect(calls).toBe(1);
  });
});

describe("generatePath", () => {
  test("is 22 base64url chars and unique", () => {
    const paths = new Set(Array.from({ length: 100 }, generatePath));
    expect(paths.size).toBe(100);
    for (const p of paths) expect(p).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
