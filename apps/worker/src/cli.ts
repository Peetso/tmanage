import type { WorkerMode } from './common/database/worker-database.js';

/**
 * The relay CLI's pure parts — argument parsing, mode selection and the one-off unpark
 * diagnostic — lifted out of `main.ts` so they can be tested without a database (x8 review
 * IMPORTANT-G). `main` still owns every effect; nothing here reads `process.argv`, the clock or
 * the database. The functions take the same inputs `main` computes and return the decisions it
 * acts on, so the behaviour is exactly what the inline code did before the extraction.
 */

/**
 * What an invocation asked for, resolved from argv before any I/O.
 *
 * Precedence, unchanged from the dispatch it replaces: `--unpark` wins over everything (an
 * operator replaying parked rows is not also asking for a status read or a batch), then
 * `--status` over `--once` (so `--once --status` reports and delivers nothing), then the
 * polling loop when no flag is given. `unpark-invalid` is a bare `--unpark` or `--unpark <id>
 * --all` — the id and `--all` selectors are mutually exclusive — which `main` refuses with
 * exit 2.
 */
export type WorkerCommand =
  | { readonly kind: 'unpark'; readonly selector: string | null }
  | { readonly kind: 'unpark-invalid' }
  | { readonly kind: 'sweep-invitations' }
  | { readonly kind: 'status' }
  | { readonly kind: 'once' }
  | { readonly kind: 'loop' };

export function selectWorkerCommand(argv: readonly string[]): WorkerCommand {
  const once = argv.includes('--once');
  const status = argv.includes('--status');
  const sweepInvitations = argv.includes('--sweep-invitations');
  const unparkIndex = argv.indexOf('--unpark');
  const unparkAll = argv.includes('--all');
  // The first argument after `--unpark` that is not itself a flag. An event id is a UUID, so
  // nothing an operator can type here is ambiguous with `--all`.
  const unparkId =
    unparkIndex === -1
      ? undefined
      : argv.slice(unparkIndex + 1).find((argument) => !argument.startsWith('--'));

  if (unparkIndex !== -1) {
    // Exactly one of an event id or `--all`: the XOR that `main.ts` guarded inline. A bare
    // `--unpark` refuses rather than guessing, and an id with `--all` refuses rather than
    // silently ignoring one.
    if (unparkAll === (unparkId !== undefined)) return { kind: 'unpark-invalid' };
    return { kind: 'unpark', selector: unparkAll ? null : (unparkId ?? null) };
  }
  // TEN-003 / ON-04: the invitation-expiry sweep, its own single-batch operational command. It
  // delivers nothing from the outbox and holds nothing open, so it ranks with the flagged batch
  // modes below `--unpark`; a `--sweep-invitations --once` names two jobs and the sweep wins,
  // matching how `--status` wins over `--once` — one invocation does one thing.
  if (sweepInvitations) return { kind: 'sweep-invitations' };
  if (status) return { kind: 'status' };
  if (once) return { kind: 'once' };
  return { kind: 'loop' };
}

/**
 * The database pool size the command needs. Only the polling loop holds two loops and the
 * realtime server open at once and needs the third connection; every flagged mode — including a
 * refused unpark — delivers from a single sequential pass. Matches the original
 * `once || status || unparkIndex !== -1 ? 'batch' : 'loop'`.
 */
export function workerModeFor(command: WorkerCommand): WorkerMode {
  return command.kind === 'loop' ? 'loop' : 'batch';
}

/** A replayed row, in the shape both queues return it — just enough to log the diagnosis. */
interface UnparkedRow {
  readonly id: string;
  readonly lastError: string | null;
}

/**
 * The `last_error` lines to print for an unpark run, one per row, and empty for a named id.
 *
 * `--unpark --all` (selector `null`) clears `last_error` on *every* parked row, and neither
 * `relay:status` nor the per-row confirmation prints it — so `--all` is the last moment the
 * diagnosis can be read (x8 review carry-over 2). The value shown is captured by the `FOR
 * UPDATE` select before the reset lands, so it is the pre-reset diagnosis even though it prints
 * afterwards. A named id leaves the rest of the parked set — and its diagnoses — untouched and
 * still readable, so it prints nothing extra here and its output is unchanged.
 */
export function unparkDiagnosticLines(
  replayed: readonly UnparkedRow[],
  selector: string | null,
): readonly string[] {
  if (selector !== null) return [];
  return replayed.map(
    (row) => `[worker] parked ${row.id} last_error before reset: ${row.lastError ?? 'none'}`,
  );
}
