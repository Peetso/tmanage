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
// 51-13a. The grouped notifier the in-process worker uses (one mail + one summary per kind per window).
export { createGroupedAlertNotifier } from './common/observability/error-groups.js';
// The API's two job passes (`sweep:once`, `reconcile:once`), so the one process runs them on a
// timer instead of cron: the tokens resolve them from the in-process application, the describe
// functions print the same report line the standalone passes print.
export { UPLOAD_SESSION_SWEEPER, USAGE_RECONCILER } from './common/http/tokens.js';
export { describeSweep } from './modules/files/upload-session-sweeper.js';
export type { SweepReport, UploadSessionSweeper } from './modules/files/upload-session-sweeper.js';
export { describeReconciliation } from './modules/files/usage-reconciler.js';
export type { ReconciliationReport, UsageReconciler } from './modules/files/usage-reconciler.js';
// R4 slice 3. The preview job runs on its own in-process timer (`WORKER_INPROCESS=1`, beside the
// scan job); its token and report line are here so the one process can drive or log a pass.
export { PREVIEW_JOB, describePreviewPass } from './modules/files/preview-job.js';
export type { PreviewJob, PreviewReport } from './modules/files/preview-job.js';
// R4 follow-up. The orphan-preview sweep, hourly beside the reconciler in the one process.
export {
  PREVIEW_ORPHAN_SWEEPER,
  describeOrphanSweep,
} from './modules/files/preview-orphan-sweeper.js';
export type {
  OrphanSweepReport,
  PreviewOrphanSweeper,
} from './modules/files/preview-orphan-sweeper.js';
// R17-e (53-09). The recurrence spawner, on the minute tick beside the upload-session sweep (the
// pass returns at once unless 15 minutes passed since its last run).
export {
  RECURRENCE_SPAWNER,
  describeRecurrenceSweep,
} from './modules/work/recurrence-spawner.service.js';
export type {
  RecurrenceSpawnReport,
  RecurrenceSpawner,
} from './modules/work/recurrence-spawner.service.js';
