import { parseArgs } from "node:util";
import { ConfigError } from "../channel/config.js";
import { BindError } from "../hub/bind.js";
import { PortError } from "../hub/port.js";
import { TailscaleError } from "../hub/tailscale.js";
import { CardError } from "../protocol/card.js";
import { EncodingError } from "../protocol/encoding.js";
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
                                           add a peer (a host's card also links you to its hub)
  remove <alias>                           remove a peer
  list                                     show you, your hub and your peers
  hub                                      run the hub (host only; Ctrl-C stops it)
  channel                                  run the channel server (Claude Code starts this)
  doctor                                   check the setup and say what's wrong`;

// Errors that describe a problem the user can fix: print the message only.
const EXPECTED = [ConfigError, BindError, PortError, TailscaleError, CardError, EncodingError, IdentityError];

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

async function dispatch(command: string, rest: string[], io: Io): Promise<number> {
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
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    io.out(USAGE);
    return command === undefined ? EX_USAGE : 0;
  }
  try {
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
      io.err(`cc-relay: ${(err as Error).message}`);
      return 1;
    }
    throw err;
  }
}
