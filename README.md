<!-- markdownlint-disable MD033 MD041 -->

<h1 align="center">cc-relay</h1>

<p align="center">
  <strong>End-to-end-encrypted messaging between interactive Claude Code sessions on different machines and accounts</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-yellow.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/status-experimental-orange.svg" alt="Status: experimental" />
  <img src="https://img.shields.io/badge/Node-22+-339933?logo=nodedotjs&logoColor=white" alt="Node 22+" />
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" alt="TypeScript 5" />
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey?logo=apple&logoColor=white" alt="Platform: macOS" />
</p>

<p align="center">
  <sub>Claude Code Channels · one small hub · Tailscale or local network · you approve every send</sub>
</p>

---

> [!WARNING]
> **Experimental.** The [manual runbook](.ai/docs/notes/2026-09-23-m4-manual-runbook.md) passed 10 of 10 checks over loopback on one Mac, on Claude Code 2.1.282. On 2026-11-09, one message went each way between two machines on the same Wi-Fi in LAN mode. The full runbook has not been run on two machines, and Tailscale mode has not been tested. It also depends on Claude Code's research-preview Channels feature, loaded with `--dangerously-load-development-channels`, which can change or go away in any release. See [Known gaps](#known-gaps) before you rely on it.

## Overview

**cc-relay** lets interactive Claude Code sessions on different machines, signed in to different accounts, message each other. Each machine runs a Channels MCP server, and one Mac runs a small hub that forwards sealed messages. The hub is reachable over Tailscale or the local network and only ever sees ciphertext.

