import { shellQuote } from "./src/shell-quote.ts";

// Test 1: safe path unchanged
const r1 = shellQuote("/home/u/.cc-relay/settings.json");
console.log("Test 1:", JSON.stringify(r1), "- expected: /home/u/.cc-relay/settings.json");
console.assert(r1 === "/home/u/.cc-relay/settings.json", "Test 1 failed");

// Test 2: space needs quoting
const r2 = shellQuote("/Users/a b/s.json");
const t2e = "'" + "/Users/a b/s.json" + "'";
console.log("Test 2:", JSON.stringify(r2), "- expected:", JSON.stringify(t2e));
console.assert(r2 === t2e, "Test 2 failed");

// Test 3: single quote escaping  
const input3 = "/it's/s.json";
const r3 = shellQuote(input3);
console.log("Test 3 input:", JSON.stringify(input3), "result:", JSON.stringify(r3));

// Check the expected output: '/it'\''s/s.json'
const t3q = "'" + "/it" + "'" + "\\" + "'" + "'" + "s/s.json" + "'";
console.log("Test 3 expected:", JSON.stringify(t3q));
console.assert(r3 === t3q, "Test 3 failed: got " + JSON.stringify(r3) + " expected " + JSON.stringify(t3q));

// Test 4: empty string is quoted
const r4 = shellQuote("");
const t4e = "'" + "'";
console.log("Test 4:", JSON.stringify(r4), "- expected:", JSON.stringify(t4e));
console.assert(r4 === t4e, "Test 4 failed");

// Test 5: dollar sign needs quoting
const r5 = shellQuote("/x/$HOME/s.json");
const t5e = "'" + "/x/$HOME/s.json" + "'";
console.log("Test 5:", JSON.stringify(r5), "- expected:", JSON.stringify(t5e));
console.assert(r5 === t5e, "Test 5 failed");

console.log("\nReviewer check:");
import a from "node:assert/strict";
a.equal(shellQuote("/home/u/.cc-relay/settings.json"), "/home/u/.cc-relay/settings.json");
a.equal(shellQuote("/Users/a b/s.json"), "'/Users/a b/s.json'");
// The tricky one: /it's/s.json should become '/it'\''s/s.json 
const r3actual = shellQuote("/it's/s.json");
console.log("Test 3 actual:", JSON.stringify(r3actual));
console.log("Test 3 repr:", r3actual);
a.equal(shellQuote(""), "''");
