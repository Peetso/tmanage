// @vitest-environment node
//
// This file renders nothing. The suite's default is `jsdom`, whose setup costs several
// seconds per file on this machine, and paying it to read two directories would slow every
// run and add contention to a suite that already has one timing-sensitive assertion.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every ticket id this application cites must exist in `28-SPRINT-TICKETS-AND-ESTIMATES.md`.
 *
 * ## Why this file exists
 *
 * Screens carry a `BackendPending` notice naming the ticket that will finish them, and that
 * notice is **rendered to a person**. Over eleven sessions seven of those ids turned out to be
 * inventions — `MILE-001`, `PULSE-001`, `PEOPLE-001`, `MAIL-001`, `AUD-002`, `DOC-001` and
 * `INSIGHT-001` — each written because a real gap needed something to point at and a plausible
 * id was quicker than a quotation. The gaps were all real. The ids were not, and a reader
 * following one into the backlog would have found nothing there.
 *
 * A comment asking the next author to check would not have caught any of them. This does,
 * because it fails the suite.
 *
 * ## What it does not do
 *
 * It checks `apps/web` only. `18-REPOSITORY-STRUCTURE` puts the web app above the API and
 * `eslint.config.js` enforces that boundary, so a test in this package must not reach into
 * `apps/api` or `packages/*` to scan them. Those trees were corrected by hand in the same
 * pass; extending the check to them needs a repository-level gate of its own, which is
 * recorded in `docs/implementation-status.md` rather than smuggled in here.
 *
 * ## The pattern
 *
 * Three digits, so that ticket ids (`REQ-001`) are matched and the screen ids they sit beside
 * (`REQ-01`, `CL-09`, `TM-03`, `ON-03`) are not. `ADR-0001` has four and is likewise ignored.
 */
const TICKET_PATTERN = /\b[A-Z][A-Z0-9]*-\d{3}\b/g;

/**
 * `process.cwd()` rather than `import.meta.url`: vitest's transform does not give this module
 * a `file:` URL, and `fileURLToPath` throws on what it does give. The config sets no `root`,
 * so the working directory is `apps/web`.
 */
const webRoot = process.cwd();
const repositoryRoot = join(webRoot, '..', '..');
const planPath = join(repositoryRoot, 'docs', 'planning', '28-SPRINT-TICKETS-AND-ESTIMATES.md');
const sourceRoot = join(webRoot, 'src');

/**
 * The ids the plan actually schedules, read out of the plan rather than restated here.
 *
 * A hard-coded list in this file would be a second copy of the backlog, and a second copy is
 * how the drift being tested for started. `docs/planning/` is a verbatim copy of the planning
 * pack and is never edited, so reading it is safe.
 */
function scheduledTicketIds(): ReadonlySet<string> {
  const plan = readFileSync(planPath, 'utf8');
  const ids = new Set<string>();
  for (const line of plan.split('\n')) {
    // Ticket rows only: `| TICKET | scope | SP | depends |`. Prose mentions a ticket too, and
    // a prose mention is not a schedule.
    const row = /^\|\s*([A-Z][A-Z0-9]*-\d{3})\s*\|/.exec(line);
    if (row?.[1] !== undefined) {
      ids.add(row[1]);
    }
  }
  return ids;
}

function sourceFiles(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      found.push(full);
    }
  }
  return found;
}

describe('ticket ids cited by apps/web', () => {
  it('reads the schedule out of the plan and finds a plausible number of tickets', () => {
    const scheduled = scheduledTicketIds();
    // §§3–12 hold 70 tickets and §12A a further 6. A parser that silently matched nothing
    // would make every other assertion here vacuous.
    expect(scheduled.size).toBe(76);
    expect(scheduled.has('CHAT-001')).toBe(true);
    expect(scheduled.has('MILE-001')).toBe(false);
  });

  it('cites no ticket id the plan does not schedule', () => {
    const scheduled = scheduledTicketIds();
    const invented: string[] = [];

    for (const file of sourceFiles(sourceRoot)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(TICKET_PATTERN)) {
        const id = match[0];
        if (!scheduled.has(id)) {
          invented.push(`${relative(repositoryRoot, file)}: ${id}`);
        }
      }
    }

    // Named individually in the failure so the message says which file invented which id.
    expect(invented).toEqual([]);
  });
});
