// M0 gate probe: a channel server named exactly like production (cc-relay)
// with a no-op `send` tool. It never sends anything anywhere; it only appends
// each call it receives to calls.log, so the log shows whether a call got past
// the permission prompt.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const LOG = new URL("./calls.log", import.meta.url);
const reply = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    reply({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { experimental: { "claude/channel": {} }, tools: {} },
        serverInfo: { name: "cc-relay", version: "0.0.0-gate" },
        instructions: "M0 gate probe. The send tool is a no-op that records the call.",
      },
    });
  } else if (msg.method === "tools/list") {
    reply({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "send",
            description: "Send a message to a paired peer.",
            inputSchema: {
              type: "object",
              properties: { to: { type: "string" }, text: { type: "string" } },
              required: ["to", "text"],
              additionalProperties: false,
            },
          },
        ],
      },
    });
  } else if (msg.method === "tools/call" && msg.params?.name === "send") {
    appendFileSync(LOG, `${new Date().toISOString()} ${JSON.stringify(msg.params.arguments)}\n`);
    reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "gate: recorded, not sent" }] } });
  } else if (msg.id !== undefined) {
    reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
});
