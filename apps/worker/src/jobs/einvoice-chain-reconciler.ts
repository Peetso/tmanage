/**
 * 52-12 (R22-b) — the nightly e-invoice chain reconciler (migration 0314, `einvoice_chain_checks`).
 *
 * Nightly at 03:00 UTC (after the 02:30 finance facts), and on boot when the newest `checked_at` is
 * older than 26 hours (the `finance-facts-rebuild.ts` loop pattern), every `zatca` organization's
 * ICV/PIH chain — `client_invoices` and `client_credit_notes`, one chain across both tables — is
 * walked in ICV order. The worker checks LINK integrity only: icv 1 carries the genesis PIH, every
 * next icv is the previous + 1, every PIH equals the previous document's XML hash, and no two
 * documents share an XML hash. The XML rebuild-and-compare is NOT done here (the UBL input mapping
 * lives in the API's einvoice-rules.ts; the per-document `hashMatches` of the einvoice route is that
 * check — stated). A break is reported, never repaired: one verdict row per organization per night
 * and, on `broken`, one `security_signals` row (`einvoice_chain_break`, high) whose dedupe key makes
 * the same break on the next night increment `count` instead of adding a row. Verdicts older than
 * 90 days are pruned. Logs carry counts only — never a hash, never an amount. This file holds no
 * SQL; `common/database/einvoice-chain-store.ts` does.
 */
import { createHash } from 'node:crypto';
import { uuidv7 } from '@tmanage/domain';
import { sourceHash } from './security-detector.js';

export const EINVOICE_CHAIN_RUN_HOUR_UTC = 3;
export const EINVOICE_CHAIN_RUN_MINUTE_UTC = 0;
export const EINVOICE_CHAIN_STALE_MS = 26 * 60 * 60 * 1000;
export const EINVOICE_CHAIN_TICK_MS = 15 * 60 * 1000;
export const EINVOICE_CHAIN_RETENTION_DAYS = 90;
export const EINVOICE_CHAIN_RULE_KEY = 'einvoice_chain_break';

const DAY_MS = 86_400_000;

/**
 * SHA-256 hex of '0' — the PIH of icv 1. Recomputed here because one app may not import another's
 * `src/`; the API's `GENESIS_PIH` (einvoice-rules.ts) is the same two lines, and a test pins both
 * to the literal. Change both together.
 */
export const GENESIS_PIH = createHash('sha256').update('0', 'utf8').digest('hex');

export type ChainStatus = 'ok' | 'broken' | 'empty';
export type ChainBreakReason = 'gap' | 'pih_mismatch' | 'genesis_mismatch' | 'duplicate_hash';
export type ChainDocumentKind = 'invoice' | 'credit_note';

export interface ChainLink {
  readonly icv: number;
  readonly pih: string | null;
  readonly xmlHash: string | null;
  readonly kind: ChainDocumentKind;
  readonly id: string;
}

export interface ChainVerdict {
  readonly status: ChainStatus;
  readonly headIcv: number | null;
  readonly documents: number;
  readonly invoices: number;
  readonly creditNotes: number;
  readonly breakIcv: number | null;
  readonly reason: ChainBreakReason | null;
}

export interface EinvoiceChainCheck {
  readonly id: string;
  readonly organizationId: string;
  readonly checkedAt: Date;
  readonly status: ChainStatus;
  readonly headIcv: number | null;
  readonly documents: number;
  readonly breakIcv: number | null;
  readonly breakReason: ChainBreakReason | null;
  /** Counts only: `{ invoices, creditNotes }`. */
  readonly detail: Readonly<Record<string, number>>;
}

export interface ChainBreakSignal {
  readonly id: string;
  readonly organizationId: string;
  readonly ruleKey: typeof EINVOICE_CHAIN_RULE_KEY;
  readonly severity: 'high';
  readonly sourceHash: string;
  /** The first sighting's count; a repeat of the same break adds 1 to the stored row instead. */
  readonly count: 1;
  readonly breakIcv: number;
  readonly reason: ChainBreakReason;
  readonly seenAt: Date;
}

export interface EinvoiceChainStore {
  /** The newest `checked_at` across every organization, or `null` when the table is empty. */
  latestCheckedAt(): Promise<Date | null>;
  /** Organizations whose regime is `zatca`, or that hold any chained document. */
  zatcaOrganizations(): Promise<readonly string[]>;
  /** One organization's chained documents (both tables), ordered by icv, in one read transaction. */
  chainLinks(organizationId: string): Promise<readonly ChainLink[]>;
  insertCheck(check: EinvoiceChainCheck): Promise<void>;
  recordBreak(signal: ChainBreakSignal): Promise<void>;
  /** Deletes verdicts with `checked_at` before `before`. Returns the rows removed. */
  pruneBefore(before: Date): Promise<number>;
}

export interface EinvoiceChainDeps {
  readonly store: EinvoiceChainStore;
  readonly now?: () => Date;
}

