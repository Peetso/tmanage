/**
 * 55-08 Progressive disclosure — remembers, per person and per form, whether "More options" was
 * left open. Someone who always sets an owner and labels gets the full form next time; someone
 * who never does keeps the short one.
 *
 * Browser storage only (a display preference, never sent to the server). The key holds the
 * user id, so two people sharing a browser do not inherit each other's choice. Storage that
 * throws (private mode, quota) is treated as "nothing remembered".
 */

export type DisclosureForm = 'task' | 'project' | 'client' | 'meeting' | 'invoice';

export interface DisclosureStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PREFIX = 'tm.more-options.v1';

export function disclosureKey(userId: string | null | undefined, form: DisclosureForm): string {
  return `${PREFIX}.${userId && userId.trim() !== '' ? userId : 'anonymous'}.${form}`;
}

export function readDisclosure(
  storage: DisclosureStorage | null | undefined,
  userId: string | null | undefined,
  form: DisclosureForm,
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(disclosureKey(userId, form)) === 'open';
  } catch {
    return false;
  }
}

export function writeDisclosure(
  storage: DisclosureStorage | null | undefined,
  userId: string | null | undefined,
  form: DisclosureForm,
  open: boolean,
): void {
  if (!storage) return;
  try {
    storage.setItem(disclosureKey(userId, form), open ? 'open' : 'closed');
  } catch {
    // Remembering is a convenience; a refusing store must never break the form.
  }
}

/** `window.localStorage` when it exists and can be touched, else `null`. */
export function browserDisclosureStorage(): DisclosureStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
