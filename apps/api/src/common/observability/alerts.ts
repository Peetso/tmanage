import type { Mailer } from '@tmanage/mail';

/**
 * Operator alerts (C10) — free, self-contained, and off unless somebody is named.
 *
 * Two things page the platform operator: an unhandled server error (a 5xx the
 * `HttpExceptionFilter` rendered) and a background job that failed (the in-process relay's batch
 * threw, or an event was parked). Each goes through the application's own mailer to the addresses
 * in `ALERT_EMAILS` — the owner(s) of the account that operates this TManage service. No paid
 * service, no webhook, no secret in code: the SMTP settings the app already sends mail with.
 *
 * ## At most once per 15 minutes per kind
 *
 * A broken dependency raises the same error on every request, and an alert per request would
 * bury the one message that matters. So each *kind* (`http_5xx:unhandled:TypeError`,
 * `job_failed:outbox`, …) mails at most once per {@link ALERT_WINDOW_MS}; the occurrences in
 * between are counted and the next mail says how many were held back.
 *
 * ## What an alert may carry
 *
 * The kind, the time, a route path, a correlation id and an error *class name* — never an error
 * message. A driver error's message carries SQL and bound values; a correlation id is how the
 * operator finds the full, redacted line in the log instead.
 */

/** One mail per kind per window. */
export const ALERT_WINDOW_MS = 15 * 60 * 1_000;

/** The most distinct kinds tracked at once; the oldest is forgotten beyond it. */
export const MAX_TRACKED_KINDS = 200;

/** Nest token for the process's notifier. `Symbol.for` like every token in `tokens.ts`. */
export const ALERT_NOTIFIER = Symbol.for('tmanage.AlertNotifier');

/** Parse `ALERT_EMAILS` into a de-duplicated, lower-cased list. Junk entries drop out. */
export function parseAlertEmails(raw: string | null | undefined): readonly string[] {
  if (typeof raw !== 'string') return [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const email = part.trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) && email.length <= 254) seen.add(email);
  }
  return [...seen];
}

/** Safe facts about one occurrence. Every field is optional; none is ever a message body. */
export interface AlertFacts {
  readonly route?: string;
  readonly correlationId?: string;
  readonly errorName?: string;
  readonly detail?: string;
}

export type AlertOutcome = 'sent' | 'throttled' | 'off' | 'failed';

export interface AlertNotifierOptions {
  readonly recipients: readonly string[];
  readonly mailer: Mailer | null;
  /** Injected so a test can move time; defaults to the wall clock. */
  readonly now?: () => number;
  readonly windowMs?: number;
  /** Where a failed send is reported. Defaults to stderr. */
  readonly log?: (line: string) => void;
}

interface KindState {
  lastSentAt: number;
  held: number;
}

/** A kind is a short stable token: letters, digits and `_:.-` only, at most 120 characters. */
export function normaliseKind(kind: string): string {
  const cleaned = kind.replace(/[^A-Za-z0-9_:.-]/gu, '_').slice(0, 120);
  return cleaned === '' ? 'unknown' : cleaned;
}

/** Strip a query string and cap the length — a path is enough to find the route. */
function safeRoute(route: string | undefined): string | undefined {
  if (route === undefined) return undefined;
  return route.split('?')[0]?.slice(0, 200);
}

export class AlertNotifier {
  private readonly kinds = new Map<string, KindState>();
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly log: (line: string) => void;

  constructor(private readonly options: AlertNotifierOptions) {
    this.now = options.now ?? (() => Date.now());
    this.windowMs = options.windowMs ?? ALERT_WINDOW_MS;
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  }

  /** Off when nobody is named or there is no transport. */
  get enabled(): boolean {
    return this.options.recipients.length > 0 && this.options.mailer !== null;
  }

  /**
   * Record one occurrence and mail it unless this kind already mailed within the window.
   * Never throws: an alert that failed must not turn into a second failure for its caller.
   */
  async notify(rawKind: string, facts: AlertFacts = {}): Promise<AlertOutcome> {
    if (!this.enabled) return 'off';
    const kind = normaliseKind(rawKind);
    const at = this.now();
    const state = this.kinds.get(kind);
    if (state !== undefined && at - state.lastSentAt < this.windowMs) {
      state.held += 1;
      return 'throttled';
    }
    const held = state?.held ?? 0;
    // Re-inserted so the Map's order is least-recently-mailed first, which is what the cap evicts.
    this.kinds.delete(kind);
    this.kinds.set(kind, { lastSentAt: at, held: 0 });
    while (this.kinds.size > MAX_TRACKED_KINDS) {
      const oldest = this.kinds.keys().next().value;
      if (oldest === undefined) break;
      this.kinds.delete(oldest);
    }

    const message = renderAlert(kind, facts, new Date(at), held);
    const mailer = this.options.mailer;
    if (mailer === null) return 'off';
    let failed = false;
    for (const to of this.options.recipients) {
      try {
        await mailer.send({
          to,
          subject: message.subject,
          text: message.text,
          templateKey: 'ops_alert',
        });
      } catch (error) {
        failed = true;
        const name = error instanceof Error ? error.name : 'unknown';
        this.log(`[alerts] could not mail ${kind} (${name})`);
      }
    }
    return failed ? 'failed' : 'sent';
  }
}

/** The plain-text mail for one alert. Exported for the unit test. */
export function renderAlert(
  kind: string,
  facts: AlertFacts,
  at: Date,
  held: number,
): { subject: string; text: string } {
  const what = kind.startsWith('http_5xx')
    ? 'A request failed with a server error'
    : kind.startsWith('job_')
      ? 'A background job failed'
      : 'TManage needs attention';
  const lines = [`${what}.`, '', `Kind: ${kind}`, `Time (UTC): ${at.toISOString()}`];
  const route = safeRoute(facts.route);
  if (route !== undefined) lines.push(`Route: ${route}`);
  if (facts.errorName !== undefined) lines.push(`Error: ${facts.errorName.slice(0, 80)}`);
  if (facts.detail !== undefined) lines.push(`Detail: ${facts.detail.slice(0, 300)}`);
  if (facts.correlationId !== undefined) lines.push(`Correlation id: ${facts.correlationId}`);
  if (held > 0) lines.push(`Held back since the last alert of this kind: ${String(held)}`);
  lines.push(
    '',
    'You get at most one alert of each kind every 15 minutes.',
    'Search the server log for the correlation id to see the full entry.',
  );
  return { subject: `[TManage alert] ${what}: ${kind}`, text: lines.join('\n') };
}

/** The process's notifier, from the parsed recipients and the app's own mailer. */
export function createAlertNotifier(
  recipients: readonly string[],
  mailer: Mailer | null,
): AlertNotifier {
  return new AlertNotifier({ recipients, mailer });
}
