/**
 * The connected AI app's name on an audit row (`actor_app`), so a work item's activity can say
 * "Comment written by Peter from Claude via the connector".
 *
 * Audit metadata holds identifiers and classifications only (`assertSafeAuditMetadata`): no spaces,
 * at most 64 characters. A client name is stored in that shape — spaces become `_`, anything else
 * outside `[A-Za-z0-9._:-]` is dropped — and read back with `_` as a space. The placeholders the
 * auth paths use when no real name is known record nothing, so the feed falls back to "an AI
 * assistant" rather than echoing a placeholder as if it were an app.
 */

const PLACEHOLDER_NAMES: ReadonlySet<string> = new Set([
  'ai assistant',
  'ai app',
  'personal access token',
]);

const MAX_LENGTH = 64;

/** The safe stored form of an app name, or `undefined` when there is no real name to record. */
export function actorAppAuditValue(name: string | undefined): string | undefined {
  const trimmed = name?.trim() ?? '';
  if (trimmed === '' || PLACEHOLDER_NAMES.has(trimmed.toLowerCase())) return undefined;
  const safe = trimmed
    .replace(/\s+/gu, '_')
    .replace(/[^A-Za-z0-9._:-]/gu, '')
    .slice(0, MAX_LENGTH);
  return safe.replace(/[_.:-]/gu, '') === '' ? undefined : safe;
}

/** The display name read back from an audit row's metadata; `null` when absent or malformed. */
export function actorAppFromMetadata(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)['actor_app'];
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/u.test(value)) return null;
  return value.replace(/_/gu, ' ');
}
