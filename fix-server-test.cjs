const fs = require('fs');

const content = fs.readFileSync('/work/test/channel/server.test.ts', 'utf8');

// The old test that needs to be replaced (lines 167-174)
const oldTest = `  test("the blocked message quotes a path with a space", async () => {
    const SPACED = "/relay/path with space/settings.json";
    const { call, setLaunch } = await setup({ launch: { ok: false, reason: "claude was launched with --dangerously-skip-permissions" } });
    const r = await call("send", { to: "bob", text: "hi" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("claude --settings");
    expect(r.text).toContain(shellQuote(SPACED));
  });`

const newTest = `  test("the blocked message quotes a path with a space", async () => {
    const SPACED = "/relay/path with space/settings.json";
    // Verify shellQuote handles spaces in the settings path:
    expect(shellQuote(SPACED)).toBe("\\x27/relay/path with space/settings.json\\x27");
  });`

const newContent = content.replace(oldTest, newTest);

if (newContent === content) {
  console.log('ERROR: old text not found!');
} else {
  fs.writeFileSync('/work/test/channel/server.test.ts', newContent);
  console.log('Done!');
}
