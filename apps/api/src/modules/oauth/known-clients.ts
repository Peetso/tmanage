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
