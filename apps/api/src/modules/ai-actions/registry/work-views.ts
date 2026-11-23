/**
 * AI action details — work views (calendar, timeline, workload, saved views).
 *
 * Slice S2 (registry wave A). Read-only cross-cuts of work plus the member's own saved
 * views (`config` profile). `:orgSlug` is never an argument (architecture B3/T-TEN-01).
 */
import { z } from 'zod';
import { det, queryArgs, pathOnly, listArgs, bodyArgs, f, type AiActionDetail } from './detail.js';

/** A calendar day, `YYYY-MM-DD` (the work-view routes refuse an instant or a bare month). */
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('A date, YYYY-MM-DD');

/**
 * A saved view's `config` = work-views/work-views.controller.ts:parseConfig (filters and columns
 * required, each entry at most 100, strings at most 300).
 */
const savedViewConfig = z
  .object({
    filters: z
      .array(z.object({ field: z.string().max(300), value: z.string().max(300) }).strict())
      .max(100),
    grouping: z.string().max(300).nullable().optional(),
    columns: z.array(z.string().max(300)).max(100),
  })
  .strict();

const savedViewBody = {
  name: f.shortText(300),
  projectId: f.id().nullable().optional().describe('Absent or null = an org-wide view'),
  config: savedViewConfig,
  shared: f.bool().optional().describe('Default false'),
};

const savedViewExample = {
  name: 'Open design work',
  projectId: 'proj_1',
  config: {
    filters: [{ field: 'state', value: 'in_progress' }],
    grouping: 'owner',
    columns: ['title', 'owner', 'dueAt'],
  },
};

export const workViewsDetails: readonly AiActionDetail[] = [
  // R21-a · 53-08: the org-wide workload grid (people × weeks).
  det({
    id: 'work_views.workload_org.get',
    title: 'Get the organization workload',
    description:
      'Get planned hours per person per week across the organization (from..to, at most 26 weeks; 50 people a page); work you cannot read shows as one total.',
    // = work-views/org-workload-rules.ts (parseScope, parsePage) and people/workload-hours.ts:weekBuckets.
    input: listArgs(
      [],
      {
        from: dateOnly,
        to: dateOnly.describe('A date, YYYY-MM-DD; at most 26 weeks after from'),
        scope: z
          .union([
            z.literal('org'),
            z
              .string()
              .regex(/^project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
          ])
          .optional()
          .describe('org (default) or project:<project id>'),
      },
      { limit: false },
    ),
    redact: 'standard',
    examples: [
      {
        summary: 'Get the organization workload for November',
        args: { from: '2026-11-02', to: '2026-11-29' },
      },
      {
        summary: 'Get the workload of one project',
        args: {
          from: '2026-11-02',
          to: '2026-11-29',
          scope: 'project:01a20864-92a3-7a1c-b107-397ebef031dc',
        },
      },
    ],
  }),
  det({
    id: 'work_views.calendar.get',
    title: 'Get work view calendar',
    description:
      "A project's open work items by day between from and to (both included, at most 366 days).",
    input: queryArgs(['projectId'], { from: dateOnly, to: dateOnly }),
    redact: 'standard',
    examples: [
      {
        summary: 'Get the November calendar',
        args: { projectId: 'proj_1', from: '2026-11-01', to: '2026-11-30' },
      },
    ],
  }),
  det({
    id: 'work_views.saved.create',
    title: 'Create work view saved',
    description:
      'Save a work view: a name, its filters, grouping and columns, for one project or the whole organization; shared makes it visible to the studio.',
    input: bodyArgs([], savedViewBody),
    redact: 'config',
    examples: [{ summary: 'Save a view of open design work', args: savedViewExample }],
  }),
  det({
    id: 'work_views.saved.list',
    title: 'List work view saved',
    description: 'List work view saved.',
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'List work view saved', args: {} }],
  }),
  det({
    id: 'work_views.saved.set',
    title: 'Set work view saved',
    description:
      'Replace a saved view you own: send the whole view again (name and config are required; an absent projectId makes it org-wide).',
    input: bodyArgs(['savedViewId'], savedViewBody),
    redact: 'config',
    examples: [
      {
        summary: 'Replace a saved view',
        args: { savedViewId: 'view_1', ...savedViewExample },
      },
    ],
  }),
  det({
    id: 'work_views.timeline.get',
    title: 'Get work view timeline',
    description: 'Get work view timeline.',
    input: pathOnly('projectId'),
    redact: 'standard',
    examples: [{ summary: 'Get work view timeline', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'work_views.workload.get',
    title: 'Get work view workload',
    description: 'Get work view workload.',
    input: pathOnly('projectId'),
    redact: 'standard',
    examples: [{ summary: 'Get work view workload', args: { projectId: 'proj_1' } }],
  }),
];
