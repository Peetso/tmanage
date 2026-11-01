'use client';

import { useEffect, useState } from 'react';
import type { ReviewThread } from '../../lib/api/review';

/**
 * R4 slice 10 — what the PSD, ZIP, Office and "no preview" stages share: loading the original's
 * bytes for a browser-side renderer, sizes in words, and reading a thread's page or cell.
 */

export type Loaded<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly value: T }
  | { readonly state: 'failed' };

/** Fetches the original (the session cookie goes along) as bytes. */
export type OriginalFetcher = (src: string) => Promise<ArrayBuffer>;

export const fetchOriginal: OriginalFetcher = async (src) => {
  const response = await fetch(src, { credentials: 'include' });
  if (!response.ok) throw new Error(`original ${response.status}`);
  return response.arrayBuffer();
};

/**
 * Loads `src` and turns it into something drawable with `parse`, once per source. A failure of
 * either step is `failed` — the stage then offers the download instead of a broken drawing.
 */
export function useParsedOriginal<T>(
  src: string | null,
  parse: (bytes: ArrayBuffer) => Promise<T>,
  fetcher: OriginalFetcher = fetchOriginal,
  release?: (value: T) => void,
): Loaded<T> {
  const [loaded, setLoaded] = useState<Loaded<T>>({ state: 'loading' });
  useEffect(() => {
    if (!src) {
      setLoaded({ state: 'failed' });
      return undefined;
    }
    let live = true;
    let made: T | null = null;
    setLoaded({ state: 'loading' });
    fetcher(src)
      .then(parse)
      .then((value) => {
        made = value;
        if (live) setLoaded({ state: 'ready', value });
        else release?.(value);
      })
      .catch(() => {
        if (live) setLoaded({ state: 'failed' });
      });
    return () => {
      live = false;
      if (made !== null) release?.(made);
    };
    // `parse`, `fetcher` and `release` are module-level functions in every caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);
  return loaded;
}

/** `84 KB`, `18.4 MB`, `2.1 GB` — Latin digits, as file sizes are shown everywhere in TManage. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kilo = bytes / 1024;
  if (kilo < 1024) return `${Math.round(kilo)} KB`;
  const mega = kilo / 1024;
  if (mega < 1024) return `${mega >= 100 ? Math.round(mega) : mega.toFixed(1)} MB`;
  return `${(mega / 1024).toFixed(1)} GB`;
}

/** A thread's cell anchor (`{sheet, cell}`), or `null`. */
export function cellAnchorOf(thread: ReviewThread): { sheet: string; cell: string } | null {
  if (thread.anchorKind !== 'cell' || !thread.anchor) return null;
  const sheet = thread.anchor['sheet'];
  const cell = thread.anchor['cell'];
  return typeof sheet === 'string' && typeof cell === 'string' ? { sheet, cell } : null;
}

/** Open threads per page (or slide) number, for the strip badges. */
export function openCountByPage(threads: readonly ReviewThread[]): ReadonlyMap<number, number> {
  const counts = new Map<number, number>();
  for (const thread of threads) {
    if (thread.status !== 'open' || thread.pageNo === null) continue;
    counts.set(thread.pageNo, (counts.get(thread.pageNo) ?? 0) + 1);
  }
  return counts;
}

/** The file's extension in capitals (`EPS`), for the big file-type tile. */
export function extensionLabel(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const extension = dot > 0 ? fileName.slice(dot + 1) : '';
  return /^[a-z0-9]{1,6}$/i.test(extension) ? extension.toUpperCase() : '';
}
