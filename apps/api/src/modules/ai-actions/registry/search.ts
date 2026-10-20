/**
 * AI action details — search (global search, suggestions, commands, history, pins,
 * saved searches, scopes, shares).
 *
 * Slice S2 (registry wave A). Results reflect only what the caller may see; saved
 * searches, scopes, pins and history are user config (`config` profile). Query text is
 * untrusted. `:orgSlug` is never an argument (architecture B3/T-TEN-01).
 */
import { z } from 'zod';
import { det, noArgs, pathOnly, listArgs, bodyArgs, f, type AiActionDetail } from './detail.js';

export const searchDetails: readonly AiActionDetail[] = [
  det({
    id: 'search.commands.list',
    title: 'List search commands',
    description: 'List search commands.',
    input: listArgs([], { q: f.shortText(200).optional() }),
    redact: 'config',
    examples: [{ summary: 'List search commands', args: {} }],
  }),
  det({
    id: 'search.history.create',
    title: 'Create search history',
    description: 'Create search history.',
    input: bodyArgs([], { query: f.text().optional() }),
    redact: 'config',
    examples: [{ summary: 'Create search history', args: { query: 'overdue tasks' } }],
  }),
  det({
    id: 'search.history.delete',
    title: 'Delete search history',
    description: 'Delete search history. Confirm-class: needs your approval before it runs.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Delete search history', args: {} }],
  }),
  det({
    id: 'search.history.list',
    title: 'List search history',
    description: 'List search history.',
    input: listArgs(),
    redact: 'config',
    examples: [{ summary: 'List search history', args: {} }],
  }),
  det({
    id: 'search.list',
    title: 'List search',
    description: 'List search.',
    input: listArgs([], {
      q: f.shortText(200).optional(),
      projectId: f.id().optional(),
      audience: z.enum(['internal', 'client_visible', 'client_action_required']).optional(),
      since: f.iso().optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'List search', args: {} }],
  }),
  det({
    id: 'search.pins.delete',
    title: 'Delete search pins',
    description: 'Delete search pins. Confirm-class: needs your approval before it runs.',
    input: pathOnly('pinId'),
    redact: 'config',
    examples: [{ summary: 'Delete search pins', args: { pinId: 'pin_1' } }],
  }),
  det({
    id: 'search.pins.list',
    title: 'List search pins',
    description: 'List search pins.',
    input: listArgs(),
    redact: 'config',
    examples: [{ summary: 'List search pins', args: {} }],
  }),
  det({
    id: 'search.pins.set',
    title: 'Set search pins',
    description: 'Set search pins.',
    input: bodyArgs([], {
      objectType: f.shortText().optional(),
      objectId: f.id().optional(),
      label: f.shortText().optional(),
    }),
    redact: 'config',
    examples: [{ summary: 'Set search pins', args: { label: 'In review' } }],
  }),
  det({
    id: 'search.recent.list',
    title: 'List search recent',
    description: 'List search recent.',
    input: listArgs(),
    redact: 'standard',
    examples: [{ summary: 'List search recent', args: {} }],
  }),
  det({
    id: 'search.saved.create',
    title: 'Create search saved',
    description: 'Create search saved.',
    input: bodyArgs([], {
      name: f.shortText().optional(),
      query: f.text().optional(),
      filters: f.config().optional(),
    }),
    redact: 'config',
    examples: [
      { summary: 'Create search saved', args: { name: 'Design review', query: 'overdue tasks' } },
    ],
  }),
  det({
    id: 'search.saved.delete',
    title: 'Delete search saved',
    description: 'Delete search saved. Confirm-class: needs your approval before it runs.',
    input: pathOnly('savedSearchId'),
    redact: 'config',
    examples: [{ summary: 'Delete search saved', args: { savedSearchId: 'ss_1' } }],
  }),
  det({
    id: 'search.saved.list',
    title: 'List search saved',
    description: 'List search saved.',
    input: listArgs(),
    redact: 'config',
    examples: [{ summary: 'List search saved', args: {} }],
  }),
  det({
    id: 'search.saved.share.delete',
    title: 'Delete search saved share',
    description: 'Delete search saved share. Confirm-class: needs your approval before it runs.',
    input: pathOnly('savedSearchId'),
    redact: 'config',
    examples: [{ summary: 'Delete search saved share', args: { savedSearchId: 'ss_1' } }],
  }),
  det({
    id: 'search.saved.share.set',
    title: 'Set search saved share',
    description: 'Set search saved share. Confirm-class: needs your approval before it runs.',
    input: bodyArgs(['savedSearchId'], {}),
    redact: 'config',
    examples: [{ summary: 'Set search saved share', args: { savedSearchId: 'ss_1' } }],
  }),
  det({
    id: 'search.scopes.create',
    title: 'Create search scopes',
    description: 'Create search scopes.',
    input: bodyArgs([], { name: f.shortText().optional(), filters: f.config().optional() }),
    redact: 'config',
    examples: [{ summary: 'Create search scopes', args: { name: 'Design review' } }],
  }),
  det({
    id: 'search.scopes.delete',
    title: 'Delete search scopes',
    description: 'Delete search scopes. Confirm-class: needs your approval before it runs.',
    input: pathOnly('scopeId'),
    redact: 'config',
    examples: [{ summary: 'Delete search scopes', args: { scopeId: 'scope_1' } }],
  }),
  det({
    id: 'search.scopes.list',
    title: 'List search scopes',
    description: 'List search scopes.',
    input: listArgs(),
    redact: 'config',
    examples: [{ summary: 'List search scopes', args: {} }],
  }),
  det({
    id: 'search.scopes.set',
    title: 'Set search scopes',
    description: 'Set search scopes.',
    input: bodyArgs(['scopeId'], {
      name: f.shortText().optional(),
      filters: f.config().optional(),
    }),
    redact: 'config',
    examples: [
      { summary: 'Set search scopes', args: { scopeId: 'scope_1', name: 'Design review' } },
    ],
  }),
  det({
    id: 'search.shared.list',
    title: 'List search shared',
    description: 'List search shared.',
    input: listArgs(),
    redact: 'standard',
    examples: [{ summary: 'List search shared', args: {} }],
  }),
  det({
    id: 'search.suggest.list',
    title: 'List search suggest',
    description: 'List search suggest.',
    input: listArgs([], { q: f.shortText(200).optional() }),
    redact: 'standard',
    examples: [{ summary: 'List search suggest', args: {} }],
  }),
];
