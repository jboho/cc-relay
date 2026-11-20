import { shellQuote } from "./src/shell-quote.ts";
import a from "node:assert/strict";

// Test 1: safe path unchanged
const r1 = shellQuote("/home/u/.cc-relay/settings.json");
console.log("Test 1:", JSON.stringify(r1));
a.equal(r1, "/home/u/.cc-relay/settings.json");

// Test 2: space needs quoting  
const r2 = shellQuote("/Users/a b/s.json");
const t2e = "\x27/Users/a b/s.json\x27";
console.log("Test 2:", JSON.stringify(r2), "expected:", JSON.stringify(t2e));
a.equal(r2, t2e);

// Test 3: single quote escaping - tricky! The reviewer expects this specific form
const input3 = "/it's/s.json";
const r3 = shellQuote(input3);
console.log("Test 3 result:", JSON.stringify(r3));

// Expected from reviewer: '\x27/it\x27\\\x27\x27s/s.json\x27' 
const t3e = String.raw`'/it'\''s/s.json`;
console.log("Test 3 expected:", JSON.stringify(t3e));
a.equal(r3, t3e);

// Test 4: empty string is quoted
const r4 = shellQuote("");
console.log("Test 4:", JSON.stringify(r4));
a.equal(r4, "\x27\x27");

// Test 5: dollar sign needs quoting
const r5 = shellQuote("/x/$HOME/s.json");
console.log("Test 5:", JSON.stringify(r5));
a.equal(r5, "\x27/x/$HOME/s.json\x27");
