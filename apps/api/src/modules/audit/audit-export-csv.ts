import { escapeCsvCell, toCsv } from '@tmanage/domain';
import type { AdminAuditEventView } from './audit.service.js';

export { escapeCsvCell };

/**
 * CSV serialization for the Administration audit export — ADM-09 (x118).
 *
 * The bytes half of the export: the capability gate, the tenant scope and the row cap all live
 * in {@link AuditService.exportForViewer}; this file only turns the narrow projection into a
 * spreadsheet-safe document. Two properties it is responsible for, and both are security ones:
 *
 * ## The columns are exactly the viewer's seven, in a fixed order
 *
 * `id, occurredAt, actorId, action, entityType, entityId, summary` — the {@link AdminAuditEventView}
 * fields and nothing else. There is no row-to-cells mapping that could reach for `metadata`, a
 * correlation id or an internal column, because the input is already the narrowed view (x115's
 * redaction), and the header names the whole surface a caller ever sees.
 *
 * ## A cell can never become a formula (CSV injection)
 *
 * `26-THREAT-MODELS` treats exported data opened in a spreadsheet as a sink: a cell whose text
 * begins `=`, `+`, `-`, `@` or a tab/CR is evaluated by Excel/Sheets as a formula, so an audit
 * `action` or `summary` a producer influenced could exfiltrate or execute on the reader's
 * machine. Every cell is therefore prefixed with a single quote when it starts with one of those
 * triggers, and then quoted the ordinary RFC 4180 way if it carries a comma, quote or newline.
 * The guard runs before the quoting so a value like `=cmd,1` is neutralized *and* enclosed.
 */

/** The header row — the {@link AdminAuditEventView} fields, in the order the export emits them. */
export const AUDIT_CSV_HEADER = [
  'id',
  'occurredAt',
  'actorId',
  'action',
  'entityType',
  'entityId',
  'summary',
] as const;

/** Serialize the narrow audit view to a CSV document, header first, newest-first order preserved. */
export function auditEventsToCsv(events: readonly AdminAuditEventView[]): string {
  return toCsv(
    events.map((event) => [
      event.id,
      event.occurredAt,
      event.actorId,
      event.action,
      event.entityType,
      event.entityId,
      event.summary,
    ]),
    AUDIT_CSV_HEADER,
  );
}
