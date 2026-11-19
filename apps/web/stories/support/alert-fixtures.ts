import { SIGNAL_RULES, SIGNAL_RULE_KEYS } from '@tmanage/domain';
import { ApiClient } from '../../src/lib/api/client';
import type { SignalSettingsView } from '../../src/lib/api/signals';

/**
 * 62-27 (B12) — Settings → Alerts as the server answers it, for the story and
 * `tests/alert-settings-screen.test.tsx`. Every unit, limit, default and recipient list is the
 * domain catalogue's (the server's source), never a value typed here; the frame's sample (Unusual
 * expense off) is applied on top.
 */

export const ALERTS_DEFAULT: SignalSettingsView = {
  rules: SIGNAL_RULE_KEYS.map((key) => {
    const rule = SIGNAL_RULES[key];
    return {
      rule: key,
      enabled: key !== 'unusual_expense',
      threshold: rule.threshold.defaultValue,
      recipient: rule.defaultRecipient,
      unit: rule.threshold.unit,
      min: rule.threshold.min,
      max: rule.threshold.max,
      recipients: rule.recipients,
      money: rule.money,
    };
  }),
};

export interface AlertRoutes {
  /** `null` = the 404 (flag off); `403` = not the owner. */
  readonly settings?: SignalSettingsView | null | 403 | 'pending';
}

function reply(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}

const ERROR = (code: string, status: number) =>
  reply({ error: { code, message: 'Something went wrong.', correlationId: 'c' } }, status);

/** An `ApiClient` answering the alert rules read; a PUT is recorded and answered as saved. */
export function alertsClient(
  routes: AlertRoutes = {},
  writes: { path: string; body: unknown }[] = [],
): ApiClient {
  let current = routes.settings === undefined ? ALERTS_DEFAULT : routes.settings;
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = url.pathname.replace('/v1/organizations/northstar', '');
    if (path === '/insights/signal-settings') {
      if (current === 'pending') return new Promise<Response>(() => undefined);
      if (current === 403) return ERROR('forbidden', 403);
      if (current === null) return ERROR('not_found', 404);
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as {
          rules: { rule: string; enabled: boolean; threshold: number; recipient: string }[];
        };
        writes.push({ path, body });
        const saved = current;
        current = {
          rules: saved.rules.map((rule) => {
            const next = body.rules.find((r) => r.rule === rule.rule);
            return next === undefined
              ? rule
              : {
                  ...rule,
                  enabled: next.enabled,
                  threshold: next.threshold,
                  recipient: next.recipient as typeof rule.recipient,
                };
          }),
        };
        return reply(current);
      }
      return reply(current);
    }
    return reply({});
  }) as typeof globalThis.fetch;

  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-story',
  });
}
