/**
 * Environment configuration for the TManage MCP server.
 *
 * Two values are all a local (stdio) client needs:
 *   - `TMANAGE_API_URL`   the base URL of the TManage API, e.g. https://app.example.com/api
 *   - `TMANAGE_TOKEN`     a personal access token created in TManage → Preferences → Security
 *
 * The transport and, for the remote transport, the listen port are optional:
 *   - `TMANAGE_MCP_TRANSPORT`   "stdio" (default) or "http"
 *   - `TMANAGE_MCP_HTTP_PORT`   the port the Streamable HTTP transport listens on (default 8787)
 *   - `TMANAGE_MCP_HTTP_HOST`   the interface it binds (default 127.0.0.1 — loopback only)
 *   - `TMANAGE_ORG_SLUG`        pins the workspace; omitted, the server uses the token's first org
 *
 * `TMANAGE_TOKEN` is optional for the HTTP transport, where each client may instead present its
 * own token in the request's `Authorization: Bearer` header — so one remote server can serve
 * many members, each acting as themselves. It is required for stdio, which has one operator.
 */

export type McpTransport = 'stdio' | 'http';

export interface McpServerConfig {
  readonly apiUrl: string;
  /** The fallback token. Used by stdio, and by HTTP requests that carry no Bearer header. */
  readonly token: string | undefined;
  readonly transport: McpTransport;
  readonly httpPort: number;
  readonly httpHost: string;
  readonly orgSlug: string | undefined;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

function requireUrl(env: Env): string {
  const raw = env['TMANAGE_API_URL']?.trim();
  if (!raw) {
    throw new ConfigError(
      'TMANAGE_API_URL is required — set it to your TManage API base URL, e.g. ' +
        'https://app.example.com/api',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`TMANAGE_API_URL is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`TMANAGE_API_URL must be http(s): ${raw}`);
  }
  // Store without a trailing slash so request paths join predictably.
  return raw.replace(/\/+$/, '');
}

function readTransport(env: Env): McpTransport {
  const raw = env['TMANAGE_MCP_TRANSPORT']?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'stdio') return 'stdio';
  if (raw === 'http') return 'http';
  throw new ConfigError(`TMANAGE_MCP_TRANSPORT must be "stdio" or "http", got "${raw}"`);
}

function readPort(env: Env): number {
  const raw = env['TMANAGE_MCP_HTTP_PORT']?.trim();
  if (!raw) return 8787;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`TMANAGE_MCP_HTTP_PORT must be a port number, got "${raw}"`);
  }
  return port;
}

/** Build the config from an environment map, defaulting to `process.env`. */
export function loadConfig(env: Env = process.env): McpServerConfig {
  const transport = readTransport(env);
  const token = env['TMANAGE_TOKEN']?.trim() || undefined;
  if (transport === 'stdio' && !token) {
    throw new ConfigError(
      'TMANAGE_TOKEN is required for the stdio transport — create one in TManage → ' +
        'Preferences → Security, then set TMANAGE_TOKEN.',
    );
  }
  return {
    apiUrl: requireUrl(env),
    token,
    transport,
    httpPort: readPort(env),
    httpHost: env['TMANAGE_MCP_HTTP_HOST']?.trim() || '127.0.0.1',
    orgSlug: env['TMANAGE_ORG_SLUG']?.trim() || undefined,
  };
}
