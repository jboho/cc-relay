import { describe, expect, test } from "vitest";
import { shellQuote } from "../src/shell-quote.js";

describe("shellQuote", () => {
  test("safe characters produce the input unchanged", () => {
    expect(shellQuote("/home/u/.cc-relay/settings.json")).toBe("/home/u/.cc-relay/settings.json");
    expect(shellQuote("/relay/settings.json")).toBe("/relay/settings.json");
  });

  test("empty string is single-quoted", () => {
    expect(shellQuote("")).toBe("\x27\x27");
  });

  test("a path with a space is wrapped in single quotes", () => {
    expect(shellQuote("/Users/a b/s.json")).toBe("\x27/Users/a b/s.json\x27");
  });

  test("a path with shell variables is quoted", () => {
    expect(shellQuote("/x/$HOME/s.json")).toBe("\x27/x/$HOME/s.json\x27");
  });

  test("a path holding a single quote escapes them via the closing-reopening idiom", () => {
    // '/it's/s.json' should become '/it'\''s/s.json' where each internal ' is '\''
    expect(shellQuote("/it's/s.json")).toBe("\x27/it\x27\\\x27\x27s/s.json\x27");
  });
});
