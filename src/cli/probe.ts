import { execFile } from "node:child_process";
import { connect } from "node:net";
import WebSocket from "ws";
import { helloFor } from "../channel/client.js";
import { parseHubFrame } from "../protocol/frames.js";
import type { Identity } from "../protocol/identity.js";
import { MAX_PAYLOAD_BYTES } from "../hub/server.js";

export type ProbeOutcome = "ok" | "refused" | "timeout" | "unresolved" | "notfound" | "rejected" | "unreachable";

// Stops at the challenge on purpose. Answering it would authenticate as this
// identity, and the hub would supersede (close 4001) the live relay session
// that is already connected with the same key. The hub only sends a challenge
// after the allowlist, signature, clock-skew and whois checks pass, so getting
// one proves everything short of the auth signature.
export function probeHub(url: string, hubId: Uint8Array, self: Identity, timeoutMs = 5000): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocket(url, { maxPayload: MAX_PAYLOAD_BYTES, handshakeTimeout: timeoutMs });
    const finish = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.terminate();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    ws.on("unexpected-response", (_req, res) => finish(res.statusCode === 404 ? "notfound" : "rejected"));
    ws.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED") finish("refused");
      else if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") finish("unresolved");
      else if (err.code === "ETIMEDOUT" || err.code === "EHOSTUNREACH" || err.code === "ENETUNREACH") finish("timeout");
      else if (/handshake has timed out/i.test(err.message)) finish("timeout");
      // Anything else (EHOSTDOWN, ENETDOWN, EADDRNOTAVAIL, EPERM, EACCES, ...) means
      // no TCP connection to the host happened — unlike "rejected", which is reserved
      // for a real protocol-level answer (close, a non-404 unexpected-response, or a
      // reply that isn't a challenge).
      else finish("unreachable");
    });
    ws.on("open", () => ws.send(JSON.stringify(helloFor(self, hubId, Date.now()))));
    ws.on("message", (data) => finish(parseHubFrame(data.toString())?.type === "challenge" ? "ok" : "rejected"));
    ws.on("close", () => finish("rejected"));
  });
}

export function canConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

const SNTP_RE = /^([+-]\d+\.\d+) \+\/- /;

export function parseSntp(stdout: string): number | null {
  const m = SNTP_RE.exec(stdout);
  return m?.[1] !== undefined ? Number(m[1]) : null;
}

// Seconds between this clock and time.apple.com, or null if unreachable.
export function sntpOffset(server = "time.apple.com"): Promise<number | null> {
  return new Promise((resolve) => {
    // A non-zero exit is deliberately not checked: a failed lookup leaves stdout
    // unparseable, parseSntp returns null, and the caller turns that into WARN.
    execFile("sntp", ["-t", "2", server], { timeout: 10_000 }, (_err, stdout) => resolve(parseSntp(String(stdout))));
  });
}
