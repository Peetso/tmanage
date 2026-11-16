import { mcpServerCard } from '../../../../lib/mcp-server-card';

/**
 * `/.well-known/mcp/server-card.json`: the MCP Server Card of the hosted endpoint (SEP-1649,
 * AGENTREADY). Prerendered; it reads nothing from the request.
 */
export const dynamic = 'force-static';

export function GET(): Response {
  return Response.json(mcpServerCard(), {
    headers: { 'x-content-type-options': 'nosniff', 'cache-control': 'public, max-age=3600' },
  });
}
