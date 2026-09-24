#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main } from "./cli/main.js";

const argv = process.argv.slice(2);
const longRunning = argv[0] === "hub" || argv[0] === "channel";

function until(): Promise<void> {
  return new Promise((resolve) => {
    const isChannel = argv[0] === "channel";
    // One handler for all four events: whichever fires first removes the
    // other three, so a signal after stdin closes (or vice versa) is a no-op
    // rather than a second resolve.
    function done(): void {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      if (isChannel) {
        process.stdin.off("end", done);
        process.stdin.off("close", done);
      }
      resolve();
    }
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
    // Claude Code closes the channel's stdin when the session ends; without
    // this the channel would outlive it, still connected to the hub.
    if (isChannel) {
      // stdin may already be closed by the time until() is called (a very
      // short-lived Claude Code session): the 'end'/'close' events won't fire
      // again, so this must resolve immediately instead of waiting forever.
      if (process.stdin.readableEnded || process.stdin.destroyed) {
        done();
        return;
      }
      process.stdin.once("end", done);
      process.stdin.once("close", done);
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
