# M0 gate result: PASS

Run 2026-09-23 on `claude --version` = 2.1.280 (Claude Max, personal). Each variant was launched interactively in a real pty (scripted with `expect`) using the commands in `README.md`. The model was asked to call `send` once, and the permission prompt was answered with Esc (No).

| Variant | Launch | Recorded mode | Prompt appeared? | calls.log after "No" | Notes |
|---|---|---|---|---|---|
| A (ask) | `--settings settings-ask.json --permission-mode manual` | default (manual) | Yes | empty | Prompt text: "Permission rule mcp__cc-relay__send requires confirmation for this tool." |
| B (ask + allow) | `--settings settings-ask-allow.json --permission-mode manual` | default (manual) | Yes | empty | `ask` beats a matching `allow` |
| C (auto, informational) | `--settings settings-ask.json`, no mode flag | auto | Yes | empty | `ask` holds in auto mode too; the classifier does not override it |
| C0 (auto, no ask rule) | no `--settings`, no mode flag | auto | **No** | 1 line | The auto-mode classifier approved `send` silently |

## What this means

- **PASS.** The `ask` rule is the send confirmation. M3 needs no in-tool fallback (elicitation or osascript).
- **The load-bearing piece is the `ask` rule, not `--permission-mode manual`.** Only C0, which has no `ask` rule, ran without a prompt. So M3's `doctor` must verify that `permissions.ask` contains `mcp__cc-relay__send` in the settings the session actually loaded. Checking the mode alone isn't enough.
- The first manual run of A was invalid. Its transcript records `permissionMode: auto` and `send` ran without a prompt, which matches C0. So that session didn't load `--settings gate/settings-ask.json` or `--permission-mode manual`. This is the exact failure `doctor` has to catch.
- Auto mode doesn't take effect with `--model haiku`: sessions record `default`. Variant C was only valid on the default model.
- The prompt offers "Yes, and don't ask again", which writes an allow rule. B shows that `ask` still wins over such an allow rule. Keep that covered in `doctor`.

## Open item for M1

With `--mcp-config gate/mcp.json`, the channels banner shows `server:cc-relay · no MCP server configured with that name`. The tool still loaded. Before relying on channel delivery in M1, verify that `notifications/claude/channel` actually injects when the server comes from `--mcp-config`. If it doesn't, register it through `.mcp.json` or `claude mcp add`.
