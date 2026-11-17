'use client';

import { useEffect, useState } from 'react';
import { importToolFromSearch, withImportTool } from './import-link';

/**
 * SEOD (54-29 follow-up) — `path` carrying this page's allow-listed `?import=<tool>`, so a "switch
 * from X" visitor who moves between sign-up and sign-in keeps the tool they came for. The value
 * goes through the same allow-list as the hand-over itself (`import-link.ts`); anything else is
 * dropped and `path` is returned unchanged. Read after mount, so the first render (and the
 * prerendered HTML, which has no query) is `path` and hydration matches.
 */
export function useImportToolHref(path: string): string {
  const [href, setHref] = useState(path);
  useEffect(() => {
    setHref(withImportTool(path, importToolFromSearch(window.location.search)));
  }, [path]);
  return href;
}
