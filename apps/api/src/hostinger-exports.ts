/**
 * The surface the single-process Hostinger server (`apps/server`) imports.
 *
 * `main.ts` is the standalone API process; the Hostinger bundle runs the *same* composed
 * application inside one Node process that also serves the Next.js web app, so it needs the
 * same three building blocks `main.ts` wires together — the composed module, the Fastify
 * adapter with its part parser and trusted-proxy stance, and the two request-admission
 * helpers — plus the migrator, so the one process can apply the schema on start before it
 * accepts a request.
 *
 * It is a named subpath export (`@tmanage/api/hostinger`) rather than a widening of the
 * package's default entry: nothing that imports `@tmanage/api` today gains a new surface,
 * and the composition root still cannot be reached except deliberately, by this name.
 *
 * Every symbol here is already public within the package and already exercised by the API's
 * own tests; this file re-exports, it does not define.
 */

export { composeAppModule } from './app-composition.js';
export { createFastifyAdapter } from './common/http/fastify-adapter.js';
export { corsOptions } from './common/http/cors.js';
export { createFixedWindowLimiter } from './common/http/rate-limiter.js';
export { serializeForLog } from './common/observability/logger.js';
export { migrateOnStart } from './common/database/migrate-on-start.js';
export { MigrationError } from './common/database/migrator.js';
export type { MigrateReport } from './common/database/migrator.js';
// C10. Operator alerts, so the in-process worker's job failures mail the same `ALERT_EMAILS`.
export { createAlertNotifier, parseAlertEmails } from './common/observability/alerts.js';
// The API's two job passes (`sweep:once`, `reconcile:once`), so the one process runs them on a
// timer instead of cron: the tokens resolve them from the in-process application, the describe
// functions print the same report line the standalone passes print.
export { UPLOAD_SESSION_SWEEPER, USAGE_RECONCILER } from './common/http/tokens.js';
export { describeSweep } from './modules/files/upload-session-sweeper.js';
export type { SweepReport, UploadSessionSweeper } from './modules/files/upload-session-sweeper.js';
export { describeReconciliation } from './modules/files/usage-reconciler.js';
export type { ReconciliationReport, UsageReconciler } from './modules/files/usage-reconciler.js';
