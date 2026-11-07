/**
 * AI action details — audit log (read and export).
 *
 * Slice S4 (registry wave C). Reading the log is a plain read; exporting the whole log (JSON or
 * CSV) is confirm-class because it is a bulk extraction of org-wide activity (plan §2; architecture
 * B4/T-RED). The `audit` redaction profile strips token hashes, raw bodies and IP addresses from
 * every result, so an AI principal never sees a secret in the log.
 */
import { det, listArgs, noArgs, pathOnly, f, type AiActionDetail } from './detail.js';

export const auditDetails: readonly AiActionDetail[] = [
  det({
    id: 'audit.events.list',
    title: 'List audit events',
    description: 'Recent activity in the workspace, newest first. Filter by actor, action or date.',
    input: listArgs([], {
      actorUserId: f.id().optional(),
      action: f.shortText(80).optional(),
      since: f.iso().optional(),
      until: f.iso().optional(),
    }),
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
    description: 'Export audit events in bulk. Confirm-class: a full extraction of org activity.',
    input: noArgs(),
    redact: 'audit',
    examples: [{ summary: 'Export all', args: {} }],
  }),
  det({
    id: 'audit.export_csv',
    title: 'Export the audit log as CSV',
    description: 'Download the audit log as a CSV file. Confirm-class: bulk extraction.',
    input: noArgs(),
    redact: 'audit',
    examples: [{ summary: 'CSV export', args: {} }],
  }),
];
