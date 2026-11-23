/**
 * AI action details — insights (analytics, reports, targets, snapshots).
 *
 * Slice S4 (registry wave C). Reads are plain reads; creating/saving reports, views, layouts,
 * alerts, targets and snapshots are ordinary writes within the member's rights; deletes are
 * confirm-class. Report/view/layout bodies are arbitrary analytics config, so they use the bounded
 * `config` schema; those results carry the `config` redaction profile (no secrets).
 */
import { SIGNAL_RECIPIENTS, SIGNAL_RULE_KEYS } from '@tmanage/domain';
import { z } from 'zod';
import { COMPARISON_METRICS } from '../../insights/comparison.service.js';
import {
  MAX_FORECAST_WEEKS,
  MIN_FORECAST_WEEKS,
} from '../../insights/workload-forecast.service.js';
import {
  neededWhen,
  det,
  queryArgs,
  listArgs,
  pathOnly,
  bodyArgs,
  noArgs,
  f,
  type AiActionDetail,
} from './detail.js';

// = common/database/schema.ts:INSIGHT_CUSTOM_REPORT_METRICS
const customReportMetric = z.enum([
  'open_items',
  'scheduled_items',
  'active_projects',
  'active_assignees',
]);
// = common/database/schema.ts:INSIGHT_CUSTOM_REPORT_LAYOUTS
const customReportLayout = z.enum(['list', 'grid']);
// = common/database/schema.ts:INSIGHT_METRIC_KEYS (dashboard tiles)
const dashboardMetric = z.enum([
  'portfolio',
  'deliveryFlow',
  'approvalCycle',
  'workload',
  'workloadForecast',
  'adoption',
  'snapshots',
  'savedViews',
]);
// = common/database/schema.ts:INSIGHT_FAVORITE_METRIC_KEYS
const favoriteMetric = z.enum([
  'portfolio.projectCount',
  'portfolio.openItemCount',
  'deliveryFlow.itemCount',
  'approvalCycle.approvalCount',
  'workload.assigneeCount',
  'workload.openItemCount',
  'workload.scheduledItemCount',
  'adoption.activeMembers',
]);
// = common/database/schema.ts:INSIGHT_REPORT_KINDS (report schedules and saved views)
const reportKind = z.enum([
  'portfolio',
  'delivery-flow',
  'approval-cycle',
  'workload',
  'adoption',
  'forecast',
]);
// = common/database/schema.ts:INSIGHT_REPORT_CADENCES
const reportCadence = z.enum(['daily', 'weekly']);
// = common/database/schema.ts:INSIGHT_SNAPSHOT_KINDS
const snapshotKind = z.enum(['portfolio', 'workload']);
/** = insights/comparison.service.ts:parseWindow, `start..end`, two ISO instants, start before end. */
const comparisonWindow = () =>
  z
    .string()
    .min(3)
    .max(90)
    .describe('A window as two ISO instants joined by "..", start before end');

