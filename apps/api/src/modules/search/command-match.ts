import type { Capability } from '@tmanage/domain';
/**
 * SRCH command palette (x181) — the pure matcher.
 *
 * `38-MODULE-MAP` §Search, command & AI asks for a command palette: keyboard-driven navigation and
 * a few safe quick actions over the existing search. The audit (#8, Search Partial) records that
 * only basic/ranked search is built and no command surface exists. This slice adds the non-AI
 * command surface; the AI copilot stays Needs-Peter (an external LLM).
 *
 * This module is the ranking half, and it is deliberately a **pure function** — no wall-clock, no
 * database, no `eval`, no `Function`, no dynamic dispatch. It scores a static, code-defined command
 * registry against a caller's query and returns the matches in score order, bounded. Two properties
 * matter and are unit-tested:
 *
 *   1. **Determinism.** The same registry and query always produce the same ordered result. There is
 *      no time input and no I/O, so the order is a function of the inputs alone — the x148 ranking
 *      lesson applied to a static set.
 *   2. **No injection.** The query only ever *selects and orders* commands that already exist in the
 *      registry. It is never a source of a command, a target, an href or an action — a query can no
 *      more introduce a command than a search term can introduce a work item. The palette that
 *      consumes this can therefore never dispatch anything the registry did not declare.
 */

/** The kinds a command can be. `navigate` links to an in-app route; `action` dispatches an allowlisted client action. */
export type CommandKind = 'navigate' | 'action';

/**
 * One command in the static registry. `href` is the in-app route suffix for a `navigate` command
 * (always null for an `action`); `action` is the allowlisted action id for an `action` command
 * (always null for a `navigate`). `keywords` widen what the matcher will match without widening the
 * label. Nothing here is ever derived from a caller's query.
 */
export interface CommandDefinition {
  readonly id: string;
  readonly title: string;
  readonly section: string;
  readonly kind: CommandKind;
  readonly href: string | null;
  readonly action: string | null;
  readonly keywords: readonly string[];
  /**
   * The capability a caller needs for the destination to be of any use (CQ-06). A command without
   * one is offered to everyone who may use the palette; one with it only to callers who hold it
   * org-wide, so the palette never offers a page that would refuse them.
   */
  readonly capability?: Capability;
}

/** The default cap; the caller may lower it but never raise it past {@link MAX_COMMAND_RESULTS}. */
export const DEFAULT_COMMAND_LIMIT = 12;
/** The hard ceiling on how many commands one response may carry — the x93/x98 bounded-list precedent. */
export const MAX_COMMAND_RESULTS = 25;

/** Clamp a requested limit into `[1, MAX_COMMAND_RESULTS]`, defaulting a missing/invalid one. */
export function effectiveCommandLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_COMMAND_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_COMMAND_RESULTS);
}

/**
 * Score one command against a already-normalized (lower-cased, trimmed) query. Higher is better; a
 * non-positive score means "no match" and the command is dropped. The scoring is intentionally
 * simple and explainable:
 *
 *   - an exact title match scores highest;
 *   - a title that starts with the query scores above one that merely contains it;
 *   - a keyword that starts with the query scores above one that merely contains it;
 *   - nothing else matches.
 *
 * Ties are broken by the caller (registry order), so the result is fully deterministic.
 */
function scoreCommand(command: CommandDefinition, query: string): number {
  const title = command.title.toLowerCase();
  if (title === query) return 100;
  if (title.startsWith(query)) return 80;

  let best = 0;
  if (title.includes(query)) best = 60;

  for (const keyword of command.keywords) {
    const value = keyword.toLowerCase();
    if (value === query) best = Math.max(best, 70);
    else if (value.startsWith(query)) best = Math.max(best, 50);
    else if (value.includes(query)) best = Math.max(best, 30);
  }

  return best;
}

/**
 * Match the registry against a raw query and return the commands in score order, bounded.
 *
 * An empty (or whitespace-only) query is not an error here — it is the *default set*: the registry in
 * its declared order, bounded. A non-empty query keeps only the commands that score above zero,
 * orders them by score descending and then by their original registry index (a stable tie-break, so
 * the order never depends on the array sort's stability), and bounds the result. The registry is
 * never mutated.
 */
export function matchCommands(
  registry: readonly CommandDefinition[],
  rawQuery: string,
  limit: number | undefined = DEFAULT_COMMAND_LIMIT,
): readonly CommandDefinition[] {
  const bound = effectiveCommandLimit(limit);
  const query = rawQuery.trim().toLowerCase();

  if (query === '') {
    return registry.slice(0, bound);
  }

  const scored = registry
    .map((command, index) => ({ command, index, score: scoreCommand(command, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => (b.score - a.score !== 0 ? b.score - a.score : a.index - b.index));

  return scored.slice(0, bound).map((entry) => entry.command);
}
