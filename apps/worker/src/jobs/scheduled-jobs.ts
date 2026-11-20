/**
 * GROWTH-FIX — the recurring jobs both hosts run, defined once.
 *
 * The standalone worker (`main.ts`, `runScheduledJobLoop`) and the single Hostinger app
 * (`apps/server/scheduled-sweeps.mjs`, `startScheduledJobs`) build their jobs from this one list,
 * so a job added here runs on both and cannot be forgotten on one (the 2026-11-20 defect: the
 * growth rollup and eleven other loops existed only in `main.ts`, and live never ran them).
 *
 * Every job runs under the named sweep lock of its `name` in both hosts (ENGINEERING-STANDARD
 * AS-4 / RT-3), so two processes on one database never run it at once. Each `run` is one bounded
 * pass; jobs with a schedule (nightly, or "on boot when stale") check it inside the pass, against
 * state in the database, so the check and the work sit under the same lock. A pass resolves the
 * log line worth printing, or `null` when nothing moved (LOGQUIET-a).
 */
import {
  composeMonthlyGtmReport,
  composeSecurityAlertDigest,
  deriveTrialLinkKey,
} from '@tmanage/mail';
import type { Mailer } from '@tmanage/mail';
import { createFieldCipher, loadFieldCipherKeyring } from '@tmanage/domain/field-cipher';
import type { SweepLock } from '../common/database/sweep-lock.js';
import type { WorkerDatabase } from '../common/database/worker-database.js';
import { createApprovalChainStore } from '../common/database/approval-chain-store.js';
import { createAuditAnchorStore } from '../common/database/audit-anchor-store.js';
import { createCampaignStore } from '../common/database/campaign-store.js';
import { createEinvoiceChainStore } from '../common/database/einvoice-chain-store.js';
import { createFinanceFactsStore } from '../common/database/finance-facts-store.js';
import { createRotationStore } from '../common/database/field-cipher-rotation-store.js';
import { createGrowthRollupStore } from '../common/database/growth-rollup-store.js';
import { createIpLookupSweepStore } from '../common/database/ip-lookup-sweeper-store.js';
import { createNotificationDigestStore } from '../common/database/notification-digest-store.js';
import { createSecurityReportPurgeStore } from '../common/database/security-report-purge-store.js';
import { createSecuritySignalStore } from '../common/database/security-signal-store.js';
import { createTimerAutostopStore } from '../common/database/timer-autostop-store.js';
import { DigestMailer } from '../notifications/digest-mailer.js';
import { CAMPAIGN_TICK_MS, runCampaignPass } from '../outreach/campaign-sender.js';
import { createCampaignTransport } from '../outreach/campaign-transport.js';
import type { CampaignTransportEnv } from '../outreach/campaign-transport.js';
import { createOffsiteBackupJob } from '../backup/offsite-backup.js';
import type { OffsiteBackupEnv } from '../backup/backup-config.js';
import {
  APPROVAL_CHAIN_TICK_MS,
  approvalChainWalkDue,
  recordSignatureCheckFromEnv,
  runApprovalChainWalk,
} from './approval-chain-walk.js';
import {
  AUDIT_ANCHOR_INTERVAL_MS,
  anchorSignerFromEnv,
  runAuditBackfill,
  runDailyAnchors,
} from './audit-anchor.js';
import {
  EINVOICE_CHAIN_TICK_MS,
  chainCheckDue,
  runEinvoiceChainReconcile,
} from './einvoice-chain-reconciler.js';
import { ROTATION_INTERVAL_MS, runKeyRotation } from './field-cipher-rotation.js';
import {
  FINANCE_FACTS_TICK_MS,
  financeFactsDue,
  runFinanceFactsRebuild,
} from './finance-facts-rebuild.js';
import { GROWTH_TICK_MS, growthRunDue, runGrowthRollup } from './growth-rollup.js';
import { IP_LOOKUP_SWEEP_INTERVAL_MS, sweepIpLookups } from './ip-lookup-sweeper.js';
import { DIGEST_INTERVAL_MS, sweepNotificationDigests } from './notification-digest.js';
import { SECURITY_DETECTOR_INTERVAL_MS, runSecurityDetector } from './security-detector.js';
import {
  SECURITY_REPORT_PURGE_INTERVAL_MS,
  purgeSecurityReports,
} from './security-report-purge.js';
import { AUTOSTOP_INTERVAL_MS, sweepForgottenTimers } from './timer-autostop.js';

/** One recurring job: a bounded pass, its cadence and the lock it runs under. */
export interface ScheduledJob {
  /** The sweep lock name, and the name in the logs. */
  readonly name: string;
  readonly intervalMs: number;
  /** One pass; resolves the line to log, or `null` when nothing moved. */
  run(): Promise<string | null>;
}

/** The mail a host has: the alert transport, and the notification transport per template key. */
export interface ScheduledJobMail {
  readonly alerts: Mailer | null;
  notice(templateKey: string): Mailer | null;
}

