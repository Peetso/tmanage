/**
 * AI action details — data import (validate, commit, receipt).
 *
 * Slice S4 (registry wave C). Validation and commit are confirm-class because a commit writes a
 * batch of records into the workspace (plan §2, "imports"); the receipt is a read.
 */
import { det, pathOnly, bodyArgs, f, type AiActionDetail } from './detail.js';

export const importDetails: readonly AiActionDetail[] = [
  det({
    id: 'imports.list',
    title: 'List recent imports',
    description:
      'The most recent finished imports, newest first, with their counts and undo window.',
    input: pathOnly(),
    redact: 'standard',
    examples: [{ summary: 'Recent imports', args: {} }],
  }),
  det({
    id: 'imports.receipt.list',
    title: 'Get an import receipt',
    description: 'The outcome of a finished import job — what was created, skipped or rejected.',
    input: pathOnly('jobId'),
    redact: 'standard',
    examples: [{ summary: 'By job', args: { jobId: 'job_1' } }],
  }),
  det({
    id: 'imports.validations.create',
    title: 'Validate an import',
    description: 'Dry-run an import to see what would happen, without writing. Confirm-class.',
    input: bodyArgs([], {
      sourceKind: f.shortText(40),
      mapping: f.config(),
      rows: z_rows(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Validate 1 row',
        args: { sourceKind: 'work_items', mapping: { title: 'A' }, rows: [{ title: 'Task' }] },
      },
    ],
  }),
  det({
    id: 'imports.commits.create',
    title: 'Commit an import',
    description: 'Write a validated import batch into the workspace. Confirm-class: bulk create.',
    input: bodyArgs([], {
      sourceKind: f.shortText(40),
      mapping: f.config(),
      rows: z_rows(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Commit 1 row',
        args: { sourceKind: 'work_items', mapping: { title: 'A' }, rows: [{ title: 'Task' }] },
      },
    ],
  }),
];

/** A bounded batch of opaque row objects; the server enforces the per-op size cap. */
function z_rows() {
  return f.config().array().max(1000);
}
