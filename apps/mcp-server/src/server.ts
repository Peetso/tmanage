import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHttpApiClient } from './api-client.js';
import type { TManageApiClient } from './api-client.js';
import { serverIdentity } from './server-identity.js';
import { registerTools } from './tools.js';
import type { McpServerConfig } from './config.js';

export const SERVER_NAME = 'tmanage';
export const SERVER_VERSION = '0.1.0';

/**
 * Build an MCP server with the TManage tools registered against the given API client.
 * `siteUrl` (the TManage web origin) adds the brand icon and website to `serverInfo`.
 */
export function buildServer(client: TManageApiClient, siteUrl?: string): McpServer {
  const server = new McpServer(serverIdentity(SERVER_NAME, SERVER_VERSION, siteUrl));
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
    // The API and the web app share one origin (single-app deploy), so the icons live there.
    config.apiUrl,
  );
}