/** The environment the jobs read (the parsed `loadEnv()` result satisfies it). */
export interface ScheduledJobEnv extends OffsiteBackupEnv, CampaignTransportEnv {
  readonly WEB_PUBLIC_URL: string;
  readonly ALERT_EMAILS?: string | undefined;
  readonly AUDIT_ANCHOR_KEY?: string | undefined;
  readonly FIELD_CIPHER_KEYS?: string | undefined;
  readonly GEOIP_RETENTION_DAYS?: number | undefined;
}

export const SCHEDULED_JOB_NAMES = [
  'timer-autostop',
  'audit-anchors',
  'security-detector',
  'key-rotation',
  'security-report-purge',
  'ip-lookup-sweep',
  'notification-digest',
  'growth-rollup',
  'finance-facts',
  'einvoice-chain',
  'approval-chain',
  'campaign-sender',
  'offsite-backup',
] as const;

export function alertEmailsOf(raw: string | undefined): readonly string[] {
  return (raw ?? '')
    .split(',')
    .map((address) => address.trim())
    .filter((address) => address.includes('@'));
}

/** Every recurring job of {@link SCHEDULED_JOB_NAMES}, bound to one pool and one host's mail. */
export function createScheduledJobs(
  database: WorkerDatabase,
  env: ScheduledJobEnv,
  mail: ScheduledJobMail,
): readonly ScheduledJob[] {
  const alertEmails = alertEmailsOf(env.ALERT_EMAILS);
  const signer = anchorSignerFromEnv(env);
  if (signer.status !== 'configured') {
    console.warn(`[worker] AUDIT_ANCHOR_KEY is ${signer.status}: audit anchors are unsigned`);
  }
  const anchors = createAuditAnchorStore(database);
  const growth = createGrowthRollupStore(database);
  const finance = createFinanceFactsStore(database);
  const einvoice = createEinvoiceChainStore(database);
  const approval = createApprovalChainStore(database);
  const rotation = {
    store: createRotationStore(database),
    cipher: createFieldCipher(loadFieldCipherKeyring(env)),
  };
  const timers = createTimerAutostopStore(database);
  const signals = createSecuritySignalStore(database);
  const reports = createSecurityReportPurgeStore(database);
  const ipLookups = createIpLookupSweepStore(database);
  const digests = createNotificationDigestStore(database);
  const digestMailer = new DigestMailer(mail.notice('digest'), env.WEB_PUBLIC_URL);
  // LANE-Q: the outreach sender's own stack (person mailboxes, unsubscribe headers), from env.
  const campaignSecret = (env.SESSION_SECRET ?? '').trim();
  const campaignMailer = createCampaignTransport(database, env);
  const campaigns = createCampaignStore(database);
  let campaignIdleSaid = false;

  const jobs: ScheduledJob[] = [
    {
      name: 'timer-autostop',
      intervalMs: AUTOSTOP_INTERVAL_MS,
      run: async () => {
        const r = await sweepForgottenTimers(timers, new Date());
        return r.stopped > 0 ? `auto-stopped ${String(r.stopped)} forgotten timer(s)` : null;
      },
    },
    {
      name: 'audit-anchors',
      intervalMs: AUDIT_ANCHOR_INTERVAL_MS,
      run: async () => {
        const started = await runAuditBackfill(anchors);
        const r = await runDailyAnchors({ store: anchors, signer, now: new Date() });
        return r.anchored > 0 || started > 0
          ? `${String(started)} chain start(s), anchors for ${r.day}: ${String(r.anchored)}`
          : null;
      },
    },
    {
      name: 'security-detector',
      intervalMs: SECURITY_DETECTOR_INTERVAL_MS,
      run: async () => {
        const r = await runSecurityDetector({
          store: signals,
          mailer: mail.alerts,
          alertEmails,
          composeDigest: composeSecurityAlertDigest,
        });
        return r.mailed > 0 ? `${String(r.mailed)} alert mail(s) sent` : null;
      },
    },
    {
      name: 'key-rotation',
      intervalMs: ROTATION_INTERVAL_MS,
      run: async () => {
        const lines: string[] = [];
        const r = await runKeyRotation({ ...rotation, maxBatches: 20, log: (l) => lines.push(l) });
        return r.status === 'idle' ? null : lines.join('; ') || `rotation ${r.status}`;
      },
    },
    {
      name: 'security-report-purge',
      intervalMs: SECURITY_REPORT_PURGE_INTERVAL_MS,
      run: async () => {
        const r = await purgeSecurityReports({ store: reports });
        return r.deleted > 0 ? `${String(r.deleted)} row(s) removed` : null;
      },
    },
    {
      name: 'ip-lookup-sweep',
      intervalMs: IP_LOOKUP_SWEEP_INTERVAL_MS,
      run: async () => {
        const r = await sweepIpLookups({
          store: ipLookups,
          ...(env.GEOIP_RETENTION_DAYS === undefined
            ? {}
            : { retentionDays: env.GEOIP_RETENTION_DAYS }),
        });
        return r.deleted > 0 ? `${String(r.deleted)} row(s) removed` : null;
      },
    },
    {
      name: 'notification-digest',
      intervalMs: DIGEST_INTERVAL_MS,
      run: async () => {
        const r = await sweepNotificationDigests(digests, digestMailer, new Date(), (error) =>
          console.error('[worker] notification digest: one member failed', error),
        );
        return r.sent > 0 || r.failed > 0
          ? `${String(r.sent)} digest(s) sent, ${String(r.failed)} failed`
          : null;
      },
    },
    {
      name: 'growth-rollup',
      intervalMs: GROWTH_TICK_MS,
      run: async () => {
        const now = new Date();
        if (!growthRunDue(await growth.lastComputedAt(), now)) return null;
        const r = await runGrowthRollup({
          store: growth,
          mailer: mail.alerts,
          alertEmails,
          composeReport: composeMonthlyGtmReport,
          now: () => now,
        });
        return `${String(r.rows)} row(s) written, ${String(r.deleted)} removed, report to ${String(r.reportSentTo)}`;
      },
    },
    {
      name: 'finance-facts',
      intervalMs: FINANCE_FACTS_TICK_MS,
      run: async () => {
        const now = new Date();
        if (!financeFactsDue(await finance.lastComputedAt(), now)) return null;
        const r = await runFinanceFactsRebuild({ store: finance, now: () => now });
        return `${String(r.organizations)} organization(s), ${String(r.rows)} row(s), ${String(r.failed)} failed`;
      },
    },
    {
      name: 'einvoice-chain',
      intervalMs: EINVOICE_CHAIN_TICK_MS,
      run: async () => {
        const now = new Date();
        if (!chainCheckDue(await einvoice.latestCheckedAt(), now)) return null;
        const r = await runEinvoiceChainReconcile({ store: einvoice, now: () => now });
        return `${String(r.organizations)} organization(s), ${String(r.ok)} ok, ${String(r.broken)} broken, ${String(r.failed)} failed`;
      },
    },
    {
      name: 'approval-chain',
      intervalMs: APPROVAL_CHAIN_TICK_MS,
      run: async () => {
        const now = new Date();
        if (!approvalChainWalkDue(await approval.latestCheckedAt(), now)) return null;
        const r = await runApprovalChainWalk({
          store: approval,
          verifySignature: recordSignatureCheckFromEnv(env),
          now: () => now,
        });
        return `${String(r.organizations)} organization(s), ${String(r.ok)} ok, ${String(r.broken)} broken, ${String(r.failed)} failed`;
      },
    },
    {
      name: 'campaign-sender',
      intervalMs: CAMPAIGN_TICK_MS,
      run: async () => {
        if (campaignMailer === null || campaignSecret === '' || !rotation.cipher.enabled) {
          if (campaignIdleSaid) return null;
          campaignIdleSaid = true;
          return 'idle: needs SESSION_SECRET, FIELD_CIPHER_KEYS and a mail driver (SMTP_HOST + SMTP_PASSWORD)';
        }
        const r = await runCampaignPass({
          store: campaigns,
          cipher: rotation.cipher,
          trialKey: deriveTrialLinkKey(campaignSecret),
          mailer: campaignMailer,
          webPublicUrl: env.WEB_PUBLIC_URL,
          // Read per pass, so the address set in hPanel applies without a rebuild.
          postalAddress: () => process.env['CAMPAIGN_POSTAL_ADDRESS'] ?? '',
        });
        return r.sent + r.failed + r.suppressed > 0
          ? `${String(r.sent)} sent, ${String(r.failed)} failed, ${String(r.suppressed)} suppressed`
          : null;
      },
    },
    createOffsiteBackupJob(env),
  ];
  return jobs;
}

/**
 * The standalone worker's loop for one job: a pass now, then one every `intervalMs`, under the
 * job's named lock (the same name the single app takes), until `signal` aborts.
 */
export async function runScheduledJobLoop(
  job: ScheduledJob,
  signal: AbortSignal,
  lock?: Pick<SweepLock, 'run'>,
  log: (line: string) => void = (line) => console.warn(line),
  onError: (error: unknown) => void = (error) =>
    console.error(`[worker] ${job.name} failed`, error),
): Promise<void> {
  while (!signal.aborted) {
    try {
      const outcome = lock
        ? await lock.run(job.name, job.run)
        : { ran: true, result: await job.run() };
      if (outcome.ran && outcome.result !== null) log(`[worker] ${job.name}: ${outcome.result}`);
    } catch (error) {
      onError(error);
    }
    if (signal.aborted) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, job.intervalMs);
      signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
    });
  }
}
