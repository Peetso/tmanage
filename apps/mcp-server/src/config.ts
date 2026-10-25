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
 * `TMANAGE_TOKEN` is required for stdio, which has one operator. The HTTP transport never uses
 * it: every HTTP request must present its own token in `Authorization: Bearer`, so a peer that
 * can reach the port gains nothing without a credential of its own. Setting `TMANAGE_TOKEN`
 * together with a non-loopback `TMANAGE_MCP_HTTP_HOST` is refused, so the operator's token is
 * never held by a network listener.
 *
 *   - `TMANAGE_MCP_ALLOWED_HOSTS` optional comma list of extra `Host` header values the HTTP
 *     transport accepts (e.g. `mcp.example.com` behind an HTTPS front door). The bind
 *     `host:port` (and, on loopback, `localhost`/`127.0.0.1`/`[::1]` with the port) are always
 *     accepted; anything else is refused 403 (DNS-rebinding protection).
 */

export type McpTransport = 'stdio' | 'http';

export interface McpServerConfig {
  readonly apiUrl: string;
  /** The operator token. Used by stdio only; the HTTP transport requires a per-request Bearer. */
  readonly token: string | undefined;
  readonly transport: McpTransport;
  readonly httpPort: number;
  readonly httpHost: string;
  readonly orgSlug: string | undefined;
  /** `Host` header values the HTTP transport accepts (DNS-rebinding protection). */
  readonly allowedHosts: readonly string[];
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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** True when the bind host only accepts connections from this machine. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return LOOPBACK_HOSTS.has(h) || /^127(\.\d{1,3}){3}$/.test(h);
}

function hostWithPort(host: string, port: number): string {
  const bare = host.replace(/^\[|\]$/g, '');
  return bare.includes(':') ? `[${bare}]:${port}` : `${bare}:${port}`;
}

function readAllowedHosts(env: Env, host: string, port: number): readonly string[] {
  const hosts = new Set<string>([hostWithPort(host, port).toLowerCase()]);
  if (isLoopbackHost(host)) {
    for (const alias of ['127.0.0.1', 'localhost', '[::1]']) hosts.add(`${alias}:${port}`);
  }
  for (const extra of (env['TMANAGE_MCP_ALLOWED_HOSTS'] ?? '').split(',')) {
    const value = extra.trim().toLowerCase();
    if (value) hosts.add(value);
  }
  return [...hosts];
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
  const httpHost = env['TMANAGE_MCP_HTTP_HOST']?.trim() || '127.0.0.1';
  const httpPort = readPort(env);
  if (transport === 'http' && token && !isLoopbackHost(httpHost)) {
    throw new ConfigError(
      `TMANAGE_TOKEN must not be set when the http transport binds a non-loopback host ` +
        `("${httpHost}"). Unset TMANAGE_TOKEN — each client sends its own ` +
        'Authorization: Bearer <token>.',
    );
  }
  return {
    apiUrl: requireUrl(env),
    token,
    transport,
    httpPort,
    httpHost,
    orgSlug: env['TMANAGE_ORG_SLUG']?.trim() || undefined,
    allowedHosts: readAllowedHosts(env, httpHost, httpPort),
  };
}
