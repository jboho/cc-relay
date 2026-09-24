#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main } from "./cli/main.js";

const argv = process.argv.slice(2);
const longRunning = argv[0] === "hub" || argv[0] === "channel";

function until(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
    // Claude Code closes the channel's stdin when the session ends; without
    // this the channel would outlive it, still connected to the hub.
    if (argv[0] === "channel") {
      process.stdin.once("end", () => resolve());
      process.stdin.once("close", () => resolve());
    }
  });
}

const code = await main(argv, {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  nodePath: process.execPath,
  cliPath: realpathSync(fileURLToPath(import.meta.url)),
  until,
});
// A finished hub or channel may still hold stdin or timers open; the short
// commands exit naturally so piped stdout (cc-relay card | pbcopy) is flushed.
if (longRunning) process.exit(code);
process.exitCode = code;
