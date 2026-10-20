/**
 * AI action details — work views (calendar, timeline, workload, saved views).
 *
 * Slice S2 (registry wave A). Read-only cross-cuts of work plus the member's own saved
 * views (`config` profile). `:orgSlug` is never an argument (architecture B3/T-TEN-01).
 */
import { det, pathOnly, listArgs, bodyArgs, f, type AiActionDetail } from './detail.js';

export const workViewsDetails: readonly AiActionDetail[] = [
  det({
    id: 'work_views.calendar.get',
    title: 'Get work view calendar',
    description: 'Get work view calendar.',
    input: listArgs(['projectId'], { from: f.iso().optional(), to: f.iso().optional() }),
    redact: 'standard',
    examples: [{ summary: 'Get work view calendar', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'work_views.saved.create',
    title: 'Create work view saved',
    description: 'Create work view saved.',
    input: bodyArgs([], {
      name: f.shortText().optional(),
      projectId: f.id().optional(),
      config: f.config().optional(),
      shared: f.bool().optional(),
    }),
    redact: 'config',
    examples: [
      { summary: 'Create work view saved', args: { name: 'Design review', projectId: 'proj_1' } },
    ],
  }),
  det({
    id: 'work_views.saved.list',
    title: 'List work view saved',
    description: 'List work view saved.',
    input: listArgs(),
    redact: 'config',
    examples: [{ summary: 'List work view saved', args: {} }],
  }),
  det({
    id: 'work_views.saved.set',
    title: 'Set work view saved',
    description: 'Set work view saved.',
    input: bodyArgs(['savedViewId'], {
      name: f.shortText().optional(),
      projectId: f.id().optional(),
      config: f.config().optional(),
      shared: f.bool().optional(),
    }),
    redact: 'config',
    examples: [
      {
        summary: 'Set work view saved',
        args: { savedViewId: 'view_1', name: 'Design review', projectId: 'proj_1' },
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
