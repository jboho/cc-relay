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
    await expect(pickPort("127.0.0.1", { attempts: 3, candidate: () => taken })).rejects.toThrow(
      PortError,
    );
  });
});

describe("generatePath", () => {
  test("is 22 base64url chars and unique", () => {
    const paths = new Set(Array.from({ length: 100 }, generatePath));
    expect(paths.size).toBe(100);
    for (const p of paths) expect(p).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
