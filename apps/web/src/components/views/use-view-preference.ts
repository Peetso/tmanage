'use client';

import { useCallback, useEffect, useState } from 'react';

/** The `localStorage` key a page's chosen view is kept under. */
export function viewPreferenceKey(scope: string): string {
  return `tm.view.${scope}`;
}

/** The stored view for `scope`, when it is one of `allowed`; otherwise `null`. */
export function readViewPreference<V extends string>(
  scope: string,
  allowed: readonly V[],
): V | null {
  try {
    const stored = globalThis.localStorage?.getItem(viewPreferenceKey(scope));
    return stored !== null &&
      stored !== undefined &&
      (allowed as readonly string[]).includes(stored)
      ? (stored as V)
      : null;
  } catch {
    // Private mode or a blocked storage: the page simply opens on its default view.
    return null;
  }
}

export function writeViewPreference(scope: string, view: string): void {
  try {
    globalThis.localStorage?.setItem(viewPreferenceKey(scope), view);
  } catch {
    // Not remembering a view is harmless; the choice still applies for this visit.
  }
}

/**
 * **R38 G5-views** — the view a list page shows (List, Board, Grid…), remembered per page in this
 * browser. `scope` names the page and the organization (`projects:<orgSlug>`), so two workspaces
 * keep their own choice.
 *
 * The first render is always `fallback` (or `initial`), so the server and the first client paint
 * agree; the stored choice is applied right after mount. An explicit `initial` — a `?view=` in the
 * address — wins over the stored choice and is not overwritten until the person picks again.
 */
export function useViewPreference<V extends string>(
  scope: string,
  allowed: readonly V[],
  fallback: V,
  initial?: V,
): [V, (view: V) => void] {
  const [view, setView] = useState<V>(initial ?? fallback);

  useEffect(() => {
    if (initial !== undefined) return;
    const stored = readViewPreference(scope, allowed);
    if (stored !== null) setView(stored);
    // `allowed` is a constant list at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, initial]);

  const choose = useCallback(
    (next: V) => {
      setView(next);
      writeViewPreference(scope, next);
    },
    [scope],
  );

  return [view, choose];
}
