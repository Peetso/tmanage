import { createHash, createHmac } from 'node:crypto';
import { parseFieldCipherKeys } from '@tmanage/domain/field-cipher';

/**
 * 56-11 — the audit chain's worker jobs (0261).
 *
 * - **Backfill (`audit.chain.backfill`)** marks the chain start for every organization that has no
 *   `audit_heads` row yet: chain position 0, the organization's genesis hash, and the newest
 *   pre-chain `audit_events` id as `legacy_last_event_id`. No audit row is rewritten (the 0002
 *   triggers refuse that); the legacy prefix stays unhashed and is reported as such.
 * - **Daily anchor (`audit.anchor.daily`)** writes one `audit_anchors` row per organization for the
 *   previous UTC day (the head as of the first run after that day ended), and one
 *   `platform_audit_anchors` row whose root hashes that day's organization anchors. Both are
 *   `INSERT IGNORE` on their day key, so an hourly loop anchors each day exactly once.
 *
 * Signatures use `AUDIT_ANCHOR_KEY` (56-02 keyring format). No key → rows are written with
 * `signature = NULL` and one log line says so; the job never fails for want of a key. The format
 * is the API verifier's (`modules/audit/audit-anchor-signer.ts`); both tests pin one golden vector.
 */

export const AUDIT_ANCHOR_INTERVAL_MS = 60 * 60 * 1000;
export const BACKFILL_BATCH = 500;

export interface AuditHeadSnapshot {
  readonly organizationId: string;
  readonly chainSeq: number;
  readonly headHash: string;
}

export interface AuditAnchorStore {
  /** Organizations with no `audit_heads` row, oldest id first. */
  organizationsWithoutHead(limit: number): Promise<readonly string[]>;
  /** Insert the chain-start head (no-op if one appeared meanwhile). */
  markChainStart(organizationId: string, genesis: string): Promise<void>;
  heads(): Promise<readonly AuditHeadSnapshot[]>;
  /** `INSERT IGNORE` on `(organization_id, day)`; true when a row was written. */
  insertAnchor(anchor: AnchorRecord): Promise<boolean>;
  anchorsForDay(day: string): Promise<readonly AnchorRecord[]>;
  insertPlatformAnchor(anchor: PlatformAnchorRecord): Promise<boolean>;
}

export interface AnchorRecord {
  readonly organizationId: string;
  readonly day: string;
  readonly headHash: string;
  readonly eventCount: number;
  readonly signature: string | null;
}

export interface PlatformAnchorRecord {
  readonly day: string;
  readonly rootHash: string;
  readonly orgCount: number;
  readonly signature: string | null;
}

/** Keys sorted at every depth — the same canonical form as the API's `audit-chain.ts`. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function genesisHash(organizationId: string): string {
  return sha256Hex(`tmanage.audit.genesis:${organizationId}`);
}

export function anchorMessage(anchor: Omit<AnchorRecord, 'signature'>): string {
  return canonicalJson([
    'tmanage.audit.anchor.v1',
    anchor.organizationId,
    anchor.day,
    anchor.headHash,
    anchor.eventCount,
  ]);
}

export function platformRootHash(day: string, anchors: readonly AnchorRecord[]): string {
  const leaves = [...anchors]
    .sort((a, b) => (a.organizationId < b.organizationId ? -1 : 1))
    .map((a) => [a.organizationId, a.headHash, a.eventCount]);
  return sha256Hex(canonicalJson(['tmanage.audit.platform-root.v1', day, leaves]));
}

export function platformAnchorMessage(anchor: Omit<PlatformAnchorRecord, 'signature'>): string {
  return canonicalJson([
    'tmanage.audit.platform-anchor.v1',
    anchor.day,
    anchor.rootHash,
    anchor.orgCount,
  ]);
}

export interface AnchorSigning {
  readonly status: 'configured' | 'absent' | 'invalid';
  sign(message: string): string | null;
}

export function anchorSignerFromEnv(env: {
  readonly AUDIT_ANCHOR_KEY?: string | undefined;
}): AnchorSigning {
  const raw = env.AUDIT_ANCHOR_KEY;
  if (raw === undefined || raw.trim() === '') return { status: 'absent', sign: () => null };
  try {
    const { active } = parseFieldCipherKeys(raw);
    return {
      status: 'configured',
      sign: (message) =>
        `v1:${active.id}:${createHmac('sha256', active.key).update(message, 'utf8').digest('hex')}`,
    };
  } catch {
    return { status: 'invalid', sign: () => null };
  }
}

/** The UTC calendar day before `now`, `YYYY-MM-DD`. */
export function previousUtcDay(now: Date): string {
  return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function runAuditBackfill(store: AuditAnchorStore): Promise<number> {
  let marked = 0;
  for (;;) {
    const organizations = await store.organizationsWithoutHead(BACKFILL_BATCH);
    for (const organizationId of organizations) {
      await store.markChainStart(organizationId, genesisHash(organizationId));
      marked += 1;
    }
    if (organizations.length < BACKFILL_BATCH) return marked;
  }
}

export interface DailyAnchorResult {
  readonly day: string;
  readonly anchored: number;
  readonly platformAnchored: boolean;
  readonly signed: boolean;
}

export async function runDailyAnchors(deps: {
  readonly store: AuditAnchorStore;
  readonly signer: AnchorSigning;
  readonly now: Date;
}): Promise<DailyAnchorResult> {
  const { store, signer } = deps;
  const day = previousUtcDay(deps.now);
  let anchored = 0;
  for (const head of await store.heads()) {
    const fields = {
      organizationId: head.organizationId,
      day,
      headHash: head.headHash,
      eventCount: head.chainSeq,
    };
    if (await store.insertAnchor({ ...fields, signature: signer.sign(anchorMessage(fields)) })) {
      anchored += 1;
    }
  }
  const dayAnchors = await store.anchorsForDay(day);
  let platformAnchored = false;
  if (dayAnchors.length > 0) {
    const root = { day, rootHash: platformRootHash(day, dayAnchors), orgCount: dayAnchors.length };
    platformAnchored = await store.insertPlatformAnchor({
      ...root,
      signature: signer.sign(platformAnchorMessage(root)),
    });
  }
  return { day, anchored, platformAnchored, signed: signer.status === 'configured' };
}