export const insightsDetails: readonly AiActionDetail[] = [
  det({
    id: 'insights.adoption.list',
    title: 'Adoption metrics',
    description: 'How the workspace is adopting the product over the last days (default 30).',
    input: queryArgs([], {
      days: f.int(1, 90).optional().describe('Window in days, 1 to 90 (default 30)'),
    }),
    redact: 'standard',
    examples: [
      { summary: 'Read', args: {} },
      { summary: 'Last week', args: { days: 7 } },
    ],
  }),
  det({
    id: 'insights.compare.list',
    title: 'Compare metrics',
    description:
      'Compare one metric between two windows (periodA and periodB, each "start..end" as ISO instants).',
    input: queryArgs([], {
      metric: z.enum(COMPARISON_METRICS),
      periodA: comparisonWindow(),
      periodB: comparisonWindow(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'October vs September',
        args: {
          metric: 'work_items_created',
          periodA: '2026-09-01T00:00:00Z..2026-10-01T00:00:00Z',
          periodB: '2026-10-01T00:00:00Z..2026-11-01T00:00:00Z',
        },
      },
    ],
  }),
  det({
    id: 'insights.portfolio.list',
    title: 'Portfolio overview',
    description: 'Portfolio-level delivery metrics, optionally only for some projects.',
    input: listArgs(
      [],
      {
        projectIds: f
          .shortText(3_300)
          .optional()
          .describe('Only these projects: project ids separated by commas (at most 50)'),
      },
      { cursor: 'after' },
    ),
    redact: 'standard',
    examples: [{ summary: 'Read', args: {} }],
  }),
  det({
    id: 'insights.workload.list',
    title: 'Workload',
    description: 'Current workload across people and teams.',
    input: listArgs([], {}, { cursor: null }),
    redact: 'standard',
    examples: [{ summary: 'Read', args: {} }],
  }),
  det({
    id: 'insights.workload_forecast.list',
    title: 'Workload forecast',
    description: 'Projected workload for the coming weeks (default 4).',
    input: queryArgs([], {
      weeks: f
        .int(MIN_FORECAST_WEEKS, MAX_FORECAST_WEEKS)
        .optional()
        .describe(`Weeks ahead, ${MIN_FORECAST_WEEKS} to ${MAX_FORECAST_WEEKS} (default 4)`),
    }),
    redact: 'standard',
    examples: [
      { summary: 'Read', args: {} },
      { summary: 'Next 8 weeks', args: { weeks: 8 } },
    ],
  }),
  // R31 A14: workload in hours, and the owner/admin weekly-capacity write.
  det({
    id: 'insights.workload_hours.get',
    title: 'Workload in hours',
    description: 'Planned hours against weekly capacity per person.',
    input: queryArgs(),
    redact: 'standard',
    examples: [{ summary: 'Read', args: {} }],
  }),
  det({
    id: 'insights.workload_hours.capacity.set',
    title: "Set a person's weekly capacity",
    description: 'Set the weekly working hours for one member (owner and org admin only).',
    input: bodyArgs(['membershipId'], { weeklyHours: f.int(0, 168) }),
    redact: 'standard',
    examples: [{ summary: '32h/week', args: { membershipId: 'm_1', weeklyHours: 32 } }],
  }),
  det({
    id: 'insights.workload.export_csv',
    title: 'Export workload as CSV',
    description:
      'Download the workload report as CSV. A bulk extraction (results are capped and redacted).',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Export', args: {} }],
  }),
  det({
    id: 'insights.projects.approval_cycle.list',
    title: 'Project approval cycle',
    description: 'Approval cycle-time metrics for a project.',
    input: queryArgs(['projectId']),
    redact: 'standard',
    examples: [{ summary: 'By project', args: { projectId: 'p_1' } }],
  }),
  det({
    id: 'insights.projects.delivery_flow.list',
    title: 'Project delivery flow',
    description: 'Delivery-flow metrics for a project.',
    input: queryArgs(['projectId']),
    redact: 'standard',
    examples: [{ summary: 'By project', args: { projectId: 'p_1' } }],
  }),
  // custom reports
  det({
    id: 'insights.custom_reports.list',
    title: 'List custom reports',
    description: 'Saved custom analytics reports.',
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'All', args: {} }],
  }),
  det({
    id: 'insights.custom_reports.get',
    title: 'Get a custom report',
    description: 'One custom report definition and its data.',
    input: pathOnly('reportId'),
    redact: 'config',
    examples: [{ summary: 'By id', args: { reportId: 'r_1' } }],
  }),
  det({
    id: 'insights.custom_reports.create',
    title: 'Create a custom report',
    description: 'Save a new custom analytics report: a name, the metrics to show and a layout.',
    input: bodyArgs([], {
      name: f.shortText(300),
      metricKeys: z.array(customReportMetric).min(1).max(20),
      layout: customReportLayout,
    }),
    redact: 'config',
    examples: [
      {
        summary: 'New',
        args: { name: 'Weekly throughput', metricKeys: ['open_items'], layout: 'list' },
      },
    ],
  }),
  det({
    id: 'insights.custom_reports.set',
    title: 'Update a custom report',
    description: 'Overwrite a custom report whole: its name, metrics and layout.',
    input: bodyArgs(['reportId'], {
      name: f.shortText(300),
      metricKeys: z.array(customReportMetric).min(1).max(20),
      layout: customReportLayout,
    }),
    redact: 'config',
    examples: [
      {
        summary: 'Update',
        args: {
          reportId: 'r_1',
          name: 'Weekly throughput',
          metricKeys: ['open_items', 'active_projects'],
          layout: 'grid',
        },
      },
    ],
  }),
  det({
    id: 'insights.custom_reports.delete',
    title: 'Delete a custom report',
    description: 'Remove a custom report. Confirm-class.',
    input: pathOnly('reportId'),
    redact: 'config',
    examples: [{ summary: 'Remove', args: { reportId: 'r_1' } }],
  }),
  // dashboard layout
  det({
    id: 'insights.dashboard_layout.list',
    title: 'Dashboard layout',
    description: 'The saved insights dashboard layout.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Read', args: {} }],
  }),
  det({
    id: 'insights.dashboard_layout.set',
    title: 'Set dashboard layout',
    description:
      'Save the insights dashboard layout: the tiles, each a metric key with its position and whether it is shown.',
    input: bodyArgs([], {
      tiles: z
        .array(
          z
            .object({
              key: dashboardMetric,
              position: f.int(0, 1000),
              visible: f.bool(),
            })
            .strict(),
        )
        .max(dashboardMetric.options.length),
    }),
    redact: 'config',
    examples: [
      {
        summary: 'Save',
        args: {
          tiles: [
            { key: 'portfolio', position: 0, visible: true },
            { key: 'workload', position: 1, visible: true },
          ],
        },
      },
    ],
  }),
  // metric alerts
  det({
    id: 'insights.metric_alerts.list',
    title: 'List metric alerts',
    description: 'Alerts set on metrics.',
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'All', args: {} }],
  }),
  det({
    id: 'insights.metric_alerts.set',
    title: 'Set a metric alert',
    description: 'Create or update an alert on a metric.',
    input: bodyArgs([], {
      metricKey: f.shortText(80),
      comparator: f.shortText(8),
      threshold: f.int(-1_000_000, 1_000_000),
    }),
    redact: 'config',
    examples: [
      { summary: 'Alert', args: { metricKey: 'cycle_time', comparator: 'gt', threshold: 7 } },
    ],
  }),
  det({
    id: 'insights.metric_alerts.delete',
    title: 'Delete a metric alert',
    description: 'Remove a metric alert. Confirm-class.',
    input: pathOnly('metricKey'),
    redact: 'config',
    examples: [{ summary: 'Remove', args: { metricKey: 'cycle_time' } }],
  }),
  // metric favorites
  det({
    id: 'insights.metric_favorites.list',
    title: 'List favorite metrics',
    description: 'Metrics pinned as favorites.',
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'All', args: {} }],
  }),
  det({
    id: 'insights.metric_favorites.set',
    title: 'Pin a favorite metric',
    description: 'Pin a metric as a favorite.',
    input: bodyArgs([], { metricKey: favoriteMetric }),
    redact: 'config',
    examples: [{ summary: 'Pin', args: { metricKey: 'workload.openItemCount' } }],
  }),
  det({
    id: 'insights.metric_favorites.delete',
    title: 'Unpin a favorite metric',
    description: 'Remove a favorite metric. Confirm-class.',
    input: bodyArgs([], { metricKey: favoriteMetric }),
    redact: 'config',
    examples: [{ summary: 'Unpin', args: { metricKey: 'workload.openItemCount' } }],
  }),
  // report schedules
  det({
    id: 'insights.report_schedules.list',
    title: 'List report schedules',
    description: 'Scheduled recurring reports.',
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'All', args: {} }],
  }),
  det({
    id: 'insights.report_schedules.create',
    title: 'Create a report schedule',
    description:
      'Schedule a recurring report, daily or weekly at an hour of the day. A weekly schedule also ' +
      'needs dayOfWeek (0 = Sunday to 6); a daily one must leave it out.',
    input: neededWhen(
      bodyArgs([], {
        reportKey: reportKind,
        cadence: reportCadence,
        hour: f.int(0, 23).describe('Hour of the day, 0 to 23'),
        dayOfWeek: f.int(0, 6).nullable().optional().describe('Weekly only: 0 (Sunday) to 6'),
      }),
      'cadence',
      'weekly',
      ['dayOfWeek'],
    ),
    redact: 'config',
    examples: [
      { summary: 'Daily', args: { reportKey: 'portfolio', cadence: 'daily', hour: 7 } },
      {
        summary: 'Weekly',
        args: { reportKey: 'workload', cadence: 'weekly', hour: 8, dayOfWeek: 1 },
      },
    ],
  }),
  det({
    id: 'insights.report_schedules.delete',
    title: 'Delete a report schedule',
    description: 'Remove a report schedule. Confirm-class.',
    input: pathOnly('scheduleId'),
    redact: 'config',
    examples: [{ summary: 'Remove', args: { scheduleId: 's_1' } }],
  }),
  // saved views
  det({
    id: 'insights.saved_views.list',
    title: 'List saved views',
    description: 'Saved insights views.',
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'All', args: {} }],
  }),
  det({
    id: 'insights.saved_views.create',
    title: 'Create a saved view',
    description: 'Save an insights view: a name, the report it is for and its filters.',
    input: bodyArgs([], {
      name: f.shortText(300),
      reportKind,
      filters: z
        .record(z.string().max(120), z.string().max(500))
        .describe('Filter values by field name, all strings (may be empty)'),
    }),
    redact: 'config',
    examples: [{ summary: 'New', args: { name: 'My view', reportKind: 'workload', filters: {} } }],
  }),
  det({
    id: 'insights.saved_views.delete',
    title: 'Delete a saved view',
    description: 'Remove a saved view. Confirm-class.',
    input: pathOnly('viewId'),
    redact: 'config',
    examples: [{ summary: 'Remove', args: { viewId: 'v_1' } }],
  }),
  // snapshots
  det({
    id: 'insights.snapshots.list',
    title: 'List snapshots',
    description: 'Point-in-time insights snapshots of one kind, newest first.',
    input: listArgs([], { kind: snapshotKind }, { cursor: null }),
    redact: 'standard',
    examples: [{ summary: 'Portfolio', args: { kind: 'portfolio' } }],
  }),
  det({
    id: 'insights.snapshots.create',
    title: 'Create a snapshot',
    description: 'Capture a point-in-time insights snapshot.',
    input: bodyArgs([], { kind: snapshotKind }),
    redact: 'standard',
    examples: [{ summary: 'Capture', args: { kind: 'portfolio' } }],
  }),
  det({
    id: 'insights.snapshots.get',
    title: 'Get a snapshot',
    description: 'One snapshot by id.',
    input: pathOnly('snapshotId'),
    redact: 'standard',
    examples: [{ summary: 'By id', args: { snapshotId: 'sn_1' } }],
  }),
  det({
    id: 'insights.snapshots.annotations.list',
    title: 'Snapshot annotations',
    description: 'Annotations on a snapshot.',
    input: queryArgs(['snapshotId']),
    redact: 'standard',
    examples: [{ summary: 'By snapshot', args: { snapshotId: 'sn_1' } }],
  }),
  det({
    id: 'insights.snapshots.annotations.create',
    title: 'Annotate a snapshot',
    description: 'Add an annotation to a snapshot.',
    input: bodyArgs(['snapshotId'], { note: f.text(2000) }),
    redact: 'standard',
    examples: [{ summary: 'Note', args: { snapshotId: 'sn_1', note: 'Spike after launch.' } }],
  }),
  det({
    id: 'insights.snapshots.annotations.delete',
    title: 'Delete a snapshot annotation',
    description: 'Remove a snapshot annotation. Confirm-class.',
    input: pathOnly('snapshotId', 'annotationId'),
    redact: 'standard',
    examples: [{ summary: 'Remove', args: { snapshotId: 'sn_1', annotationId: 'a_1' } }],
  }),
  // targets
  det({
    id: 'insights.targets.list',
    title: 'List targets',
    description: 'Metric targets set for the workspace.',
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'All', args: {} }],
  }),
  det({
    id: 'insights.targets.set',
    title: 'Set a target',
    description: 'Set a target value for a metric and period.',
    input: bodyArgs([], {
      metric: f.shortText(80),
      period: f.shortText(20),
      targetValue: f.int(-1_000_000, 1_000_000),
    }),
    redact: 'config',
    examples: [
      { summary: 'Target', args: { metric: 'throughput', period: '2026-Q4', targetValue: 40 } },
    ],
  }),
  det({
    id: 'insights.targets.status',
    title: 'Target status',
    description: 'How current metrics compare to their targets.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Status', args: {} }],
  }),
  // 62-27 (B05): the owner's alert rules (Settings → Alerts), behind `business_briefing`; the
  // service admits the company owner only and lists the money rules only with `finance.view`.
  det({
    id: 'insights.signal_settings.get',
    title: 'List the alert rules',
    description:
      'The eight alert rules with, for each, whether it is on, its threshold and unit, and who ' +
      'is told. Company owner only.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'All rules', args: {} }],
  }),
  det({
    id: 'insights.signal_settings.set',
    title: 'Change alert rules',
    description:
      'Save the listed alert rules whole: on/off, threshold (within the rule limits) and who is ' +
      'told. Company owner only. Confirm-class: needs your approval before it runs.',
    input: bodyArgs([], {
      rules: z
        .array(
          z
            .object({
              rule: z.enum(SIGNAL_RULE_KEYS),
              enabled: f.bool(),
              threshold: f.int(1, 300),
              recipient: z.enum(SIGNAL_RECIPIENTS),
            })
            .strict(),
        )
        .min(1)
        .max(SIGNAL_RULE_KEYS.length),
    }),
    redact: 'config',
    examples: [
      {
        summary: 'Stale task after 10 days',
        args: {
          rules: [{ rule: 'stale_task', enabled: true, threshold: 10, recipient: 'project_lead' }],
        },
      },
    ],
  }),
];
