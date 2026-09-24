// Claude Code wraps channel content in <channel ...> tags. A peer that writes
// its own closing tag could make the rest of its text read as if it came from
// outside the channel, so any tag-shaped "channel" gets its "<" escaped.
// The model reads this text through its own tokenizer, not a strict parser,
// so a disguised tag still reads as "<channel" to it even when a literal
// string match would miss it. Between any characters this allows: invisible
// Unicode format characters (\p{Cf} — zero-width space, word joiner, soft
// hyphen, etc.), combining marks (\p{M} — combining accents, variation
// selectors), and four Hangul filler characters (U+115F, U+1160, U+3164,
// U+FFA0) that render invisible but fall in category Lo, so neither \p{Cf}
// nor \p{M} covers them. As the opening "<" this allows: fullwidth/small-form
// ＜ U+FF1C, ﹤ U+FE64; the CJK/mathematical angle brackets 〈 U+3008,
// 〈 U+2329, ⟨ U+27E8; the angle quotation marks ‹ U+2039, « U+00AB, ❮ U+276E;
// and the modifier letter left arrowhead ˂ U+02C2. This does not catch
// lookalike letters borrowed from other scripts (e.g. Cyrillic "с" for "c")
// — a known limit.
const INVISIBLE = "\\p{Cf}\\p{M}\\u115F\\u1160\\u3164\\uFFA0";
const GAP = `[\\s${INVISIBLE}]*`;
const WORD = [..."channe"].map((c) => `${c}[${INVISIBLE}]*`).join("") + "l";
const OPEN = "[<\\uFF1C\\uFE64\\u2039\\u3008\\u2329\\u27E8\\u00AB\\u276E\\u02C2]";
const TAG_RE = new RegExp(`${OPEN}(${GAP}\\/?${GAP}${WORD})`, "giu");

export function escapeChannelTags(text: string): string {
  return text.replace(TAG_RE, "&lt;$1");
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
      content: `cc-relay: more than the per-minute limit of peer messages arrived; the rest are being dropped.`,
      meta: { notice: "rate_limited" },
    },
  };
}
