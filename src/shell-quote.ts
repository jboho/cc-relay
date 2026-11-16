const SAFE_RE = /^[A-Za-z0-9_\/.,:@%+=-]+$/;

export function shellQuote(value: string): string {
  if (SAFE_RE.test(value)) {
    return value;
  }
  // Wrap in single quotes, escaping any embedded quotes.
  let out = "'";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "'") {
      out += "'\\''";
    } else {
      out += ch;
    }
  }
  out += "'";
  return out;
}
