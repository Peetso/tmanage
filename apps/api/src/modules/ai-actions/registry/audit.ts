/**
 * AI action details — audit log (read and export).
 *
 * Slice S4 (registry wave C). Reading the log is a plain read; exporting the whole log (JSON or
 * CSV) is confirm-class because it is a bulk extraction of org-wide activity (plan §2; architecture
 * B4/T-RED). The `audit` redaction profile strips token hashes, raw bodies and IP addresses from
 * every result, so an AI principal never sees a secret in the log.
 */
import { det, listArgs, queryArgs, pathOnly, f, type AiActionDetail } from './detail.js';

export const auditDetails: readonly AiActionDetail[] = [
  det({
    id: 'audit.events.list',
    title: 'List audit events',
    description:
      'Recent activity in the workspace, newest first. Filter by who acted (actorId) or by the record it touched (entityId); page with before.',
    input: listArgs(
      [],
      { actorId: f.id().optional(), entityId: f.id(190).optional() },
      { cursor: 'before' },
    ),
    redact: 'audit',
    examples: [{ summary: 'Last 50', args: { limit: 50 } }],
  }),
  det({
    id: 'audit.events.changes',
    title: 'Show what one audit event changed',
    description: 'Before and after values, field by field, for one audit event you may see.',
    input: pathOnly('eventId'),
    redact: 'audit',
    examples: [{ summary: 'One event', args: { eventId: 'ev_123' } }],
  }),
  det({
    id: 'audit.events.export',
    title: 'Export the audit log',
    description:
      'Export audit events in bulk, optionally only one actor (actorId) or record (entityId), older than before. Confirm-class: a full extraction of org activity.',
    input: queryArgs([], {
      before: f.cursor,
      actorId: f.id().optional(),
      entityId: f.id(190).optional(),
    }),
    redact: 'audit',
    examples: [{ summary: 'Export all', args: {} }],
  }),
  det({
    id: 'audit.export_csv',
    title: 'Export the audit log as CSV',
    description:
      'Download the audit log for a from/to window (ISO instants, at most 366 days) as a CSV file, optionally one actor or one action. Confirm-class: bulk extraction.',
    input: queryArgs([], {
      from: f.iso(),
      to: f.iso(),
      actor: f.id().optional(),
      action: f.shortText(120).optional(),
    }),
    redact: 'audit',
    examples: [
      {
        summary: 'November as CSV',
        args: { from: '2026-11-01T00:00:00Z', to: '2026-11-30T23:59:59Z' },
      },
    ],
  }),
];
