import type { IntegrationConnectionRow } from '../../common/database/schema.js';
import type { IntegrationCatalogService } from './catalog.service.js';
import type { ConnectionHealthView } from './connection-health.controller.js';

/**
 * Automations connection health (module 17, x220) — a deterministic, in-app validity check over the
 * `integration_connections` a studio already recorded (x165). No new table, and — the Known-trap —
 * **no outbound network call**: a real ping to Slack/GitHub/… is external and paid (Needs-Peter).
 * This service only reasons over data already in hand: is the catalog app still known, are the
 * required non-secret config keys present, and is the connection live (`connected`) rather than a
 * `pending` intent.
 *
 * The verdict never carries a config *value* — only the *names* of the required keys found missing,
 * which are code-defined here and absent by definition — so no stored setting (and no secret, though
 * x165 stores none) can leak through the health projection.
 */

/**
 * The non-secret config key each catalog app needs to be considered configured. Code-defined and
 * deterministic: the check is over presence, never over a live credential exchange. An app absent
 * from this map has no required key, so a connection to it is never flagged for missing config.
 */
const REQUIRED_CONFIG_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  slack: Object.freeze(['channel']),
  'google-calendar': Object.freeze(['calendarId']),
  github: Object.freeze(['repository']),
  zapier: Object.freeze(['hookPath']),
});

/** Machine-readable health issue codes. Descriptive, never a stored value. */
export type ConnectionHealthIssue = 'unknown_app' | 'missing_config' | 'not_connected';

/** A config key counts as present only when it exists with a non-empty, defined value. */
function hasValue(
  config: Readonly<Record<string, string | number | boolean>>,
  key: string,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(config, key)) return false;
  const value = config[key];
  if (value === undefined) return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  return true;
}

export class ConnectionHealthService {
  constructor(private readonly catalog: IntegrationCatalogService) {}

  /**
   * Compute the health verdict for one connection row. Pure and deterministic over the row and the
   * code-defined catalog; performs no I/O. The returned view carries the connection's identity, its
   * status, the boolean verdict, the issue codes, and the *names* of any missing required keys — and
   * deliberately no config values.
   */
  evaluate(row: IntegrationConnectionRow): ConnectionHealthView {
    const issues: ConnectionHealthIssue[] = [];

    const known = this.catalog.findById(row.appId) !== null;
    if (!known) issues.push('unknown_app');

    const required = REQUIRED_CONFIG_KEYS[row.appId] ?? [];
    const missingConfigKeys = required.filter((key) => !hasValue(row.configJson, key));
    if (missingConfigKeys.length > 0) issues.push('missing_config');

    if (row.status !== 'connected') issues.push('not_connected');

    return {
      connectionId: row.id,
      appId: row.appId,
      label: row.label,
      status: row.status,
      healthy: issues.length === 0,
      issues,
      missingConfigKeys,
    };
  }
}
