/**
 * AI action details — home (my day, summary, pulse, waiting-on, pins, quick links,
 * recent items, saved context, widget prefs).
 *
 * Slice S2 (registry wave A). These are the signed-in member's own dashboard: pins,
 * quick links, saved context, recent items and widget prefs are user config
 * (`config` profile); the rest are `standard`. `:orgSlug` is never an argument.
 */
import { z } from 'zod';
import { det, queryArgs, pathOnly, bodyArgs, f, type AiActionDetail } from './detail.js';

// = common/database/schema.ts:HOME_PIN_TARGET_KINDS
const pinTargetKind = z.enum(['work', 'project', 'document']);
// = common/database/schema.ts:RECENT_ITEM_OBJECT_TYPES
const recentObjectType = z.enum(['work', 'project', 'document', 'meeting']);
// = common/database/schema.ts:SAVED_CONTEXT_ENTITY_TYPES
const savedContextEntityType = z.enum(['message', 'doc', 'work', 'file']);
// = common/database/schema.ts:HOME_WIDGET_IDS
const homeWidgetId = z.enum([
  'myDay',
  'waiting',
  'pulse',
  'summary',
  'pins',
  'savedContext',
  'businessBriefing',
  'next',
  'byProject',
  'timer',
  'gettingStarted',
  'quickQuestion',
  'recent',
]);

export const homeDetails: readonly AiActionDetail[] = [
  det({
    id: 'home.my_day.list',
    title: 'List home my day',
    description: 'List home my day.',
    input: queryArgs(),
    redact: 'standard',
    examples: [{ summary: 'List home my day', args: {} }],
  }),
  det({
    id: 'home.pins.create',
    title: 'Pin to Home',
    description: 'Pin a work item, project or document to your Home.',
    input: bodyArgs([], { targetKind: pinTargetKind, targetId: f.id() }),
    redact: 'config',
    examples: [
      {
        summary: 'Pin a project',
        args: { targetKind: 'project', targetId: '01a20864-92a3-7a1c-b107-397ebef031dc' },
      },
    ],
  }),
  det({
    id: 'home.pins.delete',
    title: 'Delete home pins',
    description: 'Delete home pins. Confirm-class: needs your approval before it runs.',
    input: pathOnly('pinId'),
    redact: 'config',
    examples: [{ summary: 'Delete home pins', args: { pinId: 'pin_1' } }],
  }),
  det({
    id: 'home.pins.list',
    title: 'List home pins',
    description: 'List home pins.',
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'List home pins', args: {} }],
  }),
  det({
    id: 'home.pulse.list',
    title: 'List home pulse',
    description: 'List home pulse.',
    input: queryArgs(),
    redact: 'standard',
    examples: [{ summary: 'List home pulse', args: {} }],
  }),
  det({
    id: 'home.quick_links.create',
    title: 'Create home quick links',
    description: 'Create home quick links.',
    input: bodyArgs([], { label: f.shortText(), path: f.shortText(1000) }),
    redact: 'config',
    examples: [{ summary: 'Create home quick links', args: { label: 'Docs', path: '/docs' } }],
  }),
  det({
    id: 'home.quick_links.delete',
    title: 'Delete home quick links',
    description: 'Delete home quick links. Confirm-class: needs your approval before it runs.',
    input: pathOnly('linkId'),
    redact: 'config',
    examples: [{ summary: 'Delete home quick links', args: { linkId: 'lnk_1' } }],
  }),
  det({
    id: 'home.quick_links.list',
    title: 'List home quick links',
    description: 'List home quick links.',
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'List home quick links', args: {} }],
  }),
  det({
    id: 'home.quick_links.order.set',
    title: 'Set home quick links order',
    description: 'Set home quick links order.',
    input: bodyArgs([], { ids: z.array(f.id()).max(500) }),
    redact: 'config',
    examples: [{ summary: 'Set home quick links order', args: { ids: ['ql_1', 'ql_2'] } }],
  }),
  det({
    id: 'home.recent_items.list',
    title: 'List home recent items',
    description: 'List home recent items.',
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'List home recent items', args: {} }],
  }),
  det({
    id: 'home.recent_items.set',
    title: 'Record a recently viewed item',
    description: 'Add a work item, project, document or meeting to your recently viewed list.',
    input: bodyArgs([], { objectType: recentObjectType, objectId: f.id() }),
    redact: 'config',
    examples: [
      {
        summary: 'Viewed a meeting',
        args: { objectType: 'meeting', objectId: '01a20864-92a3-7a1c-b107-397ebef031dc' },
      },
    ],
  }),
  det({
    id: 'home.saved_context.create',
    title: 'Save an item to Home',
    description: 'Save a message, doc, work item or file of a project to your Home saved items.',
    input: bodyArgs([], {
      entityType: savedContextEntityType,
      entityId: f.id(),
      projectId: f.id(),
    }),
    redact: 'config',
    examples: [
      {
        summary: 'Save a doc',
        args: {
          entityType: 'doc',
          entityId: '01a20864-92a3-7a1c-b107-397ebef031dc',
          projectId: '01a20864-92a3-7a1c-b107-397ebef031dd',
        },
      },
    ],
  }),
  det({
    id: 'home.saved_context.delete',
    title: 'Delete home saved context',
    description: 'Delete home saved context. Confirm-class: needs your approval before it runs.',
    input: pathOnly('savedContextId'),
    redact: 'config',
    examples: [{ summary: 'Delete home saved context', args: { savedContextId: 'ctx_1' } }],
  }),
  det({
    id: 'home.saved_context.list',
    title: 'List home saved context',
    description:
      "List the caller's saved items by project, each with its name where the caller may read the source.",
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'List home saved context', args: {} }],
  }),
  det({
    id: 'home.briefing.get',
    title: 'Get home business briefing',
    description:
      'Get what needs the reader across the company or their projects, from the hourly check.',
    input: queryArgs(),
    redact: 'billing',
    examples: [{ summary: 'Get home business briefing', args: {} }],
  }),
  det({
    id: 'home.briefing.signals.get',
    title: 'Get one alert',
    description:
      'One open alert of the hourly check: its rule, the figures it measured against the ' +
      "threshold, the reason in words, the record it is about and that record's link. Use it to " +
      'explain an alert; never guess figures it does not give.',
    input: pathOnly('signalId'),
    redact: 'billing',
    examples: [
      {
        summary: 'Explain this alert',
        args: { signalId: '0190a000-0000-7000-8000-000000000001' },
      },
    ],
  }),
  det({
    id: 'home.summary.list',
    title: 'List home summary',
    description: 'List home summary.',
    input: queryArgs(),
    redact: 'standard',
    examples: [{ summary: 'List home summary', args: {} }],
  }),
  det({
    id: 'home.waiting.list',
    title: 'List home waiting',
    description: 'List home waiting.',
    input: queryArgs(),
    redact: 'standard',
    examples: [{ summary: 'List home waiting', args: {} }],
  }),
  det({
    id: 'home.widget_prefs.list',
    title: 'List home widget prefs',
    description: 'List home widget prefs.',
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'List home widget prefs', args: {} }],
  }),
  det({
    id: 'home.widget_prefs.set',
    title: 'Set home widget prefs',
    description: 'Save the order of your Home widgets and which ones are hidden (widget ids).',
    input: bodyArgs([], {
      order: z.array(homeWidgetId).max(homeWidgetId.options.length),
      hidden: z.array(homeWidgetId).max(homeWidgetId.options.length),
    }),
    redact: 'config',
    examples: [
      { summary: 'Set home widget prefs', args: { order: ['next', 'pulse'], hidden: ['timer'] } },
    ],
  }),
];
