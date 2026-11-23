/**
 * AI action details — search (global search, suggestions, commands, history, pins,
 * saved searches, scopes, shares).
 *
 * Slice S2 (registry wave A). Results reflect only what the caller may see; saved
 * searches, scopes, pins and history are user config (`config` profile). Query text is
 * untrusted. `:orgSlug` is never an argument (architecture B3/T-TEN-01).
 */
import { z } from 'zod';
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
import { SEARCH_RESULT_KINDS } from '../../search/search.service.js';
import { SEARCH_PIN_OBJECT_TYPES } from '../../search/search-pins.service.js';
import {
  MAX_NAME_LENGTH as MAX_SCOPE_NAME_LENGTH,
  MAX_OBJECT_TYPES as MAX_SCOPE_OBJECT_TYPES,
  SCOPE_OBJECT_TYPES,
} from '../../search/saved-scopes.service.js';

/** = search.controller.ts AUDIENCES and TIME_WINDOWS (not exported). */
const SEARCH_AUDIENCES = ['internal', 'client_visible', 'client_action_required'] as const;
const SEARCH_TIME_WINDOWS = ['7d', '30d', 'all'] as const;

/** A comma-separated subset of `allowed`, as search.controller.ts `parseAudiences`/`parseKinds` read it. */
function commaSubset(allowed: readonly string[], what: string): z.ZodTypeAny {
  return z
    .string()
    .min(1)
    .max(300)
    .refine(
      (raw) => {
        const values = raw
          .split(',')
          .map((v) => v.trim())
          .filter((v) => v !== '');
        return values.length > 0 && values.every((v) => allowed.includes(v));
      },
      `must be a comma-separated subset of ${allowed.join(', ')}`,
    )
    .describe(`${what}: comma-separated, any of ${allowed.join(', ')}`);
}

/** = saved-searches.controller.ts `parseFilters`: up to 50 `{ field, value }` of short strings. */
const savedSearchFilters = z
  .array(z.object({ field: z.string().max(300), value: z.string().max(300) }).strict())
  .max(50);

/** = saved-scopes.controller.ts `parseFilters`: an object; objectTypes from the scope allowlist. */
const scopeFilters = z
  .object({
    objectTypes: z.array(z.enum(SCOPE_OBJECT_TYPES)).max(MAX_SCOPE_OBJECT_TYPES).optional(),
    projectId: f.id().optional(),
    from: f.iso().optional().describe('ISO-8601 date'),
    to: f.iso().optional().describe('ISO-8601 date'),
  })
  .strict();

export const searchDetails: readonly AiActionDetail[] = [
  det({
    id: 'search.commands.list',
    title: 'List search commands',
    description: 'List search commands.',
    input: listArgs([], { q: f.shortText(200).optional() }, { cursor: null }),
    redact: 'config',
    examples: [{ summary: 'List search commands', args: {} }],
  }),
  det({
    id: 'search.history.create',
    title: 'Record a search in your history',
    description: 'Add a query to your own recent-search history (up to 300 characters).',
    input: bodyArgs([], { query: f.shortText(300) }),
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
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'List search history', args: {} }],
  }),
  det({
    id: 'search.list',
    title: 'Search the workspace',
    description:
      'Search everything you may see for q. Narrow with projectId, audience, since (7d, 30d, all) ' +
      'and kinds (result types, comma-separated).',
    input: listArgs(
      [],
      {
        q: f.shortText(300),
        projectId: f.id().optional(),
        audience: commaSubset(SEARCH_AUDIENCES, 'Audiences').optional(),
        since: z.enum(SEARCH_TIME_WINDOWS).optional(),
        kinds: commaSubset(SEARCH_RESULT_KINDS, 'Result kinds').optional(),
      },
      { cursor: null },
    ),
    redact: 'standard',
    examples: [
      { summary: 'Find a word', args: { q: 'launch' } },
      { summary: 'Recent invoices', args: { q: 'acme', kinds: 'invoice,quote', since: '30d' } },
    ],
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
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'List search pins', args: {} }],
  }),
  det({
    id: 'search.pins.set',
    title: 'Pin an item in search',
    description: 'Pin a work item, document, meeting or project to the top of your own search.',
    input: bodyArgs([], {
      objectType: z.enum(SEARCH_PIN_OBJECT_TYPES),
      objectId: f.id(36),
      label: f.shortText(300),
    }),
    redact: 'config',
    examples: [
      {
        summary: 'Pin a task',
        args: {
          objectType: 'work_item',
          objectId: '01a20864-92a3-7a1c-b107-397ebef031dc',
          label: 'In review',
        },
      },
    ],
  }),
  det({
    id: 'search.recent.list',
    title: 'List search recent',
    description: 'List search recent.',
    input: queryArgs(),
    redact: 'standard',
    examples: [{ summary: 'List search recent', args: {} }],
  }),
  det({
    id: 'search.saved.create',
    title: 'Save a search',
    description: 'Save a named search (query and optional field/value filters) for yourself.',
    input: bodyArgs([], {
      name: f.shortText(300),
      query: f.shortText(300),
      filters: savedSearchFilters.optional(),
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
    input: queryArgs(),
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
    title: 'Create a search scope',
    description:
      'Save a named search scope: which object types, which project, which date range. ' +
      'filters is required (send {} for no limits).',
    input: bodyArgs([], { name: f.shortText(MAX_SCOPE_NAME_LENGTH), filters: scopeFilters }),
    redact: 'config',
    examples: [
      {
        summary: 'Documents only',
        args: { name: 'Design review', filters: { objectTypes: ['document'] } },
      },
    ],
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
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'List search scopes', args: {} }],
  }),
  det({
    id: 'search.scopes.set',
    title: 'Replace a search scope',
    description:
      'Replace one of your search scopes in full: name and filters are both required (filters {} ' +
      'for no limits).',
    input: bodyArgs(['scopeId'], {
      name: f.shortText(MAX_SCOPE_NAME_LENGTH),
      filters: scopeFilters,
    }),
    redact: 'config',
    examples: [
      {
        summary: 'Rename, keep work items',
        args: {
          scopeId: 'scope_1',
          name: 'Design review',
          filters: { objectTypes: ['work_item'] },
        },
      },
    ],
  }),
  det({
    id: 'search.shared.list',
    title: 'List search shared',
    description: 'List search shared.',
    input: queryArgs(),
    redact: 'standard',
    examples: [{ summary: 'List search shared', args: {} }],
  }),
  det({
    id: 'search.suggest.list',
    title: 'List search suggest',
    description: 'List search suggest.',
    input: listArgs([], { q: f.shortText(200).optional() }, { cursor: null }),
    redact: 'standard',
    examples: [{ summary: 'List search suggest', args: {} }],
  }),
];
