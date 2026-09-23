import { describe, expect, test } from "vitest";
import type { HubFrame, SendFrame } from "../../src/protocol/frames.js";
import { type Conn, RATE_LIMIT_PER_MIN, Router, SUPERSEDED_CODE } from "../../src/hub/router.js";

const A = "A".repeat(43);
const B = "B".repeat(43);
const STRANGER = "S".repeat(43);

function fakeConn(id: string) {
  const sent: HubFrame[] = [];
  const closed: [number, string][] = [];
  const conn: Conn = { id, send: (f) => sent.push(f), close: (c, r) => closed.push([c, r]) };
  return { conn, sent, closed };
}

const msg = (to: string, ref = "r1"): SendFrame => ({
  type: "msg",
  ref,
  to,
  ciphertext: "Y2lwaGVy",
  nonce: "N".repeat(32),
});

function setup(now = () => 0) {
  return new Router(new Set([A, B]), now);
}

describe("Router", () => {
  test("delivers with the sender's authenticated ID and acks", () => {
    const router = setup();
    const a = fakeConn(A);
    const b = fakeConn(B);
    router.attach(a.conn);
    router.attach(b.conn);
    router.route(a.conn, msg(B));
    expect(b.sent).toEqual([{ type: "msg", from: A, ciphertext: "Y2lwaGVy", nonce: "N".repeat(32) }]);
    expect(a.sent).toEqual([{ type: "ack", ref: "r1" }]);
  });

  test("forwards only the documented fields, whatever else the frame object carries", () => {
    const router = setup();
    const a = fakeConn(A);
    const b = fakeConn(B);
    router.attach(a.conn);
    router.attach(b.conn);
    router.route(a.conn, { ...msg(B), from: B, extra: "x" } as unknown as SendFrame);
    expect(b.sent[0]).toEqual({ type: "msg", from: A, ciphertext: "Y2lwaGVy", nonce: "N".repeat(32) });
  });

  test("reports unknown_peer and offline without delivering", () => {
    const router = setup();
    const a = fakeConn(A);
    router.attach(a.conn);
    router.route(a.conn, msg(STRANGER, "r1"));
    router.route(a.conn, msg(B, "r2"));
    expect(a.sent).toEqual([
      { type: "error", ref: "r1", code: "unknown_peer" },
      { type: "error", ref: "r2", code: "offline" },
    ]);
  });

  test("a newer connection supersedes the older one with close code 4001", () => {
    const router = setup();
    const old = fakeConn(A);
    const fresh = fakeConn(A);
    router.attach(old.conn);
    router.attach(fresh.conn);
    expect(old.closed).toEqual([[SUPERSEDED_CODE, "superseded"]]);
    expect(fresh.closed).toEqual([]);
  });

  test("a superseded connection detaching late doesn't unregister its replacement", () => {
    const router = setup();
    const old = fakeConn(A);
    const fresh = fakeConn(A);
    router.attach(old.conn);
    router.attach(fresh.conn);
    router.detach(old.conn);
    expect(router.isConnected(A)).toBe(true);
    router.detach(fresh.conn);
    expect(router.isConnected(A)).toBe(false);
  });

  test("rate-limits at 30 per minute per connection, then recovers", () => {
    let now = 0;
    const router = setup(() => now);
    const a = fakeConn(A);
    const b = fakeConn(B);
    router.attach(a.conn);
    router.attach(b.conn);
    for (let i = 0; i < RATE_LIMIT_PER_MIN + 1; i++) router.route(a.conn, msg(B, `r${i}`));
    expect(b.sent).toHaveLength(RATE_LIMIT_PER_MIN);
    expect(a.sent.at(-1)).toEqual({ type: "error", ref: `r${RATE_LIMIT_PER_MIN}`, code: "rate_limited" });
    now = 60_000;
    router.route(a.conn, msg(B, "later"));
    expect(b.sent).toHaveLength(RATE_LIMIT_PER_MIN + 1);
  });

  test("the rate limit is per connection: one sender's budget doesn't throttle another, and a new connection starts fresh", () => {
    const router = setup();
    const a = fakeConn(A);
    const b = fakeConn(B);
    router.attach(a.conn);
    router.attach(b.conn);
    for (let i = 0; i < RATE_LIMIT_PER_MIN; i++) router.route(a.conn, msg(B, `a${i}`));
    router.route(b.conn, msg(A, "b0"));
    expect(a.sent.filter((f) => f.type === "msg")).toHaveLength(1);
    expect(b.sent.at(-1)).toEqual({ type: "ack", ref: "b0" });

    const a2 = fakeConn(A);
    router.attach(a2.conn);
    router.route(a2.conn, msg(B, "fresh"));
    expect(a2.sent).toEqual([{ type: "ack", ref: "fresh" }]);
  });

  test("rejected sends don't count toward the window", () => {
    let now = 0;
    const router = setup(() => now);
    const a = fakeConn(A);
    const b = fakeConn(B);
    router.attach(a.conn);
    router.attach(b.conn);
    for (let i = 0; i < RATE_LIMIT_PER_MIN; i++) router.route(a.conn, msg(B, `r${i}`));
    now = 30_000;
    for (let i = 0; i < RATE_LIMIT_PER_MIN; i++) router.route(a.conn, msg(B, `x${i}`));
    expect(b.sent).toHaveLength(RATE_LIMIT_PER_MIN);
    now = 60_000;
    router.route(a.conn, msg(B, "later"));
    expect(a.sent.at(-1)).toEqual({ type: "ack", ref: "later" });
  });
});
