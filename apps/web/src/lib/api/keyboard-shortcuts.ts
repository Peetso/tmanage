import type { ApiClient } from './client';

/**
 * PRF keyboard shortcuts (module 20, x286) — the caller's own overrides of the command-palette
 * keyboard chords, read as a resolved map, rebound one action at a time, and reset to the shipped
 * default. Behind `work.read` on the server (the internal-read capability the sibling preferences
 * slices reuse); a caller without it gets the ordinary 403 the shared client turns into an error. The
 * tenant is the slug in the path resolved against the caller's membership, and the *member* is the
 * authenticated principal — never a value this client supplies — so it can only ever read or write the
 * caller's own rows.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projections in the
 * `e2e/contracts` shape check so the two shapes cannot drift.
 */

/** One resolved shortcut: an action, its shipped default, and its effective chord. Paired Exact. */
export interface ResolvedShortcutView {
  readonly actionKey: string;
  readonly title: string;
  readonly defaultChord: string;
  readonly chord: string;
  readonly overridden: boolean;
}

/** What `GET .../me/shortcuts` returns: the resolved map. Paired Exact with the API view. */
export interface ShortcutMapView {
  readonly shortcuts: readonly ResolvedShortcutView[];
}

/** What a PUT returns: the one action's resolved state after the rebind. Paired Exact. */
export interface ShortcutView {
  readonly actionKey: string;
  readonly chord: string;
}

/** The modifiers a chord may carry, in the canonical order the API resolves them in. */
export const CHORD_MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
export type ChordModifier = (typeof CHORD_MODIFIERS)[number];

/** The named (non-character) keys a chord may end in, beyond a single letter or digit. */
export const NAMED_KEYS: readonly string[] = [
  'Enter',
  'Escape',
  'Space',
  'Tab',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
];

/**
 * Whether `chord` matches the fixed grammar the API enforces: zero or more distinct modifiers joined
 * by `+`, then exactly one key (a single letter/digit or a named key). The capture control validates
 * with this before enabling the save, so the client never sends a chord the server will 400.
 */
export function isValidChord(chord: string): boolean {
  if (chord.length === 0 || chord.length > 64) {
    return false;
  }
  const parts = chord.split('+');
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const seen = new Set<string>();
  for (const mod of mods) {
    if (!CHORD_MODIFIERS.includes(mod as ChordModifier) || seen.has(mod)) {
      return false;
    }
    seen.add(mod);
  }
  if (key === undefined) {
    return false;
  }
  return /^[A-Za-z0-9]$/.test(key) || NAMED_KEYS.includes(key);
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/me/shortcuts`;
}

export async function getShortcutMap(
  client: ApiClient,
  organizationSlug: string,
): Promise<ShortcutMapView> {
  const { data } = await client.request<ShortcutMapView>({ path: base(organizationSlug) });
  return data;
}

export async function rebindShortcut(
  client: ApiClient,
  organizationSlug: string,
  actionKey: string,
  chord: string,
): Promise<ShortcutView> {
  const { data } = await client.request<ShortcutView>({
    method: 'PUT',
    path: `${base(organizationSlug)}/${encodeURIComponent(actionKey)}`,
    body: { chord },
  });
  return data;
}

export async function resetShortcut(
  client: ApiClient,
  organizationSlug: string,
  actionKey: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(actionKey)}`,
  });
}
