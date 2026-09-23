import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { WebSocketServer } from "ws";

// Spike: the hub uses the `ws` server; the channel client will use Node 22's
// built-in WebSocket, so the two must interoperate, including how a silent
// drop looks from the client side.
let wss: WebSocketServer | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
  wss = undefined;
});

async function listen(onConnection: (ws: import("ws").WebSocket) => void): Promise<string> {
  wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  wss.on("connection", onConnection);
  await new Promise<void>((resolve) => wss!.once("listening", () => resolve()));
  return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
}

test("the built-in WebSocket round-trips text with a ws server", async () => {
  const url = await listen((ws) => ws.on("message", (data) => ws.send(`echo:${data.toString()}`)));
  const client = new WebSocket(url);
  await new Promise((resolve) => client.addEventListener("open", resolve, { once: true }));
  const reply = new Promise<string>((resolve) =>
    client.addEventListener("message", (e) => resolve(String(e.data)), { once: true }),
  );
  client.send("hi");
  expect(await reply).toBe("echo:hi");
  client.close();
});

test("a server-side terminate() reaches the built-in client as 1006 with no messages", async () => {
  const url = await listen((ws) => ws.on("message", () => ws.terminate()));
  const client = new WebSocket(url);
  const messages: unknown[] = [];
  client.addEventListener("message", (e) => messages.push(e.data));
  await new Promise((resolve) => client.addEventListener("open", resolve, { once: true }));
  const closed = new Promise<number>((resolve) => client.addEventListener("close", (e) => resolve(e.code)));
  client.send("anything");
  expect(await closed).toBe(1006);
  expect(messages).toEqual([]);
});
