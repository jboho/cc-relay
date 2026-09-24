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
  // Wiring bugs must fail loudly here, before any allocation or bind attempt.
  // Handshake is only constructed per connection, so a bad hubId would
  // otherwise surface as an uncaught throw on the first connection instead of
  // at startup; a broken clock has the same problem. A missing whois in
  // tailscale mode is worse: it wouldn't throw at all, it would just silently
  // reject every hello, so it must be checked before pickPort/listen too.
  if (opts.hubId.length !== nacl.sign.publicKeyLength) {
    throw new RangeError("startHub: opts.hubId must be a 32-byte sign public key");
  }
  const now = opts.now ?? Date.now;
  if (!Number.isFinite(now())) {
    throw new RangeError("startHub: opts.now() must return a finite clock value");
  }
  if (opts.mode === "tailscale" && !opts.whois) {
    throw new Error("startHub: opts.whois is required in tailscale mode");
  }
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
  // A malformed upgrade (bad method, bad Upgrade/Sec-WebSocket-Key/Version,
  // an unacceptable protocol/extensions header) makes ws abort the handshake
  // itself. Left to its default, that's a 400 Bad Request with a text/html
  // body — a fingerprint distinguishing this hub from a closed port. Answer
  // with the same bare 404 as everything else instead. This socket already
  // has the error listener attached below (it's added before handleUpgrade
  // is ever called), so an RST here can't crash the process either.
  wss.on("wsClientError", (_err, socket) => socket.end(RAW_404));

  http.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Node removes its own listener for the raw socket's 'error' event before
    // emitting 'upgrade', so a client that resets the connection right after
    // an upgrade (wrong path, over the pending cap, or any ws-level abort
    // below) would otherwise throw an uncaught EPIPE/ECONNRESET and crash the
    // whole process. Attach a listener first, before anything that could
    // write to or close this socket. ws attaches its own once handleUpgrade
    // runs; this one stays as a backstop for the branches that return first.
    socket.on("error", () => socket.destroy());

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
    let released = false;
    // ws aborts a malformed upgrade (bad method/headers/key/version/protocol,
    // a half-closed socket, or its own 503-after-close()) without ever
    // invoking the handleUpgrade callback below, so releasing only from
    // onConnection would leak this slot forever on those paths. The raw
    // socket's own close fires on every path, successful handshake included,
    // so tie the release to that instead; the auth-time release below reuses
    // this same function, and the flag makes either caller safe first.
    const release = () => {
      if (!released) {
        released = true;
        pending--;
      }
    };
    socket.once("close", release);
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req, release));
  });

  function onConnection(ws: WebSocket, req: IncomingMessage, release: () => void): void {
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
    let busy = false;
    let conn: Conn | undefined;

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
      release();
      authed.delete(ws);
      if (conn) router.detach(conn);
    });
    ws.on("pong", () => {
      const state = authed.get(ws);
      if (state) state.alive = true;
    });

    ws.on("message", async (data, isBinary) => {
      try {
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
          release();
          conn = {
            id,
            // "ack" means the frame was handed to the target's ws socket, not
            // that it was end-to-end delivered: ws silently drops a send on a
            // closing/closed socket, and a half-open TCP peer won't surface
            // that until the next ping sweep catches it. The design's own
            // `send` result for this is "sent", not "delivered".
            send: (f) => ws.send(JSON.stringify(f)),
            close: (code, reason) => ws.close(code, reason),
          };
          authed.set(ws, { alive: true });
          router.attach(conn);
          return ws.send(JSON.stringify({ type: "ready" }));
        }
        return kill();
      } catch (err) {
        // handshake.onHello/onAuth and router.route throw a RangeError only on
        // a local wiring bug (e.g. a clock that turns non-finite after the
        // startup validation above). That must not become a silent peer
        // rejection or an unhandled rejection with the connection left
        // half-open: fail closed toward the peer (kill, silent) and loud
        // toward the operator (rethrow).
        kill();
        throw err;
      }
    });
  }

  const port = opts.port ?? (await pickPort(opts.host));
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen({ host: opts.host, port, exclusive: true }, () => {
      http.off("error", reject);
      resolve();
    });
  });

  // Only started once listen has succeeded: starting it earlier would leak
  // the interval on a failed listen (e.g. EADDRINUSE), since close() would
  // then never be called to clear it. Only authenticated connections are
  // pinged; pre-auth ones are bounded by the auth timeout instead.
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
