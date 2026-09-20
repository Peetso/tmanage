import { describe, expect, it } from 'vitest';
import { selectWorkerCommand, unparkDiagnosticLines, workerModeFor } from './cli.js';

/**
 * The relay entry point reads `process.argv` and does I/O the moment it is imported, so the
 * argument parsing and mode selection are lifted out into {@link selectWorkerCommand} — a pure
 * function that a test can exercise without a database. x8 review IMPORTANT-G's second half: the
 * flag combinations that decide what `main` does had no test, and `--once --status` silently
 * doing status only was undocumented. This pins both. `main` maps `unpark-invalid` to exit 2 and
 * `loop` to the only mode that holds a socket open; those mappings are asserted here in the pure
 * form the process consumes.
 */
describe('selectWorkerCommand', () => {
  it('selects the single-batch once mode', () => {
    expect(selectWorkerCommand(['node', 'main', '--once'])).toEqual({ kind: 'once' });
  });

  it('selects the report-only status mode', () => {
    expect(selectWorkerCommand(['node', 'main', '--status'])).toEqual({ kind: 'status' });
  });

  it('lets --status win over --once, so --once --status reports and delivers nothing', () => {
    expect(selectWorkerCommand(['node', 'main', '--once', '--status'])).toEqual({ kind: 'status' });
  });

  it('runs the polling loop when no flag is given', () => {
    expect(selectWorkerCommand(['node', 'main'])).toEqual({ kind: 'loop' });
  });

  it('selects the invitation-expiry sweep, winning over --once so one invocation does one thing', () => {
    expect(selectWorkerCommand(['node', 'main', '--sweep-invitations'])).toEqual({
      kind: 'sweep-invitations',
    });
    expect(selectWorkerCommand(['node', 'main', '--sweep-invitations', '--once'])).toEqual({
      kind: 'sweep-invitations',
    });
  });

  it('unparks a named event id', () => {
    expect(selectWorkerCommand(['node', 'main', '--unpark', 'evt-1'])).toEqual({
      kind: 'unpark',
      selector: 'evt-1',
    });
  });

  it('unparks every parked row with --all', () => {
    expect(selectWorkerCommand(['node', 'main', '--unpark', '--all'])).toEqual({
      kind: 'unpark',
      selector: null,
    });
  });

  it('refuses a bare --unpark (no id, no --all) — main exits 2', () => {
    expect(selectWorkerCommand(['node', 'main', '--unpark'])).toEqual({ kind: 'unpark-invalid' });
  });

  it('refuses --unpark <id> --all — the two selectors are exclusive, main exits 2', () => {
    expect(selectWorkerCommand(['node', 'main', '--unpark', 'evt-1', '--all'])).toEqual({
      kind: 'unpark-invalid',
    });
  });
});

describe('workerModeFor', () => {
  it('holds the third connection open only for the loop; every flagged mode is a batch', () => {
    expect(workerModeFor({ kind: 'loop' })).toBe('loop');
    expect(workerModeFor({ kind: 'once' })).toBe('batch');
    expect(workerModeFor({ kind: 'status' })).toBe('batch');
    expect(workerModeFor({ kind: 'unpark', selector: null })).toBe('batch');
    expect(workerModeFor({ kind: 'unpark-invalid' })).toBe('batch');
    expect(workerModeFor({ kind: 'sweep-invitations' })).toBe('batch');
  });
});

describe('unparkDiagnosticLines', () => {
  const rows = [
    { id: 'a', lastError: 'smtp 550' },
    { id: 'b', lastError: null },
  ];

  it('surfaces every row last_error before --all wipes them all at once', () => {
    // --all is the only path that clears last_error on every parked row, so it is the last
    // chance to read the diagnosis. selector === null is the --all case.
    expect(unparkDiagnosticLines(rows, null)).toEqual([
      '[worker] parked a last_error before reset: smtp 550',
      '[worker] parked b last_error before reset: none',
    ]);
  });

  it('stays silent for a named id — the rest of the parked set keeps its diagnoses', () => {
    expect(unparkDiagnosticLines(rows, 'a')).toEqual([]);
  });
});
