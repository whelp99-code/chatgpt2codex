import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../types.js";
import { registerTools } from "./tools.js";

/**
 * Single source of truth for the version this server advertises. It used to
 * be a hardcoded string that drifted from package.json (0.1.1 while the app
 * shipped as 0.2.0), which makes connector troubleshooting actively
 * misleading — the version ChatGPT reports back is the first thing you check
 * to confirm you are talking to the build you think you are.
 */
function resolveServerVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
  } catch {
    // Packaged layouts may not ship package.json next to dist/; fall through.
  }
  return "0.0.0";
}

export const SERVER_VERSION = resolveServerVersion();

/**
 * Construct and configure the MCP server (stdio transport) with all tools
 * registered against ctx. Returns the server instance ready to `connect()`.
 */
export async function createServer(ctx: ToolContext): Promise<McpServer> {
  const server = new McpServer({
    name: "chatgpt2codex",
    version: SERVER_VERSION,
  });

  registerTools(server, ctx);

  return server;
}