export interface EinvoiceChainResult {
  readonly organizations: number;
  readonly ok: number;
  readonly broken: number;
  readonly empty: number;
  readonly failed: number;
  readonly pruned: number;
}

/** Due when never run, when the last run is over 26 h old, or once past tonight's 03:00 UTC. */
export function chainCheckDue(last: Date | null, now: Date): boolean {
  if (last === null) return true;
  if (now.getTime() - last.getTime() > EINVOICE_CHAIN_STALE_MS) return true;
  const tonight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    EINVOICE_CHAIN_RUN_HOUR_UTC,
    EINVOICE_CHAIN_RUN_MINUTE_UTC,
  );
  return last.getTime() < tonight && now.getTime() >= tonight;
}

/**
 * Walks the links in icv order (sorted again here, so a caller's order never matters) and reports
 * the FIRST break, at the link whose own fields disagree with the chain.
 */
export function verifyChain(links: readonly ChainLink[]): ChainVerdict {
  const sorted = [...links].sort((a, b) => a.icv - b.icv);
  const invoices = sorted.filter((link) => link.kind === 'invoice').length;
  const counts = { documents: sorted.length, invoices, creditNotes: sorted.length - invoices };
  const head = sorted.at(-1);
  if (head === undefined) {
    return { status: 'empty', headIcv: null, ...counts, breakIcv: null, reason: null };
  }
  const broken = (at: ChainLink, reason: ChainBreakReason): ChainVerdict => ({
    status: 'broken',
    headIcv: head.icv,
    ...counts,
    breakIcv: at.icv,
    reason,
  });
  const seen = new Set<string>();
  let previous: ChainLink | null = null;
  for (const link of sorted) {
    if (previous === null) {
      if (link.icv !== 1) return broken(link, 'gap');
      if (link.pih !== GENESIS_PIH) return broken(link, 'genesis_mismatch');
    } else {
      if (link.icv !== previous.icv + 1) return broken(link, 'gap');
      if (link.pih === null || link.pih !== previous.xmlHash) return broken(link, 'pih_mismatch');
    }
    if (link.xmlHash !== null) {
      if (seen.has(link.xmlHash)) return broken(link, 'duplicate_hash');
      seen.add(link.xmlHash);
    }
    previous = link;
  }
  return { status: 'ok', headIcv: head.icv, ...counts, breakIcv: null, reason: null };
}

export async function runEinvoiceChainReconcile(
  deps: EinvoiceChainDeps,
  onError: (organizationId: string, error: unknown) => void = (organizationId, error) =>
    console.error(`[worker] e-invoice chain check failed for ${organizationId}`, error),
): Promise<EinvoiceChainResult> {
  const now = (deps.now ?? (() => new Date()))();
  const organizations = await deps.store.zatcaOrganizations();
  const tally = { ok: 0, broken: 0, empty: 0, failed: 0 };
  for (const organizationId of organizations) {
    try {
      const verdict = verifyChain(await deps.store.chainLinks(organizationId));
      await deps.store.insertCheck({
        id: uuidv7(),
        organizationId,
        checkedAt: now,
        status: verdict.status,
        headIcv: verdict.headIcv,
        documents: verdict.documents,
        breakIcv: verdict.breakIcv,
        breakReason: verdict.reason,
        detail: { invoices: verdict.invoices, creditNotes: verdict.creditNotes },
      });
      if (verdict.status === 'broken' && verdict.breakIcv !== null && verdict.reason !== null) {
        await deps.store.recordBreak({
          id: uuidv7(),
          organizationId,
          ruleKey: EINVOICE_CHAIN_RULE_KEY,
          severity: 'high',
          sourceHash: sourceHash(`${organizationId}|${String(verdict.breakIcv)}|${verdict.reason}`),
          count: 1,
          breakIcv: verdict.breakIcv,
          reason: verdict.reason,
          seenAt: now,
        });
      }
      tally[verdict.status] += 1;
    } catch (error) {
      tally.failed += 1;
      onError(organizationId, error);
    }
  }
  const pruned = await deps.store.pruneBefore(
    new Date(now.getTime() - EINVOICE_CHAIN_RETENTION_DAYS * DAY_MS),
  );
  return { organizations: organizations.length, ...tally, pruned };
}

export async function runEinvoiceChainLoop(
  deps: EinvoiceChainDeps,
  signal: AbortSignal,
  onError: (error: unknown) => void = (error) =>
    console.error('[worker] e-invoice chain loop failed', error),
  tickMs = EINVOICE_CHAIN_TICK_MS,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const now = (deps.now ?? (() => new Date()))();
      if (chainCheckDue(await deps.store.latestCheckedAt(), now)) {
        const r = await runEinvoiceChainReconcile(deps);
        console.warn(
          `[worker] e-invoice chain: ${String(r.organizations)} organization(s), ` +
            `${String(r.ok)} ok, ${String(r.broken)} broken, ${String(r.empty)} empty, ` +
            `${String(r.failed)} failed, ${String(r.pruned)} pruned`,
        );
      }
    } catch (error) {
      onError(error);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, tickMs);
      signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
    });
  }
}
