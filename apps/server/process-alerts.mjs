// 51-13a — the process-level error alert.
//
// A request error reaches the HttpExceptionFilter and a relay failure reaches job-alerts.mjs;
// an exception nobody caught (or a promise rejection nobody handled, which Node turns into one)
// reaches neither. This handler mails it to ALERT_EMAILS through the same notifier, then lets
// the process exit with code 1 exactly as Node would have — Hostinger restarts it.
//
// A crash loop would mail once per restart, and the in-memory window does not survive a
// restart, so the window is kept in a small JSON file (`stateFile`): at most one crash alert per
// 15 minutes, and the next one says how many crashes were held back. Only the origin and the
// error class name are mailed; the full (redacted) entry goes to the server log.

import { clearTimeout, setTimeout } from 'node:timers';

export const CRASH_WINDOW_MS = 15 * 60 * 1_000;

/** How long the mail may take before the process exits anyway. */
export const CRASH_DEADLINE_MS = 3_000;

/**
 * @param {string | undefined} stateFile
 * @param {{ readFileSync: Function, writeFileSync: Function }} fs
 */
function readState(stateFile, fs) {
  if (!stateFile) return { lastSentAt: 0, held: 0 };
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return {
      lastSentAt: Number.isFinite(parsed?.lastSentAt) ? parsed.lastSentAt : 0,
      held: Number.isInteger(parsed?.held) && parsed.held > 0 ? parsed.held : 0,
    };
  } catch {
    return { lastSentAt: 0, held: 0 };
  }
}

function writeState(stateFile, fs, state) {
  if (!stateFile) return;
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
  } catch {
    // An unwritable state file only loses the cross-restart window.
  }
}

/**
 * Decide and send one crash alert. Exported for the unit test.
 *
 * @param {{ notify(kind: string, facts?: object): Promise<string> } | null | undefined} alerts
 * @param {unknown} error
 * @param {string} origin  `uncaughtException` or `unhandledRejection`
 * @param {{ stateFile?: string, fs: { readFileSync: Function, writeFileSync: Function }, now?: number, windowMs?: number }} options
 * @returns {Promise<'sent' | 'throttled' | 'off'>}
 */
export async function reportCrash(alerts, error, origin, options) {
  if (!alerts || alerts.enabled === false) return 'off';
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? CRASH_WINDOW_MS;
  const state = readState(options.stateFile, options.fs);
  if (now - state.lastSentAt < windowMs) {
    writeState(options.stateFile, options.fs, { ...state, held: state.held + 1 });
    return 'throttled';
  }
  writeState(options.stateFile, options.fs, { lastSentAt: now, held: 0 });
  const errorName = error instanceof Error ? error.constructor.name : typeof error;
  const detail =
    state.held > 0
      ? `The process stopped and was restarted. ${String(state.held)} earlier crash(es) were held back.`
      : 'The process stopped and was restarted.';
  await alerts.notify(`process_crash:${origin}:${errorName}`, { errorName, detail });
  return 'sent';
}

/**
 * Install the handler on `proc`. Re-entry (a second fault while mailing) exits at once.
 *
 * @param {NodeJS.Process} proc
 * @param {{ notify(kind: string, facts?: object): Promise<string>, enabled?: boolean } | null | undefined} alerts
 * @param {{ log: (line: string) => void, describe?: (error: unknown) => string, stateFile?: string,
 *   fs: { readFileSync: Function, writeFileSync: Function }, deadlineMs?: number, exit?: (code: number) => void }} options
 */
export function installProcessAlerts(proc, alerts, options) {
  const exit = options.exit ?? ((code) => proc.exit(code));
  const describe =
    options.describe ??
    ((error) => (error instanceof Error ? error.constructor.name : typeof error));
  let handling = false;
  proc.on('uncaughtException', (error, origin) => {
    if (handling) {
      exit(1);
      return;
    }
    handling = true;
    options.log(`fatal ${String(origin)}: ${describe(error)}`);
    const deadline = setTimeout(() => exit(1), options.deadlineMs ?? CRASH_DEADLINE_MS);
    deadline.unref?.();
    void reportCrash(alerts, error, String(origin), options)
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(deadline);
        exit(1);
      });
  });
}
