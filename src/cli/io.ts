export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  // Written into mcp.json so Claude Code launches this exact build.
  nodePath: string;
  cliPath: string;
  // Resolves when a long-running command (hub, channel) should shut down.
  until: () => Promise<void>;
}

export class UsageError extends Error {
  override name = "UsageError";
}
