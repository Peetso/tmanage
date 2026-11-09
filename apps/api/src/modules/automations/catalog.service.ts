/**
 * Automations app directory — the static, code-defined catalog (module 17, x165).
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Automations ("app directory"). The set of apps a studio
 * can connect to is a fixed product fact, not tenant data, so it lives in code rather than a table:
 * there is no per-org catalog and no write path to it. Live OAuth to these third parties is
 * out of scope (Needs-Peter — external, paid); this catalog only names what *could* be connected, and
 * the connection a studio records against a catalog entry (`integration_connections`, 0065) carries
 * non-secret settings only.
 *
 * The catalog is exposed as a frozen list so a caller cannot mutate it, and looked up by id so the
 * connection controller can reject an off-catalog `appId` with a 404 before any write.
 */

/**
 * One catalog app. `capabilities` are the integration's *own* capabilities (what it can do once
 * connected — e.g. `notify`, `calendar-sync`), not RBAC capabilities; they are descriptive strings
 * the directory screen renders. Not a `View`: this is an internal domain type the controller projects
 * into `IntegrationAppView`.
 */
export interface IntegrationCatalogApp {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly capabilities: readonly string[];
}

/**
 * The catalog itself — a small, fixed set spanning the categories the module map names. Slack and
 * Microsoft Teams were removed on 2026-11-10: a stored connection to them reads as `unknown_app`. Frozen so no
 * consumer can add to or reorder it at runtime; the ids are stable opaque handles a stored connection
 * references.
 */
const CATALOG: readonly IntegrationCatalogApp[] = Object.freeze([
  Object.freeze({
    id: 'google-calendar',
    name: 'Google Calendar',
    category: 'calendar',
    capabilities: Object.freeze(['calendar-sync']),
  }),
  Object.freeze({
    id: 'github',
    name: 'GitHub',
    category: 'developer',
    capabilities: Object.freeze(['issue-sync', 'webhook']),
  }),
  Object.freeze({
    id: 'zapier',
    name: 'Zapier',
    category: 'automation',
    capabilities: Object.freeze(['trigger', 'action']),
  }),
]) as readonly IntegrationCatalogApp[];

/**
 * The Automations catalog service — a stateless read over the code-defined list. No tenant, no
 * database: the catalog is the same for every studio.
 */
export class IntegrationCatalogService {
  /** The whole catalog, in its declared order. Frozen; a caller cannot mutate it. */
  list(): readonly IntegrationCatalogApp[] {
    return CATALOG;
  }

  /** Look one app up by id, or `null` if it is not in the catalog. Drives the off-catalog 404. */
  findById(appId: string): IntegrationCatalogApp | null {
    return CATALOG.find((app) => app.id === appId) ?? null;
  }
}
