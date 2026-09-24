# cc-relay

Cross-machine, cross-account messaging between interactive Claude Code sessions: a Channels MCP server on each machine and a small end-to-end-encrypted hub on one Mac, reachable over Tailscale or the local network.

Status: M0–M4 built (protocol, hub, channel server, CLI, `doctor`, local end-to-end test). M5 (LAN, live with a peer) and M6 (Tailscale, live) are next. Design: [.ai/docs/plans/2026-09-23-cc-relay-design.md](.ai/docs/plans/2026-09-23-cc-relay-design.md). Build plans: [M0–M2](.ai/docs/plans/2026-09-23-cc-relay-m0-m2.md), [M3–M4](.ai/docs/plans/2026-09-23-cc-relay-m3-m4.md).

## How it fits together

One machine is the **host**: it runs `cc-relay hub`, a WebSocket server that forwards sealed messages between the people on its allowlist. Every other machine is a **guest**. Each machine, host included, has its own identity (a signing key and an encryption key) in `~/.config/cc-relay/`.

You start a relay session with the `claude-relay` alias. It launches Claude Code with the cc-relay channel loaded. The channel connects to the hub. Messages from peers appear in the session, and Claude can answer with the `send` tool. **You approve every send**: the alias loads a settings file that makes Claude Code ask before each `send` call. Your other Claude Code sessions don't load cc-relay at all.

The hub only ever sees ciphertext. It knows who is talking to whom and when, but not what is said.

## Install (each machine)

Needs Node 22 or later and pnpm.

```bash
git clone <this repo> ~/Code/cc-relay   # or copy it; the path must not contain spaces
cd ~/Code/cc-relay
pnpm install && pnpm build
```

Put a `cc-relay` command on your PATH. This wrapper records node's full path when you create it, so it still works from shells that don't load your `~/.zshrc` (Claude Code's `!` commands, for example):

```bash
mkdir -p ~/.local/bin
cat > ~/.local/bin/cc-relay <<EOF
#!/bin/sh
exec "$(command -v node)" "$HOME/Code/cc-relay/dist/cli.js" "\$@"
EOF
chmod +x ~/.local/bin/cc-relay
```

If `~/.local/bin` isn't on your PATH, add it in `~/.zshrc`. After you rebuild or move the repo, re-run `cc-relay doctor`; it checks the paths Claude Code will use.

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

`init` prints your fingerprint and a line like this. Add it to `~/.zshrc`:

```bash
alias claude-relay='claude --mcp-config ~/.config/cc-relay/mcp.json --settings ~/.config/cc-relay/settings.json --permission-mode manual --dangerously-load-development-channels server:cc-relay'
```

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
- **Peers can't make you run anything.** A message is text shown to Claude, marked as coming from that peer. Claude still asks you before every send, and your normal permission prompts apply to everything else.

## Development

```bash
command pnpm test        # vitest (includes a local end-to-end run: real hub process + two channel processes)
command pnpm typecheck
command pnpm build
```

In Claude Code's shell, use `command pnpm`, not `pnpm` (a shell wrapper there fails).
