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
