/**
 * The known-client allow-list (MCP connector S8, threat model row B2 "Consent phishing").
 *
 * A Client-ID Metadata Document URL whose host is one of these gets the consent page's green
 * **"Verified"** badge (S9); every other client — DCR or an unrecognised CIMD host — shows the
 * red **"Unverified app"** warning instead. The list is deliberately small and exact: it names
 * only the first-party AI vendors whose connector flows were checked on 2026-10-20 (plan §5).
 *
 * Matching is on the registrable host only (exact host or a subdomain of a listed apex), never a
 * substring, so `claude.ai.evil.com` and `evilclaude.ai` never match. The scheme must be https
 * (CIMD is https-only); a loopback or http URL is never verified.
 */

/** Apex hosts whose CIMD documents TManage recognises as first-party and shows as "Verified". */
const KNOWN_CIMD_HOSTS: readonly string[] = Object.freeze([
  'claude.ai',
  'claude.com',
  'anthropic.com',
  'chatgpt.com',
  'openai.com',
  'cursor.com',
  'cursor.sh',
]);

/**
 * Is this CIMD `client_id` URL a known first-party host (so the consent page may show it as
 * verified)? The input is the client-supplied metadata URL; it is parsed, required to be https,
 * and its host must equal a listed apex or be a subdomain of one.
 */
export function isKnownCimdClient(clientIdUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(clientIdUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return KNOWN_CIMD_HOSTS.some((apex) => host === apex || host.endsWith(`.${apex}`));
}

/**
 * **The AI apps TManage recognises by their verified client id (AI panel, Fable 5.2 ruling
 * 2026-11-23, must-fix 3).** The panel's app mark and its "Open" link are chosen from this table
 * and nothing else: never from the display name a client registered, so an unknown client that
 * calls itself "Claude" gets the neutral mark and no link.
 *
 * A client is recognised only when it is a CIMD client (its `client_id` is the https URL of its
 * metadata document), it was verified when it registered, and that URL's host is one of the
 * app's hosts by the same exact-host-or-subdomain rule as {@link isKnownCimdClient}. A DCR client
 * (an opaque id it chose itself) is never recognised.
 */
export const KNOWN_AI_APPS = ['claude', 'chatgpt', 'cursor'] as const;
export type KnownAiApp = (typeof KNOWN_AI_APPS)[number];

const KNOWN_APP_TABLE: Readonly<
  Record<KnownAiApp, { readonly hosts: readonly string[]; readonly openUrl: string | null }>
> = Object.freeze({
  claude: { hosts: ['claude.ai', 'claude.com', 'anthropic.com'], openUrl: 'https://claude.ai/' },
  chatgpt: { hosts: ['chatgpt.com', 'openai.com'], openUrl: 'https://chatgpt.com/' },
  // Cursor is a desktop editor: no web page to open (Figma: "an app with no web link").
  cursor: { hosts: ['cursor.com', 'cursor.sh'], openUrl: null },
});

/** The client fields the decision reads (`oauth_clients`). */
export interface ClientIdentity {
  readonly kind: string;
  readonly clientId: string;
  readonly verified: boolean;
}

/** The app a verified client is, or `null` for every other client. Pure. */
export function knownAiAppOf(client: ClientIdentity): KnownAiApp | null {
  if (client.kind !== 'cimd' || !client.verified || !isKnownCimdClient(client.clientId)) {
    return null;
  }
  const host = new URL(client.clientId).hostname.toLowerCase();
  for (const app of KNOWN_AI_APPS) {
    if (KNOWN_APP_TABLE[app].hosts.some((apex) => host === apex || host.endsWith(`.${apex}`))) {
      return app;
    }
  }
  return null;
}

/** Where the panel's "Open" goes for a recognised app; `null` for none (Cursor, unknown apps). */
export function openUrlOf(app: KnownAiApp | null): string | null {
  return app === null ? null : KNOWN_APP_TABLE[app].openUrl;
}
