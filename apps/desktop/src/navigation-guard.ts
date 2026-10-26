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

/* ── AI side panel (Figma 400:5399) ─────────────────────────────────────────────────── */

/**
 * The assistants' own websites the docked AI panel may show. The web app names an assistant by
 * `key` only; the start page and the domains it may move between are fixed here, so the
 * renderer can never point the panel at an arbitrary address. `domains` also lists the sign-in
 * providers an assistant hands off to, so a person can sign in with their own account.
 *
 * Only the panel's own view is classified with these rules: the TManage window keeps
 * `classifyNavigation`, under which every one of these sites is still an outward link.
 */
export interface AssistantSiteRule {
  readonly home: string;
  readonly domains: readonly string[];
}

const SIGN_IN_PROVIDERS = [
  'accounts.google.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'login.live.com',
] as const;

export const AI_ASSISTANT_SITES: Readonly<Record<string, AssistantSiteRule>> = {
  claude: { home: 'https://claude.ai/', domains: ['claude.ai', 'claude.com', 'anthropic.com'] },
  chatgpt: { home: 'https://chatgpt.com/', domains: ['chatgpt.com', 'openai.com'] },
  cursor: { home: 'https://cursor.com/', domains: ['cursor.com', 'cursor.sh'] },
  gemini: { home: 'https://gemini.google.com/', domains: ['gemini.google.com'] },
  copilot: { home: 'https://copilot.microsoft.com/', domains: ['copilot.microsoft.com'] },
  perplexity: { home: 'https://www.perplexity.ai/', domains: ['perplexity.ai'] },
  mistral: { home: 'https://chat.mistral.ai/', domains: ['mistral.ai'] },
};

/** The rule for a key the web app sent; `undefined` for anything not on the list. */
export function assistantSite(siteKey: unknown): AssistantSiteRule | undefined {
  if (typeof siteKey !== 'string' || !Object.hasOwn(AI_ASSISTANT_SITES, siteKey)) return undefined;
  return AI_ASSISTANT_SITES[siteKey];
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Decide a navigation inside the AI panel's view: the assistant's own https domains (and the
 * sign-in providers) stay in the panel; any other web, mail or phone link goes to the system
 * browser; everything else — TManage itself included, other schemes, unknown keys — is dropped or
 * sent out, never loaded beside the assistant.
 */
export function classifyAssistantNavigation(
  targetUrl: string,
  siteKey: string,
): NavigationDecision {
  const site = assistantSite(siteKey);
  if (!site || typeof targetUrl !== 'string' || targetUrl.length === 0) return 'block';
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return 'block';
  }
  if (target.protocol === 'https:' && target.username === '' && target.password === '') {
    const host = target.hostname.toLowerCase();
    const allowed = [...site.domains, ...SIGN_IN_PROVIDERS];
    if (allowed.some((domain) => hostMatches(host, domain))) return 'allow';
  }
  if (
    EXTERNAL_WEB_PROTOCOLS.has(target.protocol) ||
    EXTERNAL_HANDOFF_PROTOCOLS.has(target.protocol)
  ) {
    return 'external';
  }
  return 'block';
}
