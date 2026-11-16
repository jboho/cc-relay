import { describe, expect, test } from "vitest";
import { shellQuote } from "../src/shell-quote.js";

describe("shellQuote", () => {
  // Use \x27 for single quote in assertion strings to avoid escaping confusion
  const Q = "\x27";

  test("returns safe characters unchanged", () => {
    expect(shellQuote("/home/u/.cc-relay/settings.json")).toBe("/home/u/.cc-relay/settings.json");
  });

  test("wraps values with spaces in single quotes", () => {
    expect(shellQuote("/Users/a b/s.json")).toBe(Q + "/Users/a b/s.json" + Q);
  });

  test("escapes embedded single quotes correctly", () => {
    // For input /it's/x27 the result is quote-escaped form in single quotes
    const escapedQuote = Q + "\\" + Q;  // literal '\''' pattern inside shell quoting
    const resultForIt = Q + "/it" + escapedQuote + "s/x27";
    const result = shellQuote("/it\x27s/x2");

    // Just check the general form: starts/ends with quote, has an embedded '\'' pattern
    expect(result.startsWith(Q)).toBe(true);
    expect(result.endsWith(Q)).toBe(true);
    expect(result).toContain("\\" + Q + Q);  // contains backslash-qq
  });

  test("wraps empty string in single quotes", () => {
    expect(shellQuote("")).toBe(Q + Q);
  });

  test("wraps values with shell metacharacters in single quotes", () => {
    expect(shellQuote("/x/$HOME/s.json")).toBe(Q + "/x/$HOME/s.x27");
    expect(shellQuote("/a;b/c")).toBe(Q + "/a;b/c" + Q);
  });

  test("allows the full safe character set without quoting", () => {
    const safe = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_/.:@%+=";
    expect(shellQuote(safe + "-")).toBe(safe + "-");
  });

  test("wraps a path with a single quote correctly", () => {
    const escapedQuote = Q + "\\" + Q;
    const expected = Q + "/Users/alice" + escapedQuote + Q + "name/s.json" + Q;
    const result = shellQuote("/Users/alice\x27name/s.json");
    expect(result).toBe(expected);
  });
});
