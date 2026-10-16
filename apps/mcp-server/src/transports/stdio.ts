import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServerForToken } from '../server.js';
import type { McpServerConfig } from '../config.js';

/**
 * Run the server over stdio — the transport Claude Desktop and Claude Code spawn.
 *
 * One operator, one token: the env `TMANAGE_TOKEN` (required by `loadConfig` for this
 * transport) authenticates every call. Nothing is written to stdout except the protocol
 * itself; diagnostics go to stderr so they never corrupt the stream.
 */
export async function runStdio(config: McpServerConfig): Promise<void> {
  // `loadConfig` guarantees a token for the stdio transport.
  const server = buildServerForToken(config, config.token as string);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`tmanage-mcp: stdio transport ready (API ${config.apiUrl})\n`);
}
