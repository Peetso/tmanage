/**
 * B-N2 (live check fd145807): leaving a doc must never lose its body.
 *
 * Two guards, both used by the doc editor screen:
 * 1. A copy of the unsaved body in this browser (`localStorage`), with the version it was typed on.
 *    Reopening the doc offers it again when nobody has saved a newer version since, so a closed
 *    tab, a crash or a failed last save keeps the text.
 * 2. `flushDraft`: leaving the page inside the app saves the body at once, after any save still in
 *    flight, naming the version that save produced.
 */

export interface DraftBackup {
  readonly html: string;
  /** The newest version when the text was typed; `null` before the history came in. */
  readonly baseVersionNo: number | null;
  readonly savedAt: number;
}

type DraftStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function store(): DraftStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function draftKey(organizationSlug: string, documentId: string): string {
  return `tm-doc-draft:${organizationSlug}:${documentId}`;
}

export function writeDraftBackup(
  key: string,
  backup: Omit<DraftBackup, 'savedAt'>,
  storage: DraftStore | null = store(),
): void {
  try {
    storage?.setItem(key, JSON.stringify({ ...backup, savedAt: Date.now() }));
  } catch {
    // A full or blocked storage: the flush on leave is still there.
  }
}

export function clearDraftBackup(key: string, storage: DraftStore | null = store()): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Nothing to clear.
  }
}

export function readDraftBackup(
  key: string,
  storage: DraftStore | null = store(),
): DraftBackup | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DraftBackup>;
    if (typeof parsed.html !== 'string' || parsed.html.trim() === '') return null;
    return {
      html: parsed.html,
      baseVersionNo: typeof parsed.baseVersionNo === 'number' ? parsed.baseVersionNo : null,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
    };
  } catch {
    return null;
  }
}

/**
 * The body to reopen with: the backup when it differs from the stored body and was typed on the
 * newest version (nobody has saved since); otherwise nothing, and a stale backup is dropped.
 */
export function backupToRestore(
  backup: DraftBackup | null,
  stored: string,
  newestVersionNo: number,
): DraftBackup | null {
  if (backup === null || backup.html === stored) return null;
  const base = backup.baseVersionNo ?? 0;
  return base === newestVersionNo ? backup : null;
}

/** Saves `html` after the save in flight (if any), on the version that save produced. */
export async function flushDraft<V extends { readonly versionNo: number }>(
  html: string,
  baseVersionNo: number | null,
  inflight: { readonly html: string; readonly promise: Promise<V> } | null,
  save: (html: string, expectedVersionNo: number | null) => Promise<V>,
): Promise<V | null> {
  let expected = baseVersionNo;
  if (inflight !== null) {
    let landed = false;
    try {
      expected = (await inflight.promise).versionNo;
      landed = true;
    } catch {
      // The save in flight failed: this one names the version it started from.
    }
    if (landed && inflight.html === html) return null;
  }
  return save(html, expected);
}
