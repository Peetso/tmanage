import { SUPPORT_EMAIL } from './public-contact';
import { absoluteSiteUrl, siteOrigin } from './site-origin';

/**
 * The MCP Server Card (SEP-1649) served at `/.well-known/mcp/server-card.json` (AGENTREADY,
 * 2026-11-16): what an assistant needs to find TManage's hosted MCP endpoint before connecting.
 *
 * It describes the server the API mounts at `/mcp` (`apps/api/src/modules/mcp`), which builds
 * `buildCatalogServer` from `@tmanage/mcp-server`: name `tmanage`, `CATALOG_SERVER_VERSION`
 * (`mcp-server-card.test.ts` keeps the two in step), Streamable HTTP, and the tools, resources
 * and prompts that catalog registers. Sign-in is OAuth 2.1 (authorization code with S256 PKCE,
 * discovery at `/.well-known/oauth-protected-resource/mcp`) or a personal access token as a
 * bearer token. Nothing here is secret: every value is also in the endpoint's own discovery.
 */
export const MCP_SERVER_NAME = 'tmanage';
export const MCP_SERVER_VERSION = '0.2.0';

export type McpServerCard = Readonly<{
  $schema: string;
  version: string;
  serverInfo: Readonly<{ name: string; title: string; version: string }>;
  description: string;
  iconUrl: string;
  documentationUrl: string;
  transport: Readonly<{ type: 'streamable-http'; endpoint: string }>;
  capabilities: Readonly<{
    tools: Readonly<Record<string, never>>;
    resources: Readonly<Record<string, never>>;
    prompts: Readonly<Record<string, never>>;
  }>;
  authentication: Readonly<{
    required: true;
    schemes: readonly ('oauth2' | 'bearer')[];
    protectedResourceMetadata: string;
  }>;
  contact: Readonly<{ email: string }>;
}>;

export function mcpServerCard(origin: string = siteOrigin()): McpServerCard {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json',
    version: '1.0',
    serverInfo: { name: MCP_SERVER_NAME, title: 'TManage', version: MCP_SERVER_VERSION },
    description:
      'Lets Claude, ChatGPT and any MCP-capable assistant work in a TManage workspace over the TManage API, with the same permissions as the member who signed in.',
    iconUrl: `${origin}/brand/tmanage-icon-512.png`,
    documentationUrl: absoluteSiteUrl('/developers', origin),
    transport: { type: 'streamable-http', endpoint: `${origin}/mcp` },
    capabilities: { tools: {}, resources: {}, prompts: {} },
    authentication: {
      required: true,
      schemes: ['oauth2', 'bearer'],
      protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource/mcp`,
    },
    contact: { email: SUPPORT_EMAIL },
  };
}
