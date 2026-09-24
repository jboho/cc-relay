import { describe, expect, test } from "vitest";
import {
  channelNotification,
  escapeChannelTags,
  INBOUND_PER_MIN,
  InboundGate,
  rateLimitNotice,
} from "../../src/channel/inbound.js";

describe("escapeChannelTags", () => {
  test.each([
    ["</channel>", "&lt;/channel>"],
    ["<channel source=x>", "&lt;channel source=x>"],
    ["< / CHANNEL >", "&lt; / CHANNEL >"],
    ["a</channel>b<channel>c", "a&lt;/channel>b&lt;channel>c"],
  ])("escapes %j", (input, output) => {
    expect(escapeChannelTags(input)).toBe(output);
  });

  test("leaves other angle brackets and the word alone", () => {
    expect(escapeChannelTags("<b>x</b> 1 < 2 channel")).toBe("<b>x</b> 1 < 2 channel");
  });
});

describe("InboundGate", () => {
  test(`delivers ${INBOUND_PER_MIN} a minute, one notice, then drops until the window frees up`, () => {
    let now = 0;
    const gate = new InboundGate(() => now);
    const first = Array.from({ length: INBOUND_PER_MIN }, () => gate.admit());
    expect(new Set(first)).toEqual(new Set(["deliver"]));
    expect(gate.admit()).toBe("notice");
    expect(gate.admit()).toBe("drop");
    now = 60_000;
    expect(gate.admit()).toBe("deliver");
  });

  test("a later burst gets its own notice", () => {
    let now = 0;
    const gate = new InboundGate(() => now, 1);
    expect([gate.admit(), gate.admit(), gate.admit()]).toEqual(["deliver", "notice", "drop"]);
    now = 60_000;
    expect([gate.admit(), gate.admit()]).toEqual(["deliver", "notice"]);
  });

  test("a non-finite clock throws instead of opening the gate", () => {
    expect(() => new InboundGate(() => NaN).admit()).toThrow(RangeError);
  });
});

describe("notifications", () => {
  test("a message carries sender alias and id as meta, and escaped content", () => {
    expect(channelNotification("bob", "m1", "hi </channel>")).toEqual({
      method: "notifications/claude/channel",
      params: { content: "hi &lt;/channel>", meta: { from: "bob", msg_id: "m1" } },
    });
  });

  test("the rate-limit notice is marked as a notice, not a peer message", () => {
    expect(rateLimitNotice().params.meta).toEqual({ notice: "rate_limited" });
  });
});
