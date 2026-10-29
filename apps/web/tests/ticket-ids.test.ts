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
 * Screens carry a `BackendPending` notice naming the ticket that will finish them. Since
 * 2026-09-12 that id is rendered **only in a development build** — see `BackendPending` and
 * `backend-pending-copy.test.tsx` — so the reader who follows it is a colleague rather than a
 * customer. That makes a wrong id cheaper, not harmless: it still sends somebody into the
 * backlog after a row that is not there. Over eleven sessions seven of those ids turned out to be
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
 * Standard algorithm names that share the ticket shape: the Web Crypto digest argument
 * (`crypto.subtle.digest('SHA-256', …)`, the 52-21 form proof) is code, not a ticket id.
 */
const NOT_TICKET_IDS: ReadonlySet<string> = new Set(['SHA-256', 'SHA-384', 'SHA-512']);

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
        if (!scheduled.has(id) && !NOT_TICKET_IDS.has(id)) {
          invented.push(`${relative(repositoryRoot, file)}: ${id}`);
        }
      }
    }

    // Named individually in the failure so the message says which file invented which id.
    expect(invented).toEqual([]);
  });
});

/**
 * **No internal identifier survives into copy a person reads.**
 *
 * The 2026-09-05 review, §7, "Design debt to address as the relevant slice lands"
 * (`production-review-2026-09-05/CLAUDE-REVIEW-REPORT.md:302`):
 *
 * > "Remove ticket identifiers and “Is the API running?” copy from customer-facing flows. Keep
 * > development diagnostics in an explicit development mode."
 *
 * `backend-pending-copy.test.tsx` renders the identity screens and proves the notice itself is
 * clean in a production build. It cannot prove it for all nineteen screens that carry one:
 * rendering each needs a query client, fixtures and a router, and the screens that regress are
 * exactly the ones nobody thought to add. So this reads them instead.
 *
 * ## Why a source scan is sound here
 *
 * The two things being looked for cannot occur in code. A three-digit ticket id
 * (`CLIENT-002`) and a planning-pack file reference (`23-ERD`) are not legal identifiers and
 * appear in these files only inside prose. So anything left after comments are removed is
 * text a screen renders.
 *
 * ## What is removed before looking, and why each is legitimate
 *
 * - **Comments**, block and line, which includes JSDoc and the braced block-comment form used
 *   inside JSX. Explaining in a comment which ticket builds a thing is the point of the
 *   comment; it reaches no reader of the product.
 * - **The `ticket` prop of `BackendPending`**, which is the identifier's sanctioned home. It
 *   is rendered only when `NODE_ENV` is not `production`, proved separately, and stripping it
 *   here is what keeps this test about copy rather than about the prop.
 *
 * Nothing else is excluded. A screen that puts an id in a heading, a hint, a label or a
 * sentence fails, which is how `CLIENT-002` was found in `ProjectOverviewScreen`'s portal
 * hint after the first sweep of this slice had already passed over that file.
 */
const COPY_TICKET_PATTERN = /\b[A-Z][A-Z0-9]*-\d{3}(?!\d)/g;

/** `28-SPRINT-TICKETS`, `23-ERD`, `41-WHOLE-APP-…` — the planning pack cited by name. */
const PLANNING_FILE_PATTERN = /\b\d{2}-[A-Z][A-Z-]{3,}/g;

/**
 * The file with comments and the sanctioned `ticket` prop removed.
 *
 * The line-comment rule requires a non-`:` character before `//` so that a `https://` inside a
 * string is not read as the start of a comment and used to delete the rest of the line.
 */
function copyOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/\bticket=(?:"[^"]*"|'[^']*'|\{`[^`]*`\})/g, ' ');
}

describe('internal identifiers in copy a person reads', () => {
  it('strips comments and the sanctioned ticket prop, and still sees a planted id', () => {
    // Without this the scan below could pass by stripping everything.
    const planted = copyOnly(
      [
        '/* CHAT-001 in a comment */',
        '<BackendPending ticket="ID-002">',
        'Blocked by WORK-002.',
      ].join('\n'),
    );

    expect(planted).not.toContain('CHAT-001');
    expect(planted).not.toContain('ID-002');
    expect(planted).toContain('WORK-002');
  });

  it('renders no ticket id outside the notice that gates it', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(sourceRoot)) {
      const copy = copyOnly(readFileSync(file, 'utf8'));
      for (const match of copy.matchAll(COPY_TICKET_PATTERN)) {
        if (NOT_TICKET_IDS.has(match[0])) continue;
        offenders.push(`${relative(repositoryRoot, file)}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('names no planning-pack document to a person', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(sourceRoot)) {
      const copy = copyOnly(readFileSync(file, 'utf8'));
      for (const match of copy.matchAll(PLANNING_FILE_PATTERN)) {
        offenders.push(`${relative(repositoryRoot, file)}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
