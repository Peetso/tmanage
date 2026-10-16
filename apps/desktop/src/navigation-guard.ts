/**
 * Navigation / external-link guard for the TManage desktop companion (module 22).
 *
 * The desktop shell is an allowlisted wrapper around the hosted product, not a general
 * browser (03-TECHNICAL-ARCHITECTURE §"Phase 1": "Capabilities are allowlisted; no
 * generic shell execution or broad file access"). Every attempted navigation and every
 * `window.open` is therefore classified before it is allowed to happen:
 *
 *   - 'allow'    same origin as the app — keep it inside the BrowserWindow.
 *   - 'external' a safe outward link (other https/http site, mailto:, tel:) — hand it
 *                to the OS default handler and keep it out of the app window.
 *   - 'block'    anything else (file:, data:, javascript:, unparseable, …) — drop it.
 *
 * Pure and Electron-free so the policy can be unit-tested directly.
 */

export type NavigationDecision = 'allow' | 'external' | 'block';

// Protocols we are willing to hand to the operating system's default handler.
const EXTERNAL_WEB_PROTOCOLS = new Set(['https:', 'http:']);
const EXTERNAL_HANDOFF_PROTOCOLS = new Set(['mailto:', 'tel:']);

/**
 * Decide what should happen when the app tries to navigate to, or open, `targetUrl`.
 *
 * `appOrigin` is the canonical origin of the TManage web app (e.g.
 * `http://localhost:3000` or `https://app.tmanage.example`). A target on that exact
 * origin stays in the window; a safe web/mail/tel link goes to the system browser;
 * everything else is blocked.
 */
export function classifyNavigation(targetUrl: string, appOrigin: string): NavigationDecision {
  if (typeof targetUrl !== 'string' || targetUrl.length === 0) return 'block';

  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return 'block';
  }

  let origin: string;
  try {
    origin = new URL(appOrigin).origin;
  } catch {
    // A misconfigured app origin must fail closed, never open.
    return 'block';
  }

  if ((target.protocol === 'https:' || target.protocol === 'http:') && target.origin === origin) {
    return 'allow';
  }
  if (
    EXTERNAL_WEB_PROTOCOLS.has(target.protocol) ||
    EXTERNAL_HANDOFF_PROTOCOLS.has(target.protocol)
  ) {
    return 'external';
  }
  return 'block';
}

/** Convenience predicate for Electron's `setWindowOpenHandler`. */
export function shouldOpenExternally(targetUrl: string, appOrigin: string): boolean {
  return classifyNavigation(targetUrl, appOrigin) === 'external';
}

/** Convenience predicate for Electron's `will-navigate` handler. */
export function isInAppNavigation(targetUrl: string, appOrigin: string): boolean {
  return classifyNavigation(targetUrl, appOrigin) === 'allow';
}
