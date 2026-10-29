/**
 * Before/after values for the action log (platform-admin v2, SPEC §6 0241, §9 risk 4).
 *
 * An audit event may now say what changed — field, before, after — in `audit_event_changes`
 * (org events) or `before_json`/`after_json` (platform events). Values are written there, never
 * into `metadata_json`, and they pass through this file first:
 *
 * - **Secret-ish fields are redacted by name**: `password*`, `*token*`, `*secret*`, `*hash*`,
 *   `refresh_*` (case-insensitive, `camelCase` included). The value is dropped, not masked, and
 *   the row says `redacted = 1`, so the screen can mark it without ever having held it.
 * - **Every value is capped at 2000 characters** (the column width), so a long body cannot
 *   become a long audit row.
 */

export const MAX_CHANGE_VALUE_LENGTH = 2000;
export const MAX_CHANGE_FIELD_LENGTH = 64;
/** Shown in place of a redacted value inside platform before/after JSON. */
export const REDACTED_MARK = '[redacted]';

export interface AuditChangeInput {
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface AuditChangeRow {
  readonly field: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly redacted: boolean;
}

/** `passwordHash`, `refresh_token_hash` and `apiSecret` are all redacted; `title` is not. */
export function isRedactedField(field: string): boolean {
  const name = field
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .trim();
  return (
    name.startsWith('password') ||
    name.startsWith('refresh_') ||
    name.includes('token') ||
    name.includes('secret') ||
    name.includes('hash')
  );
}

/** One value as stored text: `null` stays `null`, strings as-is, everything else as JSON; capped. */
export function changeValueText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let text: string;
  if (typeof value === 'string') text = value;
  else if (value instanceof Date) text = value.toISOString();
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > MAX_CHANGE_VALUE_LENGTH ? text.slice(0, MAX_CHANGE_VALUE_LENGTH) : text;
}

/** The rows `audit_event_changes` receives. Empty field names are dropped. */
export function redactChanges(changes: readonly AuditChangeInput[]): AuditChangeRow[] {
  const rows: AuditChangeRow[] = [];
  for (const change of changes) {
    const field = String(change.field ?? '')
      .trim()
      .slice(0, MAX_CHANGE_FIELD_LENGTH);
    if (field === '') continue;
    if (isRedactedField(field)) {
      rows.push({ field, before: null, after: null, redacted: true });
      continue;
    }
    rows.push({
      field,
      before: changeValueText(change.before),
      after: changeValueText(change.after),
      redacted: false,
    });
  }
  return rows;
}

/**
 * A redacted, capped copy of a before/after object for `platform_admin_audit_events`. Keys that
 * name a secret become {@link REDACTED_MARK}; strings longer than the cap are cut; depth is
 * bounded so a cyclic or huge object cannot blow up the write.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') {
    return value.length > MAX_CHANGE_VALUE_LENGTH ? value.slice(0, MAX_CHANGE_VALUE_LENGTH) : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= 6) return REDACTED_MARK;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactValue(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isRedactedField(key) ? REDACTED_MARK : redactValue(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** `before_json`/`after_json` text: redacted JSON, or `null` when nothing was given. */
export function redactedJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(redactValue(value));
}
