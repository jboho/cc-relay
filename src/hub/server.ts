import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import nacl from "tweetnacl";
import { type WebSocket, WebSocketServer } from "ws";
import { parseClientFrame } from "../protocol/frames.js";
import { ReplayGuard } from "../protocol/replay.js";
import { type HubMode, validateBind } from "./bind.js";
import { type AllowedPeer, Handshake, HELLO_NONCE_TTL_MS } from "./handshake.js";
import { pickPort } from "./port.js";
import { type Conn, Router } from "./router.js";
import type { Whois } from "./whois.js";

export const MAX_PAYLOAD_BYTES = 128 * 1024;

export interface HubOptions {
  mode: HubMode;
  host: string;
  path: string;
  hubId: Uint8Array;
  allow: ReadonlyMap<string, AllowedPeer>;
  port?: number;
  whois?: Whois;
  now?: () => number;
  authTimeoutMs?: number;
  maxPending?: number;
  pingIntervalMs?: number;
}

export interface RunningHub {
  port: number;
  close(): Promise<void>;
}

const RAW_404 = "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

export async function startHub(opts: HubOptions): Promise<RunningHub> {
  validateBind(opts.mode, opts.host);
  const now = opts.now ?? Date.now;
  const authTimeoutMs = opts.authTimeoutMs ?? 5000;
  const maxPending = opts.maxPending ?? 8;
  const pingIntervalMs = opts.pingIntervalMs ?? 30_000;
  const expectedUrl = `/${opts.path}`;

  const helloNonces = new ReplayGuard(HELLO_NONCE_TTL_MS);
  const router = new Router(new Set(opts.allow.keys()), now);
  const authed = new Map<WebSocket, { alive: boolean }>();
  let pending = 0;

  // Plain HTTP and wrong paths get the same bare 404 as any closed service:
  // no Server or Date header, nothing that identifies the hub.
  const http = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.sendDate = false;
    res.writeHead(404, { Connection: "close", "Content-Length": "0" });
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  http.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (req.url !== expectedUrl) {
      socket.end(RAW_404);
      return;
    }
    // Over the cap, drop before the upgrade so the client never sees an open.
    if (pending >= maxPending) {
      socket.destroy();
      return;
    }
    pending++;
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req));
  });

  function onConnection(ws: WebSocket, req: IncomingMessage): void {
    const handshake = new Handshake({
      mode: opts.mode,
      hubId: opts.hubId,
      allow: opts.allow,
      helloNonces,
      now,
      randomBytes: nacl.randomBytes,
      ...(opts.whois ? { whois: opts.whois } : {}),
      remote: { address: req.socket.remoteAddress ?? "", port: req.socket.remotePort ?? 0 },
    });
    let counted = true;
    let busy = false;
    let conn: Conn | undefined;

    const releasePending = () => {
      if (counted) {
        counted = false;
        pending--;
      }
    };
    // terminate() drops the TCP socket without a close frame: the client sees
    // 1006 and learns nothing about why.
    const kill = () => {
      handshake.fail();
      ws.terminate();
    };
    const authTimer = setTimeout(kill, authTimeoutMs);

    ws.on("error", kill);
    ws.on("close", () => {
      clearTimeout(authTimer);
      releasePending();
      authed.delete(ws);
      if (conn) router.detach(conn);
    });
    ws.on("pong", () => {
      const state = authed.get(ws);
      if (state) state.alive = true;
    });

    ws.on("message", async (data, isBinary) => {
      // Any frame while a hello is still being checked is out of protocol.
      if (busy || isBinary) return kill();
      const frame = parseClientFrame(data.toString("utf8"));
      if (!frame) return kill();

      if (conn) {
        if (frame.type !== "msg") return kill();
        return router.route(conn, frame);
      }

      if (frame.type === "hello") {
        busy = true;
        const reply = await handshake.onHello(frame);
        busy = false;
        if (ws.readyState !== ws.OPEN) return;
        if (!reply) return kill();
        return ws.send(JSON.stringify(reply));
      }
      if (frame.type === "auth") {
        const id = handshake.onAuth(frame);
        if (!id) return kill();
        clearTimeout(authTimer);
        releasePending();
        conn = {
          id,
          send: (f) => ws.send(JSON.stringify(f)),
          close: (code, reason) => ws.close(code, reason),
        };
        authed.set(ws, { alive: true });
        router.attach(conn);
        return ws.send(JSON.stringify({ type: "ready" }));
      }
      return kill();
    });
  }

  // Only authenticated connections are pinged; pre-auth ones are bounded by
  // the auth timeout instead.
  const pingTimer = setInterval(() => {
    for (const [ws, state] of authed) {
      if (!state.alive) {
        ws.terminate();
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }, pingIntervalMs);

  const port = opts.port ?? (await pickPort(opts.host));
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen({ host: opts.host, port, exclusive: true }, () => {
      http.off("error", reject);
      resolve();
    });
  });

  return {
    port,
    close: async () => {
      clearInterval(pingTimer);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