| Topic             | Links                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **License**       | [MIT](LICENSE)                                                                                                                |
| **Design**        | [cc-relay design and risk list](.ai/docs/plans/2026-09-23-cc-relay-design.md)                                                 |
| **Build plans**   | [M0–M2](.ai/docs/plans/2026-09-23-cc-relay-m0-m2.md) · [M3–M4](.ai/docs/plans/2026-09-23-cc-relay-m3-m4.md) (with "As built") |
| **Runbook**       | [M4 manual runbook and results](.ai/docs/notes/2026-09-23-m4-manual-runbook.md)                                               |
| **Security**      | [Report a vulnerability privately](https://github.com/jboho/cc-relay/security/advisories/new)                                 |

## Status

| Milestone | Scope                                                                                  | State      |
| --------- | -------------------------------------------------------------------------------------- | ---------- |
| M0        | [Gate](gate/RESULT.md): `permissions.ask` forces a prompt for the `send` tool          | Pass       |
| M1–M3     | Protocol, hub, channel server, CLI                                                     | Built      |
| M4        | `doctor`, local end-to-end test, manual runbook on one Mac (10/10)                     | Done       |
| M5        | LAN mode, live with a peer on a second machine (one message each way, 2026-11-09)      | Pass       |
| M6        | Tailscale mode, live                                                                   | Not tested |

## How it fits together

One machine is the **host**: it runs `cc-relay hub`, a WebSocket server that forwards sealed messages between the people on its allowlist. Every other machine is a **guest**. Each machine, host included, has its own identity (a signing key and an encryption key) in `~/.config/cc-relay/` (or `CC_RELAY_HOME`, if set) — that path can't contain spaces.

You start a relay session with the `claude-relay` alias. It launches Claude Code with the cc-relay channel loaded. The channel connects to the hub. Messages from peers appear in the session, and Claude can answer with the `send` tool. **You approve every send**: the alias loads a settings file that makes Claude Code ask before each `send` call. Your other Claude Code sessions don't load cc-relay at all.

The hub only ever sees ciphertext. It knows who is talking to whom, when, and roughly how much, but not what is said.

## Requirements

- **macOS** — the only platform tested. `doctor` checks the clock against `time.apple.com`.
- **[Node.js](https://nodejs.org/)** 22+ (`engines` in [`package.json`](package.json))
- **[pnpm](https://pnpm.io/)**
- **[Claude Code](https://docs.claude.com/en/docs/claude-code)** with Channels support (research preview)
- **[Tailscale](https://tailscale.com/)** — only for `--mode tailscale`

## Install (each machine)

```bash
git clone https://github.com/jboho/cc-relay.git ~/Code/cc-relay
cd ~/Code/cc-relay
pnpm install && pnpm build
```

Put a `cc-relay` command on your PATH. Point it at wherever you cloned the repo — the path below assumes `~/Code/cc-relay`. This wrapper records node's full path when you create it, so it keeps working after an `nvm use` or other version switch, and from shells that don't load your `~/.zshrc` (Claude Code's `!` commands, for example):

```bash
mkdir -p ~/.local/bin
cat > ~/.local/bin/cc-relay <<EOF
#!/bin/sh
exec "$(command -v node)" "$HOME/Code/cc-relay/dist/cli.js" "\$@"
EOF
chmod +x ~/.local/bin/cc-relay
```

If `~/.local/bin` isn't on your PATH, add it in `~/.zprofile`, which zsh login shells read (macOS terminals are login shells). After you rebuild or move the repo, re-run `cc-relay doctor`; it checks the paths Claude Code will use.

## Set up

**Host** (the machine that runs the hub):

```bash
cc-relay init --alias alice --host --mode lan
```

`--mode lan` listens on this Mac's Wi-Fi or Ethernet address (a private 10.x, 172.16–31.x or 192.168.x address). Use `--mode tailscale --tailscale-login <your login>` to listen on the Tailscale address instead. `--iface en0` picks the interface when there's more than one, and `--port` fixes the port (otherwise one is chosen at random).

**Guest** (everyone else):

```bash
cc-relay init --alias bob
```

`init` prints your fingerprint and a line like this, with your machine's absolute paths filled in. Add it to `~/.zshrc`:

```bash
alias claude-relay='claude --mcp-config ~/.config/cc-relay/mcp.json --settings ~/.config/cc-relay/settings.json --permission-mode manual --dangerously-load-development-channels server:cc-relay'
```

Claude Code requires `--dangerously-load-development-channels` while Channels is in research preview. The flag, or the Channels protocol, can change in a future Claude Code release, and that is the part of cc-relay most likely to break.

## Pair

Each side sends the other its card, and checks the other's fingerprint over a channel you already trust, such as a phone call or in person. The card can travel by email or chat. The fingerprint check is what stops someone from swapping the card on the way.

```bash
cc-relay card            # prints your card; your fingerprint goes to the terminal, not into the card output
cc-relay add '<their card>'
# card for alice, fingerprint bf80-9006-2e24-8a83-48b3
# Check this fingerprint with them ..., then re-run with --confirm <fingerprint>.
cc-relay add '<their card>' --confirm bf80-9006-2e24-8a83-48b3
```

Both sides must add each other: the host adds the guest (this puts the guest on the hub's allowlist), and the guest adds the host (this links the guest to the hub). Dashes, spaces and letter case in `--confirm` don't matter.

Run without `--confirm`, `add` only prints the fingerprint to check and exits 2, without adding anything; a script that calls `add` should treat 2 as "needs a human to confirm a fingerprint", distinct from 0 (added) or 1 (a real failure, such as a mismatched fingerprint).

- A host card carries the one address its hub listens on. If a card ever offers both a LAN and a Tailscale address, `add` asks you to pick with `--via lan` or `--via tailscale`.
- In Tailscale mode the host also records each guest's Tailscale login: `cc-relay add '<card>' --confirm <fp> --tailscale-login bob@example.com`. The hub only accepts a guest whose connection comes from that login.
- `cc-relay list` shows your identity, your hub or link, and your peers. `cc-relay remove <alias>` removes a peer (and the link, if it was your host).

After adding or removing a peer, restart the hub and any relay sessions: they read the peer list at start.

## Run

On the host, in a terminal tab you keep open:

```bash
cc-relay hub
# cc-relay hub listening on 192.168.1.20:20205 (lan mode, 1 peer)
```

On each machine (the host too, if the host person also chats):

```bash
claude-relay
```

Then ask Claude to message a peer by alias, for example "tell bob the build is green". Claude Code asks you before every send. Incoming messages show up in the session as `<channel source="cc-relay" from="alice" …>` blocks. The `peers` tool lists who you can message and whether this session can send.

## Check the setup

```bash
cc-relay doctor
```

It checks, in order: the home folder is private (0700), the identity and peers load, `settings.json` asks before every send and turns bypass mode off, `mcp.json` points at this install, this session (if run from one) was launched with the relay settings, the clock is within a few seconds of `time.apple.com`, Tailscale is working (if used), the hub answers and accepts this machine, and (for a Tailscale guest) that the host's grant opens only the hub port. Each line says PASS, WARN, FAIL or SKIP, with what to do. It exits 1 if anything fails.

To check a running relay session, type `! cc-relay doctor` inside it. The `session` line then confirms that the session was started with the relay settings. From a plain terminal that line is skipped. From an ordinary Claude Code session it fails, which is correct: that session can't send.

The hub check sends a hello and stops at the hub's challenge. It never completes a login, so it doesn't knock your running relay session off the hub.

## What is protected, and what isn't

- **Messages are end-to-end encrypted** between the two identities. The hub, and anyone on the network, sees only who talks to whom, when, and roughly how much.
- **The hub accepts only allowlisted identities** and stays silent to everyone else: a wrong path gets a plain 404, and a failed login gets the connection dropped with no reply.
- **"sent" means the hub took the message, not that it arrived.** The guest doesn't check the hub's identity, so someone who can intercept the network path can drop messages or pretend to accept them. They still can't read or forge them.
- **The fingerprint covers the keys, not the hub address.** Someone who swaps the address in a host card can point the guest at a different server. That server can't read messages or pass as the host's peers. The guest just won't reach anyone, and `doctor` will show the hub check failing.
- **Only one relay session per identity at a time.** A second `claude-relay` session takes over the hub connection. The first one stops receiving, and its `send` and `peers` tools say it was replaced. Restart it to take the connection back.
- **The hub stops on an internal error on purpose**, rather than keep running in a bad state. Restart it with `cc-relay hub`.
- **A peer's message can't run anything by itself.** It's untrusted text that reaches Claude and can try to steer it — prompt injection. Anything your other settings already allow without asking, such as allow rules in `~/.claude/settings.json` (which still load next to `--settings`) or auto/acceptEdits mode, could run because of it. Keep relay sessions in manual mode, and read each send prompt before approving: a send can carry data out.

## Known gaps

From the [M3–M4 "As built" notes](.ai/docs/plans/2026-09-23-cc-relay-m3-m4.md#known-limits-and-residual-risks):

- **Replay after a restart.** Each channel keeps its seen-message cache in memory. Someone who controls the hub, or a machine on the LAN path, can force a channel to reconnect and then replay one of a peer's real messages from the last 5–10 minutes, which shows up as new. The planned fix keeps the cache in a 0600 file under the relay home.
- **Lookalike letters.** The escaping that stops a peer from forging its own `<channel>` tag doesn't catch lookalike letters from other scripts (for example, Cyrillic "с").
- **Port race.** When no `--port` is given, the hub probes a free port, releases it, then binds it, so another process can take it in between. This showed up once in the tests as `EADDRINUSE`; re-run `cc-relay hub`, or pass `--port`.
- **Hand-edited `peers.json`.** A file edited by hand, or written before the reserved-alias rule, can still hold a reserved alias. If the file is missing, `add` doesn't recreate it; the error says how to create it.
- **Two machines barely tested.** Beyond one message each way over LAN between two machines (M5), everything above was checked on one Mac over loopback. Tailscale between two machines is the next milestone (M6).

## Development

```bash
pnpm test        # vitest (includes a local end-to-end run: real hub process + two channel processes)
pnpm typecheck
pnpm build
```

## Tech stack

| Layer    | Details                                                                       |
| -------- | ----------------------------------------------------------------------------- |
| Runtime  | Node 22+, TypeScript, ES modules                                              |
| Channel  | [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) (Claude Code Channels) |
| Crypto   | [TweetNaCl](https://tweetnacl.js.org/) (`sign` for identity, `box` for message encryption)               |
| Hub      | [`ws`](https://github.com/websockets/ws) WebSocket server                     |
| Testing  | [Vitest](https://vitest.dev/)                                                 |

## License

Published under the [MIT License](LICENSE).
