import type { Capability } from '@tmanage/domain';
import type { CommandDefinition } from './command-match.js';

/**
 * SRCH command palette (x181) — the static, code-defined command registry.
 *
 * Every command the palette can ever offer is declared here, in source, as a literal. This is the
 * security spine of the slice: because the registry is fixed at build time and the matcher only ever
 * *selects and orders* from it (see {@link ./command-match.ts}), a caller's query can never introduce
 * a command, a route or an action. The palette dispatches nothing that is not on this list.
 *
 * The `navigate` commands mirror the internal rail (`apps/web/.../shell/navigation.ts`) so the
 * palette is a keyboard route to the same tenant-scoped screens — each `href` is a route suffix the
 * shell prefixes with the organization slug, exactly as the rail links do. The `action` commands are
 * the "few safe quick actions" the module map asks for: each names an allowlisted action id
 * ({@link CommandActionId}) that the web palette maps to one hardcoded, self-contained behaviour.
 *
 * Deeper destinations, per-record commands and the AI copilot are deferred (NS-13 / Needs-Peter).
 */

/**
 * The closed set of quick-action ids the palette knows how to dispatch. It is a union of string
 * literals rather than an open `string` so that adding an action is a source change reviewed here and
 * mirrored by a `case` in the palette's dispatch switch — a query can never name one that is not in
 * this union, and the palette can never receive one it has no hardcoded handler for.
 */
export type CommandActionId = 'open-search' | 'clear-recent-search';

/** A navigate command: a rail-mirroring route the palette links to. */
function navigate(
  id: string,
  title: string,
  href: string,
  keywords: readonly string[],
  capability?: Capability,
): CommandDefinition {
  return {
    id,
    title,
    section: 'Navigate',
    kind: 'navigate',
    href,
    action: null,
    keywords,
    ...(capability ? { capability } : {}),
  };
}

/** A quick-action command: an allowlisted id the palette dispatches to a hardcoded behaviour. */
function action(
  id: string,
  title: string,
  actionId: CommandActionId,
  keywords: readonly string[],
): CommandDefinition {
  return {
    id,
    title,
    section: 'Quick actions',
    kind: 'action',
    href: null,
    action: actionId,
    keywords,
  };
}

/**
 * The registry, in the order it is offered when the query is empty (the default set). Navigation
 * mirrors the internal rail's order; the quick actions follow.
 */
export const COMMAND_REGISTRY: readonly CommandDefinition[] = [
  navigate('nav-home', 'Go to Home', '/home', ['dashboard', 'my day', 'overview']),
  navigate('nav-inbox', 'Go to Inbox', '/inbox', ['notifications', 'triage']),
  navigate('nav-chat', 'Go to Chat', '/chat', ['messages', 'conversations']),
  navigate('nav-work', 'Go to Work', '/work', ['tasks', 'items', 'board']),
  navigate('nav-calendar', 'Go to Calendar', '/calendar', ['meetings', 'agenda', 'schedule']),
  navigate('nav-docs', 'Go to Docs', '/docs', ['documents', 'files', 'notes']),
  navigate('nav-people', 'Go to People', '/people', ['members', 'team', 'capacity']),
  navigate('nav-insights', 'Go to Insights', '/insights', ['analytics', 'reports', 'metrics']),
  // Quick capture (modules 22/23). A `navigate` to the capture screen rather than an `action`:
  // filing a note belongs on the capture screen (which also prefills from a share), so the palette
  // only needs to take the caller there. The id the module map names is `capture-new`.
  navigate('capture-new', 'Quick capture', '/capture', ['new', 'note', 'task', 'jot', 'add']),
  // AUT-04: the rule builder, which no menu reached. Automations are an organization-admin concern
  // (`org.manage`), so only the people who can open it are offered it.
  navigate(
    'nav-automations',
    'Go to Automations',
    '/automations',
    ['rules', 'automation', 'workflow', 'trigger'],
    'org.manage',
  ),
  action('act-search', 'Search the workspace', 'open-search', ['find', 'lookup', 'query']),
  action('act-clear-recent', 'Clear recent search', 'clear-recent-search', ['forget', 'reset']),
];
