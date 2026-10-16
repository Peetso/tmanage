import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHttpApiClient } from './api-client.js';
import type { TManageApiClient } from './api-client.js';
import { registerTools } from './tools.js';
import type { McpServerConfig } from './config.js';

export const SERVER_NAME = 'tmanage';
export const SERVER_VERSION = '0.1.0';

/** Build an MCP server with the TManage tools registered against the given API client. */
export function buildServer(client: TManageApiClient): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, client);
  return server;
}

/**
 * Build a server for one bearer token.
 *
 * stdio passes the env token; the HTTP transport passes the per-request token so one remote
 * server can serve many members. The org slug is pinned here when the config names one.
 */
export function buildServerForToken(config: McpServerConfig, token: string): McpServer {
  return buildServer(
    createHttpApiClient({
      baseUrl: config.apiUrl,
      token,
      ...(config.orgSlug !== undefined ? { orgSlug: config.orgSlug } : {}),
    }),
  );
}
