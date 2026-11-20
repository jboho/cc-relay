// Pure JS implementation of shellQuote (same logic as the TS one)
function shellQuote(value) {
  if (/^[A-Za-z0-9_\/.,:@%=+\-]+$/.test(value)) {
    return value;
  }
  const SQ = "'";
  const escaped = value.replace(/'/g, SQ + '\\' + SQ + SQ);
  return SQ + escaped + SQ;
}

// Tests
const SQ = "'";

// Test 1: safe path - unchanged
console.log("T1:", shellQuote("/home/u/.cc-relay/settings.json"));
console.assert(shellQuote("/home/u/.cc-relay/settings.json") === "/home/u/.cc-relay/settings.json");

// Test 2: space needs quoting
const t2 = shellQuote('/Users/a b/s.json');
console.log("T2:", JSON.stringify(t2), '==', JSON.stringify(SQ + '/Users/a b/s.json' + SQ));
console.assert(t2 === SQ + '/Users/a b/s.json' + SQ);

// Test 3: single quote escaping
const input = "/it's/s.json";
const t3 = shellQuote(input);
console.log("T3 result:", JSON.stringify(t3));

// Expected from reviewer in hex escapes: 
// "\x27/it\x27\\\x27\x27s/s.json\x27" which is '/ it \ ' ' s/s.json ' (10 chars in quotes)
const t3expected = SQ + '/it' + SQ + '\\' + SQ + SQ + 's/s.json' + SQ;
console.log("T3 expected:", JSON.stringify(t3expected));
console.assert(t3 === t3expected, "Mismatch: " + JSON.stringify(t3) + " vs " + JSON.stringify(t3expected));

// For T3, let me break down what should happen:
// input = /it's/s.json  (12 chars including the quote char in position 5)
// We want to produce: '/ it \ ' ' s/ s.json '
// But that's: q + '/it' + q + backslash + q + q + 's/s.json' + q
// No wait... let me trace manually:
// Input starts with / (safe), then i,t (safe), then ' (unsafe - needs escaping)

// Step 1: value contains a ' so go to quoted branch
// Step 2: replace each ' with (SQ + backslash + SQ + SQ)
//   In the input "/it's/s.json", position of ' is at index 4 (0-based)
//   The replacement string in JS is: "'\\'' "
//   This string character by character: q, backslash, q, q = 4 chars
// So replacing that one ' with those 4 chars gives:
// "/it" + q\qq + "s/s.json" = /itq\qqs/s.json (the q is single-quote)

// Step 3: wrap in quotes
// q + (/itq\qqs/s.json) + q = q/itq\qqs/s.jsonq

console.log("Breaking down T3:");
console.log("Input:", input);
console.log("Quote char (SQ):", JSON.stringify(SQ));
const parts = input.split('\'');
console.log("Parts when split on quote:", parts);
// Should be ["/it", "s/s.json"]
const reconstructed = parts.join(SQ + '\\' + SQ + SQ);
console.log("Joined with replacement:", reconstructed);
const result = SQ + reconstructed + SQ;
console.log("Final:", JSON.stringify(result));
console.log("Final char codes:", [...result].map(c => c.charCodeAt(0)));

// The reviewer expects '\x27/it\x27\\\x27\x27s/s.json\x27'
// Let's see what that decodes to:
const revBytes = [0x27, 0x2f, 0x69, 0x74, 0x27, 0x5c, 0x27, 0x27, 0x73, 0x2f, 0x73, 0x2e, 0x6a, 0x73, 0x6f, 0x6e, 0x27];
const revStr = String.fromCharCode(...revBytes);
console.log("Reviewer expected:", JSON.stringify(revStr));
console.log("Matches:", t3 === revStr);

// Test 4: empty string
const t4 = shellQuote("");
const t4e = SQ + SQ;
console.log("T4:", JSON.stringify(t4), "==", JSON.stringify(t4e));
console.assert(t4 === t4e);

// Test 5: $HOME needs quoting
const t5 = shellQuote('/x/$HOME/s.json');
console.log("T5:", JSON.stringify(t5));
console.assert(t5 === SQ + '/x/$HOME/s.json' + SQ);

console.log("\nAll tests passed!");
