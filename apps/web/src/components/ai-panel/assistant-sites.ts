import type { ConnectedApp } from '../../lib/api/connected-apps';

/**
 * "Let AI do the job" (Figma section 400:5399): which assistant to open, and where.
 *
 * Pure, so the chooser decision is provable without a render. An assistant is one of the person's
 * Connected apps whose name we can tie to a public website; it is opened on that website, with the
 * person's own account there. TManage never draws the assistant's page itself.
 */

/** A website the panel may open. `key` is what the desktop shell is told; it never takes a URL. */
export interface AssistantSite {
  readonly key: string;
  /** The plain-text name the design shows (no logos). */
  readonly label: string;
  readonly home: string;
}

export const ASSISTANT_SITES: readonly AssistantSite[] = [
  { key: 'claude', label: 'Claude', home: 'https://claude.ai/' },
  { key: 'chatgpt', label: 'ChatGPT', home: 'https://chatgpt.com/' },
  { key: 'cursor', label: 'Cursor', home: 'https://cursor.com/' },
  { key: 'gemini', label: 'Gemini', home: 'https://gemini.google.com/' },
  { key: 'copilot', label: 'Copilot', home: 'https://copilot.microsoft.com/' },
  { key: 'perplexity', label: 'Perplexity', home: 'https://www.perplexity.ai/' },
  { key: 'mistral', label: 'Le Chat', home: 'https://chat.mistral.ai/' },
];

const NAME_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/claude|anthropic/i, 'claude'],
  [/chatgpt|openai/i, 'chatgpt'],
  [/cursor/i, 'cursor'],
  [/gemini/i, 'gemini'],
  [/copilot/i, 'copilot'],
  [/perplexity/i, 'perplexity'],
  [/mistral|le chat/i, 'mistral'],
];

/** The website for a connected app's name; `undefined` when it has none we can open. */
export function siteForAppName(clientName: string): AssistantSite | undefined {
  const match = NAME_PATTERNS.find(([pattern]) => pattern.test(clientName));
  return match ? siteByKey(match[1]) : undefined;
}

export function siteByKey(key: string | null | undefined): AssistantSite | undefined {
  return ASSISTANT_SITES.find((site) => site.key === key);
}

/** "claude.ai", "chatgpt.com" — the host the trust chip shows. */
export function siteHost(site: AssistantSite): string {
  return new URL(site.home).hostname.replace(/^www\./, '');
}

/** One row of the chooser: an assistant and the connection that feeds it. */
export interface AssistantChoice {
  readonly site: AssistantSite;
  readonly connection: ConnectedApp;
}

/**
 * The chooser rows: one per assistant, newest use first. When several connections lead to the same
 * assistant, the person's own one wins, then the most recently used.
 */
export function assistantChoices(apps: readonly ConnectedApp[]): AssistantChoice[] {
  const best = new Map<string, AssistantChoice>();
  for (const connection of apps) {
    const site = siteForAppName(connection.clientName);
    if (!site) continue;
    const current = best.get(site.key);
    if (!current || ranksAbove(connection, current.connection)) {
      best.set(site.key, { site, connection });
    }
  }
  return [...best.values()].sort(
    (a, b) => usedAt(b.connection) - usedAt(a.connection) || compareOrder(a.site, b.site),
  );
}

function ranksAbove(candidate: ConnectedApp, current: ConnectedApp): boolean {
  if (candidate.mine !== current.mine) return candidate.mine;
  return usedAt(candidate) > usedAt(current);
}

function usedAt(app: ConnectedApp): number {
  return app.lastUsedAt ? Date.parse(app.lastUsedAt) : 0;
}

function compareOrder(a: AssistantSite, b: AssistantSite): number {
  return ASSISTANT_SITES.indexOf(a) - ASSISTANT_SITES.indexOf(b);
}

export type LaunchDecision =
  | { readonly kind: 'empty' }
  | { readonly kind: 'open'; readonly site: AssistantSite }
  | { readonly kind: 'choose'; readonly choices: readonly AssistantChoice[] };

/**
 * What the button does: a remembered assistant opens straight away, a single one opens straight
 * away, several show the chooser, none shows the empty state with the connector address.
 */
export function decideLaunch(
  choices: readonly AssistantChoice[],
  rememberedKey: string | null,
): LaunchDecision {
  const remembered = siteByKey(rememberedKey);
  if (remembered) return { kind: 'open', site: remembered };
  const [only] = choices;
  if (choices.length === 1 && only) return { kind: 'open', site: only.site };
  if (choices.length === 0) return { kind: 'empty' };
  return { kind: 'choose', choices };
}

/**
 * The panel's footer state: the assistant has used TManage (connected), is connected but has not
 * called TManage yet (sign in first), or has no live connection here (connector not added).
 */
export type ConnectionState = 'connected' | 'first-time' | 'missing';

export function connectionState(
  choice: AssistantChoice | undefined,
  aiAccessEnabled: boolean,
): ConnectionState {
  if (!choice || !aiAccessEnabled) return 'missing';
  return choice.connection.lastUsedAt ? 'connected' : 'first-time';
}

/** The person's remembered assistant, per workspace and person. Storage may be unavailable. */
export function rememberKey(organizationSlug: string, viewerName: string): string {
  return `tmanage.ai-panel.choice:${organizationSlug}:${viewerName}`;
}

export function readRemembered(storageKey: string): string | null {
  try {
    return siteByKey(window.localStorage.getItem(storageKey))?.key ?? null;
  } catch {
    return null;
  }
}

export function writeRemembered(storageKey: string, siteKey: string | null): void {
  try {
    if (siteKey) window.localStorage.setItem(storageKey, siteKey);
    else window.localStorage.removeItem(storageKey);
  } catch {
    // A private window without storage simply does not remember.
  }
}

/** Where the website opens the assistant: a window as tall as TManage, beside it. */
export interface WindowPlacement {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function besideWindowPlacement(
  screen: { availLeft: number; availTop: number; availWidth: number; availHeight: number },
  win: { screenX: number; screenY: number; outerWidth: number; outerHeight: number },
  rtl: boolean,
): WindowPlacement {
  const width = Math.round(Math.min(480, Math.max(360, screen.availWidth / 3)));
  const height = Math.round(Math.min(win.outerHeight, screen.availHeight));
  const minLeft = screen.availLeft;
  const maxLeft = screen.availLeft + screen.availWidth - width;
  const wanted = rtl ? win.screenX - width : win.screenX + win.outerWidth;
  const left = Math.round(Math.min(maxLeft, Math.max(minLeft, wanted)));
  const top = Math.round(Math.max(screen.availTop, win.screenY));
  return { left, top, width, height };
}

/** `{name}`-style placeholders in a catalog string. */
export function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}
