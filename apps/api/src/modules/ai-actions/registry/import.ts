/**
 * AI action details — data import (validate, commit, receipt).
 *
 * Slice S4 (registry wave C). Validation and commit are confirm-class because a commit writes a
 * batch of records into the workspace (plan §2, "imports"); the receipt is a read.
 */
import { z } from 'zod';
import { det, pathOnly, bodyArgs, f, type AiActionDetail } from './detail.js';
import { IMPORT_SOURCE_KINDS, MAX_IMPORT_ROWS } from '../../import/import-validation.js';

/** The batch the validate and commit halves both take (`import/import-input.ts`). */
const importBatch = {
  sourceKind: z.enum(IMPORT_SOURCE_KINDS),
  mapping: z
    .record(z.string().max(120), z.string().max(320))
    .describe('Target field to source column, e.g. { "name": "Project name" }'),
  rows: f.config().array().max(MAX_IMPORT_ROWS),
} as const;

/** The kinds whose commit lands in one project and so needs `options.projectId`. */
const PROJECT_TARGETED_KINDS: ReadonlySet<string> = new Set([
  'jira_issues',
  'notion_database',
  'basecamp_messages',
  'monday_board',
  'clickup_tasks',
]);

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
    description:
      'Dry-run an import to see what would happen, without writing: sourceKind, a mapping of target field to source column, and the rows. Returns a report and the jobId to commit. Confirm-class.',
    input: bodyArgs([], importBatch),
    redact: 'standard',
    examples: [
      {
        summary: 'Validate 1 project row',
        args: {
          sourceKind: 'project',
          mapping: { name: 'Project name' },
          rows: [{ 'Project name': 'Website relaunch' }],
        },
      },
    ],
  }),
  det({
    id: 'imports.commits.create',
    title: 'Commit an import',
    description:
      'Write a validated import batch into the workspace: the jobId from the validation plus the same batch. Jira, Notion, Basecamp, monday.com and ClickUp imports also need options.projectId. Confirm-class: bulk create.',
    input: (
      bodyArgs([], {
        jobId: z.string().uuid(),
        ...importBatch,
        options: z
          .object({
            projectId: z.string().uuid(),
            keepKeys: f.bool().optional(),
            statusMap: z.record(z.string().max(320), z.string().max(40)).optional(),
            userMap: z.record(z.string().max(320), z.string().uuid()).optional(),
          })
          .strict()
          .optional(),
      }) as z.ZodObject<z.ZodRawShape>
    ).refine(
      (value: Record<string, unknown>) =>
        !PROJECT_TARGETED_KINDS.has(String(value['sourceKind'] ?? '')) ||
        value['options'] !== undefined,
      { message: 'This source kind also needs options with a projectId' },
    ),
    redact: 'standard',
    examples: [
      {
        summary: 'Commit 1 project row',
        args: {
          jobId: '01a20864-92a3-7a1c-b107-397ebef031dc',
          sourceKind: 'project',
          mapping: { name: 'Project name' },
          rows: [{ 'Project name': 'Website relaunch' }],
        },
      },
    ],
  }),
];
