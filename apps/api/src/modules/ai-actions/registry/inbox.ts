/**
 * AI action details — inbox (items, flags, snooze, read, saved filters, rules,
 * source mutes).
 *
 * Slice S2 (registry wave A). The caller's own notification inbox. Saved filters,
 * rules, mutes, flags and snoozes are user config (`config` profile); the feed itself
 * is `standard`. `:orgSlug` is never an argument (architecture B3/T-TEN-01).
 */
import { z } from 'zod';
import { INBOX_RULE_CATEGORIES, INBOX_RULE_MATCH_TYPES } from '../../../common/database/schema.js';
import {
  det,
  queryArgs,
  noArgs,
  pathOnly,
  listArgs,
  bodyArgs,
  f,
  type AiActionDetail,
} from './detail.js';

export const inboxDetails: readonly AiActionDetail[] = [
  det({
    id: 'inbox.flag.delete',
    title: 'Delete inbox flag',
    description: 'Delete inbox flag. Confirm-class: needs your approval before it runs.',
    input: pathOnly('bundleId'),
    redact: 'standard',
    examples: [{ summary: 'Delete inbox flag', args: { bundleId: 'bun_1' } }],
  }),
  det({
    id: 'inbox.flag.set',
    title: 'Set inbox flag',
    description: 'Set inbox flag.',
    input: bodyArgs(['bundleId'], {}),
    redact: 'standard',
    examples: [{ summary: 'Set inbox flag', args: { bundleId: 'bun_1' } }],
  }),
  det({
    id: 'inbox.flagged.list',
    title: 'List inbox flagged',
    description: 'List inbox flagged.',
    input: queryArgs(),
    redact: 'standard',
    examples: [{ summary: 'List inbox flagged', args: {} }],
  }),
  det({
    id: 'inbox.list',
    title: 'List inbox',
    description: 'List inbox.',
    input: listArgs([], { mode: f.shortText(200).optional() }, { cursor: 'before' }),
    redact: 'standard',
    examples: [{ summary: 'List inbox', args: {} }],
  }),
  det({
    id: 'inbox.read.create',
    title: 'Mark read inbox',
    description: 'Mark read inbox.',
    input: bodyArgs(['bundleId'], {}),
    redact: 'standard',
    examples: [{ summary: 'Mark read inbox', args: { bundleId: 'bun_1' } }],
  }),
  det({
    id: 'inbox.rules.create',
    title: 'Create inbox rules',
    description: 'Create inbox rules.',
    // AI tamper review 2026-11-23: strict, mirroring `inbox/rules.controller.ts` parseInput (it was
    // a passthrough, the one op whose arguments the registry did not check).
    input: bodyArgs([], {
      matchType: z.enum(INBOX_RULE_MATCH_TYPES),
      matchValue: f.shortText(190),
      category: z.enum(INBOX_RULE_CATEGORIES),
      position: f.int(0, 10_000).optional(),
    }),
    redact: 'config',
    examples: [
      {
        summary: 'Create inbox rules',
        args: { matchType: 'type', matchValue: 'mention', category: 'urgent' },
      },
    ],
  }),
  det({
    id: 'inbox.rules.delete',
    title: 'Delete an inbox rule',
    description:
      'Delete one inbox rule by its id. Confirm-class: needs your approval before it runs.',
    input: bodyArgs([], { id: z.string().uuid() }),
    redact: 'config',
    examples: [
      { summary: 'Delete one rule', args: { id: '01a20864-92a3-7a1c-b107-397ebef031dc' } },
    ],
  }),
  det({
    id: 'inbox.rules.list',
    title: 'List inbox rules',
    description: 'List inbox rules.',
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'List inbox rules', args: {} }],
  }),
  det({
    id: 'inbox.rules.resolve.list',
    title: 'List inbox rules resolve',
    description: 'List inbox rules resolve.',
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'List inbox rules resolve', args: {} }],
  }),
  det({
    id: 'inbox.saved_filters.create',
    title: 'Save an inbox filter',
    description:
      'Save the current inbox filter under a name. filter is the inbox screen’s own serialized facet set (a string), saved as given.',
    input: bodyArgs([], { name: f.shortText(200), filter: z.string().max(4000) }),
    redact: 'config',
    examples: [
      {
        summary: 'Unread mentions',
        args: { name: 'Unread mentions', filter: '{"unread":true,"kind":"mention"}' },
      },
    ],
  }),
  det({
    id: 'inbox.saved_filters.delete',
    title: 'Delete inbox saved filters',
    description: 'Delete inbox saved filters. Confirm-class: needs your approval before it runs.',
    input: pathOnly('savedFilterId'),
    redact: 'config',
    examples: [{ summary: 'Delete inbox saved filters', args: { savedFilterId: 'sf_1' } }],
  }),
  det({
    id: 'inbox.saved_filters.list',
    title: 'List inbox saved filters',
    description: 'List inbox saved filters.',
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'List inbox saved filters', args: {} }],
  }),
  det({
    id: 'inbox.snooze.delete',
    title: 'Delete inbox snooze',
    description: 'Delete inbox snooze. Confirm-class: needs your approval before it runs.',
    input: pathOnly('bundleId'),
    redact: 'standard',
    examples: [{ summary: 'Delete inbox snooze', args: { bundleId: 'bun_1' } }],
  }),
  det({
    id: 'inbox.done.set',
    title: 'Mark inbox bundle done',
    description: 'Mark an inbox bundle done; it leaves the active inbox until un-snoozed.',
    input: bodyArgs(['bundleId'], {}),
    redact: 'standard',
    examples: [{ summary: 'Mark an inbox bundle done', args: { bundleId: 'bun_1' } }],
  }),
  det({
    id: 'inbox.snooze.set',
    title: 'Set inbox snooze',
    description: 'Set inbox snooze.',
    input: bodyArgs(['bundleId'], { until: f.iso().optional() }),
    redact: 'standard',
    examples: [{ summary: 'Set inbox snooze', args: { bundleId: 'bun_1' } }],
  }),
  det({
    id: 'inbox.snoozed.list',
    title: 'List inbox snoozed',
    description: 'List inbox snoozed.',
    input: queryArgs(),
    redact: 'standard',
    examples: [{ summary: 'List inbox snoozed', args: {} }],
  }),
  det({
    id: 'inbox.source_mutes.delete',
    title: 'Delete inbox source mutes',
    description: 'Delete inbox source mutes. Confirm-class: needs your approval before it runs.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Delete inbox source mutes', args: {} }],
  }),
  det({
    id: 'inbox.source_mutes.list',
    title: 'List inbox source mutes',
    description: 'List inbox source mutes.',
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'List inbox source mutes', args: {} }],
  }),
  det({
    id: 'inbox.source_mutes.set',
    title: 'Set inbox source mutes',
    description: 'Set inbox source mutes.',
    input: bodyArgs([], { objectType: f.shortText().optional(), objectId: f.id().optional() }),
    redact: 'config',
    examples: [{ summary: 'Set inbox source mutes', args: {} }],
  }),
];
