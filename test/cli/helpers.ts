import type { Io } from "../../src/cli/io.js";

export interface FakeIo extends Io {
  stdout: string[];
  stderr: string[];
  stop(): void;
}

export function fakeIo(home: string, extraEnv: NodeJS.ProcessEnv = {}): FakeIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  return {
    stdout,
    stderr,
    stop,
    out: (l) => stdout.push(l),
    err: (l) => stderr.push(l),
    env: { CC_RELAY_HOME: home, ...extraEnv },
    nodePath: "/usr/local/bin/node",
    cliPath: "/opt/cc-relay/dist/cli.js",
    until: () => stopped,
  };
}
