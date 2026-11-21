import { COMMAND_REGISTRY } from '../search/command-registry.js';

/**
 * 62-10 (plan 62 §4.1 step 3, §5 "simple support free") — the help path's cached prefix: how
 * TManage is laid out, generated from the command palette's own registry so it never names a page
 * that does not exist and never drifts from the app. It holds no workspace, member or record data:
 * the same bytes for every workspace (one cached prefix; the snapshot test pins it).
 *
 * The help path answers with no tools, on the platform-paid `help` tier, at most
 * {@link FREE_SUPPORT_PER_MEMBER_PER_DAY} questions a member a day (`ai-tiers.ts`, counted by the
 * budget in `openTask`). A member reaches it straight from the help button (`help: true`) with no
 * router call, or through the router when a question is routed to `help`.
 */

export const HELP_PREFIX_VERSION = 'help-2026-11-21';

function pages(): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const command of COMMAND_REGISTRY) {
    if (command.kind !== 'navigate' || command.href === null || seen.has(command.href)) continue;
    seen.add(command.href);
    const name = command.title.replace(/^Go to\s+/i, '');
    const also = command.keywords.length === 0 ? '' : ` (also: ${command.keywords.join(', ')})`;
    lines.push(`- ${name}: ${command.href}${also}`);
  }
  return lines.join('\n');
}

/** The help system text: constant for every workspace. */
export const HELP_PREFIX = `You are the TManage help assistant. You explain how TManage works and where things are.
You have no tools and you cannot see or change any workspace data; if the member asks about their
own tasks, projects or figures, tell them to ask the assistant without the help button.
Name a page only from the list below, as its path (for example /work). Never invent a page, a
setting or a feature. If you do not know, say so plainly.
Answer in the language of the member's message, short and plain.

Pages:
${pages()}`;
