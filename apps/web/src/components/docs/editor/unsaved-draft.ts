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

const DRAFT_PREFIX = 'tm-doc-draft:';

/**
 * FIX5 security review L6: who typed it. A short, non-reversible tag of the signed-in account
 * (its e-mail), so a copy left on a shared computer is never opened for the next person who signs
 * in there; the e-mail itself is not written to the browser's storage.
 */
export function draftOwner(accountEmail: string): string {
  let hash = 0x811c9dc5;
  for (const char of accountEmail.trim().toLowerCase()) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** One doc's backup, for one person in one workspace. */
export function draftKey(organizationSlug: string, owner: string, documentId: string): string {
  return `${DRAFT_PREFIX}${organizationSlug}:${owner}:${documentId}`;
}

/** Sign-out: forget every unsaved doc copy this browser holds, for every account and workspace. */
export function clearAllDraftBackups(storage: DraftStore | null = store()): void {
  try {
    const all = storage as (DraftStore & Pick<Storage, 'length' | 'key'>) | null;
    if (!all || typeof all.key !== 'function') return;
    const keys: string[] = [];
    for (let index = 0; index < all.length; index += 1) {
      const key = all.key(index);
      if (key?.startsWith(DRAFT_PREFIX)) keys.push(key);
    }
    for (const key of keys) all.removeItem(key);
  } catch {
    // Blocked storage: nothing was kept there either.
  }
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
