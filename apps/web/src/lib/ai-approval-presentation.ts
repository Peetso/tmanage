/**
 * Pure presentation rules for the AI approve page (MCP connector S10). Kept out of the screen so
 * they are unit tested without a DOM.
 */

/** `m:ss` for the "Expires in" capsule; never negative. */
export function formatCountdown(msLeft: number): string {
  const total = Math.max(0, Math.ceil(msLeft / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * A readable label for an action argument: `workItemId` → `Work item`, `due_date` → `Due date`.
 * The trailing `Id` is dropped because the row shows the value, not the kind of key.
 */
export function fieldLabel(name: string): string {
  const words = name
    .replace(/Ids?$/u, '')
    .replace(/[_-]+/gu, ' ')
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .trim()
    .toLowerCase();
  const text = words === '' ? name : words;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Replace `{name}` placeholders in a catalog string. Unknown placeholders are left as they are. */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-zA-Z]+)\}/gu, (match, key: string) => values[key] ?? match);
}

/** One letter for the AI app's orb: the first letter of its name, upper-cased. */
export function clientInitial(clientName: string): string {
  return (clientName.trim().charAt(0) || '?').toUpperCase();
}

/**
 * A catalog lookup that answers `undefined` for a key the catalogs do not hold, so a caller can
 * fall back to the server's English.
 */
export type CatalogLookup = (key: string) => string | undefined;

/** Catalog key for a registry op's title, e.g. `aiApprove.op.work_items.delete`. */
export function opTitleKey(opId: string): string {
  return `aiApprove.op.${opId}`;
}

/** Catalog key for an action argument's label, e.g. `aiApprove.field.workItemId`. */
export function fieldLabelKey(name: string): string {
  return `aiApprove.field.${name}`;
}

/**
 * The op title in the reader's language. The server sends it in English (it is built from the
 * registry, never by the AI); the catalog is keyed by the stable op id, and an op not yet in the
 * catalog keeps the server's English.
 */
export function localizedOpTitle(lookup: CatalogLookup, opId: string, serverTitle: string): string {
  return lookup(opTitleKey(opId)) ?? serverTitle;
}

/** An argument's label in the reader's language, keyed by the field id; English otherwise. */
export function localizedFieldLabel(lookup: CatalogLookup, name: string): string {
  return lookup(fieldLabelKey(name)) ?? fieldLabel(name);
}

/** English fallbacks for the bold subject line until the `i18n-FIX-APPROVE` keys are merged. */
const SUBJECT_TEMPLATES = {
  'aiApprove.subjectDelete': 'Delete “{name}”',
  'aiApprove.subject': '“{name}”',
} as const;

/**
 * The bold line naming the item (Figma 365:1229): `Delete “Homepage direction review”` for a
 * delete, the quoted name alone otherwise. `null` when the server could not name the target.
 */
export function subjectLine(
  lookup: CatalogLookup,
  subject: string | null | undefined,
  destructive: boolean,
): string | null {
  if (subject === null || subject === undefined || subject.trim() === '') return null;
  const key = destructive ? 'aiApprove.subjectDelete' : 'aiApprove.subject';
  return fillTemplate(lookup(key) ?? SUBJECT_TEMPLATES[key], { name: subject });
}
