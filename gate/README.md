# M0 gate: does `permissions.ask` force a prompt for an MCP tool?

Everything after M0 assumes that the harness asks before `mcp__cc-relay__send` runs. This probe checks that assumption, using the exact server and tool names production will use. `server.mjs` is a no-op: it sends nothing anywhere and only appends each `send` call it receives to `gate/calls.log`.

Run every variant from the repo (or worktree) root, because `mcp.json` points at `gate/server.mjs` with a relative path.

## Before each variant

```bash
rm -f gate/calls.log
```

## Variant A: `ask` only (this is the production setting)

```bash
claude --mcp-config gate/mcp.json --settings gate/settings-ask.json --permission-mode manual --dangerously-load-development-channels server:cc-relay
```

In the session, type:

> Use the cc-relay send tool with to "gate-test" and text "hello from variant A".

1. **A permission prompt for `cc-relay` / `send` should appear. Choose No.** Then run `cat gate/calls.log`. It should not exist or should be empty.
2. Ask again and **choose Yes, once only** (not "don't ask again"). `gate/calls.log` should now have exactly one line.

## Variant B: `ask` and `allow` both match (does `ask` win?)

```bash
rm -f gate/calls.log
claude --mcp-config gate/mcp.json --settings gate/settings-ask-allow.json --permission-mode manual --dangerously-load-development-channels server:cc-relay
```

Use the same prompt, then check that the permission prompt **still appears**. Choose No, then check that `gate/calls.log` is empty.

## Variant C (informational): your default mode

Your global default mode is `auto`. This run shows what happens if the alias's `--permission-mode manual` is ever dropped:

```bash
rm -f gate/calls.log
claude --mcp-config gate/mcp.json --settings gate/settings-ask.json --dangerously-load-development-channels server:cc-relay
```

Use the same prompt, and note whether a prompt appeared and whether `gate/calls.log` got a line.

## Recording the result

Copy this table into `gate/RESULT.md`, fill it in, and commit it:

| Variant | Prompt appeared? | calls.log after "No" | Notes |
|---|---|---|---|
| A (ask) | | | |
| B (ask + allow) | | | |
| C (auto, informational) | | | |

Also record `claude --version`.

- **PASS:** A and B both prompt, and "No" leaves `calls.log` empty. The `ask` rule is the send confirmation, and M3 needs no in-tool fallback.
- **FAIL:** A or B ran `send` without a prompt. M3 then gains the in-tool confirmation (MCP elicitation first, otherwise `osascript`), with the hard requirements in the design doc's "How it's launched" section.
- **Variant C** doesn't affect PASS/FAIL. If `auto` skipped the prompt, `doctor` (M3) must check that the running session was launched with `--permission-mode manual`, or the alias becomes the only safeguard. Record it either way.

If you chose "Yes, and don't ask again" by mistake, it writes an allow rule into a local settings file. Remove it before re-running.
