// Claude Code wraps channel content in <channel ...> tags. A peer that writes
// its own closing tag could make the rest of its text read as if it came from
// outside the channel, so any tag-shaped "channel" gets its "<" escaped.
export function escapeChannelTags(text: string): string {
  return text.replace(/<(\s*\/?\s*channel)/gi, "&lt;$1");
}

export const INBOUND_PER_MIN = 10;
const WINDOW_MS = 60_000;

export type GateDecision = "deliver" | "notice" | "drop";

// Caps how much peer text reaches the model per minute, whatever the hub
// allows. The first message over the cap becomes a single notice so the
// session knows something was dropped; the rest of that burst are dropped.
export class InboundGate {
  private readonly times: number[] = [];
  private noticed = false;

  constructor(
    private readonly now: () => number,
    private readonly perMin = INBOUND_PER_MIN,
  ) {}

  admit(): GateDecision {
    const t = this.now();
    if (!Number.isFinite(t)) throw new RangeError("InboundGate: now() must return a finite clock value");
    while (this.times.length > 0 && (this.times[0] as number) <= t - WINDOW_MS) this.times.shift();
    if (this.times.length < this.perMin) {
      this.times.push(t);
      this.noticed = false;
      return "deliver";
    }
    if (this.noticed) return "drop";
    this.noticed = true;
    return "notice";
  }
}

export interface ChannelNotification {
  method: "notifications/claude/channel";
  params: { content: string; meta: Record<string, string> };
}

export function channelNotification(from: string, msgId: string, text: string): ChannelNotification {
  return {
    method: "notifications/claude/channel",
    params: { content: escapeChannelTags(text), meta: { from, msg_id: msgId } },
  };
}

export function rateLimitNotice(): ChannelNotification {
  return {
    method: "notifications/claude/channel",
    params: {
      content: `cc-relay: more than ${INBOUND_PER_MIN} peer messages arrived in a minute; the rest are being dropped.`,
      meta: { notice: "rate_limited" },
    },
  };
}
