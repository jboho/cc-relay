import { parseArgs } from "node:util";
import { ConfigError } from "../channel/config.js";
import { BindError } from "../hub/bind.js";
import { PortError } from "../hub/port.js";
import { TailscaleError } from "../hub/tailscale.js";
import { CardError } from "../protocol/card.js";
import { IdentityError } from "../protocol/identity.js";
import { doctor } from "./doctor.js";
import { type Io, UsageError } from "./io.js";
import { channel, hub } from "./run.js";
import { add, card, init, list, remove } from "./setup.js";

export const USAGE = `usage: cc-relay <command>

  init --alias <name>                      set up this machine as a guest
  init --alias <name> --host [--mode lan|tailscale|loopback] [--name <host>]
       [--iface <if>] [--port <n>] [--tailscale-login <login>]
                                           set up this machine as the hub host
  card                                     print your card to send to a peer
  add <card> [--confirm <fingerprint>] [--via lan|tailscale] [--tailscale-login <login>]
                                           add a peer (a host's card also links you to its hub);
                                           without --confirm, prints the fingerprint to check and exits 2
  remove <alias>                           remove a peer
  list                                     show you, your hub and your peers
  hub                                      run the hub (host only; Ctrl-C stops it)
  channel                                  run the channel server (Claude Code starts this)
  doctor                                   check the setup and say what's wrong`;

// Errors that describe a problem the user can fix: print the message only.
// EncodingError is deliberately not here: every user-facing decode path
// (decodeCard, the config loaders, parseIdentity) already wraps it as
// CardError/ConfigError/IdentityError, so a raw one reaching here is a bug,
// not a setup problem, and must keep its stack.
const EXPECTED = [ConfigError, BindError, PortError, TailscaleError, CardError, IdentityError];

export const EX_USAGE = 64;

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], flag: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new UsageError(`${flag} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function portArg(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new UsageError("--port must be a number from 1 to 65535");
  return Number(value);
}

function positional(args: string[], name: string): string {
  if (args.length !== 1 || args[0] === undefined) throw new UsageError(`expected exactly one ${name}`);
  return args[0];
}

const COMMANDS = ["init", "add", "remove", "card", "list", "hub", "channel", "doctor"] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

async function dispatch(command: string, rest: string[], io: Io): Promise<number> {
  // Checked first so `cc-relay frobnicate --help` is an unknown-command usage
  // error, not usage-and-exit-0: the --help short-circuit below would
  // otherwise trigger for any command, known or not.
  if (!isCommand(command)) throw new UsageError(`unknown command: ${command}`);
  // Checked before parseArgs/manual argument checks, since none of the
  // subcommands define --help/-h themselves: parseArgs's strict mode would
  // otherwise reject it as an unknown option, and the no-arguments commands
  // would reject it as an unexpected argument.
  if (rest.includes("--help") || rest.includes("-h")) {
    io.out(USAGE);
    return 0;
  }
  switch (command) {
    case "init": {
      const { values, positionals } = parseArgs({
        args: rest,
        strict: true,
        allowPositionals: true,
        options: {
          alias: { type: "string" },
          host: { type: "boolean" },
          mode: { type: "string" },
          name: { type: "string" },
          iface: { type: "string" },
          port: { type: "string" },
          "tailscale-login": { type: "string" },
        },
      });
      if (positionals.length > 0) throw new UsageError("init takes no positional arguments");
      if (values.alias === undefined) throw new UsageError("init needs --alias <name>");
      const mode = oneOf(values.mode, ["lan", "tailscale", "loopback"] as const, "--mode");
      const port = portArg(values.port);
      return init(io, {
        alias: values.alias,
        ...(values.host ? { host: true } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(values.name !== undefined ? { name: values.name } : {}),
        ...(values.iface !== undefined ? { iface: values.iface } : {}),
        ...(port !== undefined ? { port } : {}),
        ...(values["tailscale-login"] !== undefined ? { tailscaleLogin: values["tailscale-login"] } : {}),
      });
    }
    case "add": {
      const { values, positionals } = parseArgs({
        args: rest,
        strict: true,
        allowPositionals: true,
        options: { confirm: { type: "string" }, via: { type: "string" }, "tailscale-login": { type: "string" } },
      });
      const via = oneOf(values.via, ["lan", "tailscale"] as const, "--via");
      return add(io, {
        card: positional(positionals, "card"),
        ...(values.confirm !== undefined ? { confirm: values.confirm } : {}),
        ...(via !== undefined ? { via } : {}),
        ...(values["tailscale-login"] !== undefined ? { tailscaleLogin: values["tailscale-login"] } : {}),
      });
    }
    case "remove":
      return remove(io, positional(parseArgs({ args: rest, strict: true, allowPositionals: true }).positionals, "alias"));
    case "card":
    case "list":
    case "hub":
    case "channel":
    case "doctor": {
      if (rest.length > 0) throw new UsageError(`${command} takes no arguments`);
      if (command === "card") return card(io);
      if (command === "list") return list(io);
      if (command === "hub") return hub(io);
      if (command === "channel") return channel(io);
      return doctor(io);
    }
    default: {
      // Unreachable: isCommand() above already refused anything outside
      // COMMANDS, so every member of Command is handled by a case above.
      // This only guards against a case being dropped when Command changes.
      const _exhaustive: never = command;
      throw new UsageError(`unknown command: ${String(_exhaustive)}`);
    }
  }
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "help" || command === "--help" || command === "-h") {
    io.out(USAGE);
    return 0;
  }
  try {
    // Consistent with every other usage error: usage goes to stderr and this
    // exits 64, rather than printing to stdout the way --help does.
    if (command === undefined) throw new UsageError("no command given");
    return await dispatch(command, rest, io);
  } catch (err) {
    // parseArgs throws TypeErrors with ERR_PARSE_ARGS_* codes for bad flags.
    const parseError = typeof (err as NodeJS.ErrnoException)?.code === "string" && (err as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS");
    if (err instanceof UsageError || parseError) {
      io.err(`cc-relay: ${(err as Error).message}`);
      io.err(USAGE);
      return EX_USAGE;
    }
    if (EXPECTED.some((E) => err instanceof E)) {
      let message = (err as Error).message;
      // Not every thrower's message carries its errno (e.g. pickPort's "cannot
      // bind host:port"); append it here rather than in every thrower. Guarded
      // by the includes() check so a message that already embeds its code
      // (e.g. ensureHome's) doesn't get it appended a second time.
      // Only an errno-shaped code (EACCES, ENOTDIR, EAI_AGAIN, ...) is
      // appended: a plain cause.code also catches Node-internal codes like
      // ERR_ENCODING_INVALID_ENCODED_DATA (e.g. from decodeCard's fatal
      // TextDecoder on a non-UTF-8 card), which would leak an implementation
      // detail into what's meant to be a user-facing message. The negative
      // lookahead excludes Node's ERR_* codes specifically, rather than
      // banning underscores outright, so an errno like EAI_AGAIN (DNS lookup
      // failures) still gets appended.
      const code = ((err as Error).cause as NodeJS.ErrnoException | undefined)?.code;
      if (code && /^E(?!RR_)[A-Z0-9_]+$/.test(code) && !message.includes(code)) message += ` (${code})`;
      io.err(`cc-relay: ${message}`);
      return 1;
    }
    throw err;
  }
}
