import type { Mailer } from '@tmanage/mail';
import { ALERT_WINDOW_MS, AlertNotifier, normaliseKind } from './alerts.js';
import type { AlertFacts, AlertOutcome } from './alerts.js';

/**
 * 51-13a — built-in error alerts, grouped.
 *
 * {@link AlertNotifier} mails one alert per kind per 15 minutes and mentions what it held back
 * only when the *next* alert of that kind goes out — so a burst that stops is never reported in
 * full. This module puts a small grouping layer in front of it:
 *
 * - **One group per kind.** The first occurrence in a window mails at once; the rest are counted.
 * - **Route patterns, not paths.** `/v1/projects/0193…/tasks/42` is reported as
 *   `/v1/projects/:id/tasks/:id`, so the group lists where it happens without ids or tokens.
 * - **A closing summary.** {@link GroupedAlertNotifier.flush} (on a timer) mails one summary per
 *   group whose window closed with occurrences held back: "37 more in the last 15 minutes, on
 *   these routes". Nothing is lost, and the inbox still gets at most one mail per kind per window.
 *
 * Transport: the application's own mailer, deliberately not the database outbox — the alert that
 * matters most is the one saying the database is unreachable, and it must not depend on it.
 * Free, no third party, no secret beyond the SMTP settings the app already has.
 */

/** The most routes one group lists. */
export const MAX_ROUTES_PER_GROUP = 5;

/** The most groups tracked at once; the least recently mailed is forgotten beyond it. */
export const MAX_GROUPS = 200;

/** How often the summary pass runs. */
export const FLUSH_EVERY_MS = 60_000;

/** What the grouping layer needs from the notifier behind it. */
export interface AlertSink {
  readonly enabled: boolean;
  notify(kind: string, facts?: AlertFacts): Promise<AlertOutcome>;
}

interface Group {
  mailedAt: number;
  held: number;
  readonly routes: Set<string>;
}

const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f-]{8,}|[0-9a-f]{16,}|[A-Za-z0-9_-]{24,})$/iu;

/** A request path as a pattern: no query, id-like segments as `:id`, at most 200 characters. */
export function routePattern(route: string): string {
  const path = route.split('?')[0] ?? '';
  return path
    .split('/')
    .map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment))
    .join('/')
    .slice(0, 200);
}

export interface GroupedAlertNotifierOptions {
  readonly now?: () => number;
  readonly windowMs?: number;
}

export class GroupedAlertNotifier implements AlertSink {
  private readonly groups = new Map<string, Group>();
  private readonly now: () => number;
  private readonly windowMs: number;

  constructor(
    private readonly inner: AlertSink,
    options: GroupedAlertNotifierOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.windowMs = options.windowMs ?? ALERT_WINDOW_MS;
  }

  get enabled(): boolean {
    return this.inner.enabled;
  }

  /** Record one occurrence; mail it when it opens a new window for its kind. Never throws. */
  async notify(rawKind: string, facts: AlertFacts = {}): Promise<AlertOutcome> {
    if (!this.enabled) return 'off';
    const kind = normaliseKind(rawKind);
    const route = facts.route === undefined ? undefined : routePattern(facts.route);
    const at = this.now();
    const group = this.groups.get(kind);
    if (group !== undefined && at - group.mailedAt < this.windowMs) {
      group.held += 1;
      if (route !== undefined && group.routes.size < MAX_ROUTES_PER_GROUP) group.routes.add(route);
      return 'throttled';
    }
    // A window that closed with occurrences the summary pass has not mailed yet: say so here.
    const carried = group !== undefined && group.held > 0 ? summarise(group) : undefined;
    this.track(kind, at);
    const detail = [facts.detail, carried].filter((part) => part !== undefined).join(' ');
    const { route: _raw, detail: _given, ...rest } = facts;
    return this.send(kind, {
      ...rest,
      ...(route === undefined ? {} : { route }),
      ...(detail === '' ? {} : { detail }),
    });
  }

  /** Mail one summary per group whose window closed with occurrences held back. */
  async flush(): Promise<number> {
    if (!this.enabled) return 0;
    const at = this.now();
    let sent = 0;
    for (const [kind, group] of [...this.groups]) {
      if (group.held === 0 || at - group.mailedAt < this.windowMs) continue;
      const detail = summarise(group);
      this.track(kind, at);
      await this.send(kind, { detail });
      sent += 1;
    }
    return sent;
  }

  /** Run {@link flush} every `everyMs`; the timer never keeps the process alive. */
  start(everyMs: number = FLUSH_EVERY_MS): () => void {
    const timer = setInterval(() => void this.flush(), everyMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  private track(kind: string, at: number): void {
    // Re-inserted so the Map's order is least-recently-mailed first, which is what the cap evicts.
    this.groups.delete(kind);
    this.groups.set(kind, { mailedAt: at, held: 0, routes: new Set() });
    while (this.groups.size > MAX_GROUPS) {
      const oldest = this.groups.keys().next().value;
      if (oldest === undefined) break;
      this.groups.delete(oldest);
    }
  }

  private async send(kind: string, facts: AlertFacts): Promise<AlertOutcome> {
    try {
      return await this.inner.notify(kind, facts);
    } catch {
      return 'failed';
    }
  }
}

function summarise(group: Group): string {
  const routes = [...group.routes];
  const where = routes.length > 0 ? ` Routes: ${routes.join(', ')}.` : '';
  return `${String(group.held)} more occurrence(s) since the last alert of this kind.${where}`;
}

/**
 * The process's grouped notifier: the plain notifier with its own window switched off (the
 * grouping layer owns the window), and the summary pass started unless `flushEveryMs` is 0.
 */
export function createGroupedAlertNotifier(
  recipients: readonly string[],
  mailer: Mailer | null,
  options: { readonly flushEveryMs?: number } = {},
): GroupedAlertNotifier {
  const grouped = new GroupedAlertNotifier(new AlertNotifier({ recipients, mailer, windowMs: 0 }));
  const every = options.flushEveryMs ?? FLUSH_EVERY_MS;
  if (grouped.enabled && every > 0) grouped.start(every);
  return grouped;
}
