import type { RelyingParty } from './webauthn.js';

/**
 * 56-22. The WebAuthn relying party from the web's public URL: the RP id is its host, the only
 * accepted origin is its origin. Without `WEB_PUBLIC_URL` (local development) it is the local web
 * server — `localhost` is the one host browsers allow WebAuthn on without TLS.
 */
export function relyingPartyFrom(
  webPublicUrl: string | undefined,
): RelyingParty & { readonly name: string } {
  const url = new URL(webPublicUrl && webPublicUrl !== '' ? webPublicUrl : 'http://localhost:3000');
  return { rpId: url.hostname, origins: [url.origin], name: 'TManage' };
}
