import { createHash } from 'node:crypto';

/**
 * 56-11 — the audit hash chain, as pure functions. No I/O: the repository feeds rows in, the
 * writer and the verifier call the same {@link chainRowHash}, so what is written and what is
 * checked can never be two different canonical forms.
 *
 * ## Canonical form
 *
 * A JSON array in a fixed order, prefixed by a version tag:
 * `["tmanage.audit.v1", organization_id, id, created_at, actor_user_id, effective_actor_id,
 * action, object_type, object_id, result, metadata, chain_seq, prev_hash]`.
 * A JSON array is unambiguous — no value can smuggle a delimiter — and `metadata` is serialised
 * with its keys sorted at every depth, so the order MariaDB/MySQL happens to store JSON keys in
 * does not change the hash. `created_at` is the ISO-8601 instant to the millisecond (the column is
 * DATETIME(3), UTC session).
 *
 * ## Genesis
 *
 * The first chained row of an organization points at `GENESIS(org) = SHA-256("tmanage.audit.
 * genesis:" + org)`. Binding the genesis to the organization means one organization's chain can
 * never be spliced in front of another's.
 */

export const CHAIN_VERSION = 'tmanage.audit.v1';

export interface ChainableEvent {
  readonly organizationId: string;
  readonly id: string;
  readonly createdAt: Date;
  readonly actorUserId: string | null;
  readonly effectiveActorId: string | null;
  readonly action: string;
  readonly objectType: string;
  readonly objectId: string | null;
  readonly result: string;
  readonly metadataJson: unknown;
}

export interface ChainedEvent extends ChainableEvent {
  readonly chainSeq: number;
  readonly prevHash: string;
  readonly rowHash: string;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function genesisHash(organizationId: string): string {
  return sha256Hex(`tmanage.audit.genesis:${organizationId}`);
}

/** JSON with object keys sorted at every depth. `undefined` members are dropped, as JSON does. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // A non-finite number has no JSON form; `JSON.stringify` already writes `null` for it.
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${members.join(',')}}`;
}

/** The metadata column may arrive parsed or as the stored JSON text; hash the parsed value. */
function metadataValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function canonicalChainInput(
  event: ChainableEvent,
  chainSeq: number,
  prevHash: string,
): string {
  return canonicalJson([
    CHAIN_VERSION,
    event.organizationId,
    event.id,
    event.createdAt.toISOString(),
    event.actorUserId,
    event.effectiveActorId,
    event.action,
    event.objectType,
    event.objectId,
    event.result,
    metadataValue(event.metadataJson),
    chainSeq,
    prevHash,
  ]);
}

export function chainRowHash(event: ChainableEvent, chainSeq: number, prevHash: string): string {
  return sha256Hex(canonicalChainInput(event, chainSeq, prevHash));
}

/** Why a chain is not intact. Codes only — never a metadata value. */
export type ChainBreakReason =
  'missing_row' | 'prev_hash_mismatch' | 'row_hash_mismatch' | 'head_mismatch' | 'anchor_mismatch';

export interface ChainBreak {
  readonly reason: ChainBreakReason;
  /** The first row that does not verify, or the head's last event for a head/tail mismatch. */
  readonly eventId: string | null;
  readonly chainSeq: number;
}

export interface ChainHeadState {
  readonly chainSeq: number;
  readonly headHash: string;
  readonly lastEventId: string | null;
}

/**
 * The read-only verifier. Rows are pushed in `chain_seq` order (the repository pages them); the
 * first defect is kept and everything after it is only counted. Anchors (`event_count` →
 * `head_hash`) are checked as the walk passes their position.
 *
 * - an **edited** row no longer reproduces its `row_hash` → `row_hash_mismatch`;
 * - a **deleted** row leaves a gap in `chain_seq` → `missing_row` at the row after the gap;
 * - **reordered** rows break the `prev_hash` link → `prev_hash_mismatch`;
 * - a **truncated tail** (or a head rewritten to match) disagrees with `audit_heads` →
 *   `head_mismatch`; a chain rebuilt end to end disagrees with an earlier anchor →
 *   `anchor_mismatch`.
 */
export class ChainVerifier {
  private expectedSeq = 1;
  private expectedPrev: string;
  private checked = 0;
  private firstBreak: ChainBreak | null = null;
  private lastHash: string;
  private lastId: string | null = null;
  private anchorsChecked = 0;

  constructor(
    organizationId: string,
    private readonly anchors: ReadonlyMap<number, string> = new Map(),
  ) {
    this.expectedPrev = genesisHash(organizationId);
    this.lastHash = this.expectedPrev;
  }

  push(row: ChainedEvent): void {
    this.checked += 1;
    if (this.firstBreak === null) this.firstBreak = this.check(row);
    this.expectedSeq = row.chainSeq + 1;
    this.expectedPrev = row.rowHash;
    this.lastHash = row.rowHash;
    this.lastId = row.id;
  }

  private check(row: ChainedEvent): ChainBreak | null {
    const at = (reason: ChainBreakReason): ChainBreak => ({
      reason,
      eventId: row.id,
      chainSeq: row.chainSeq,
    });
    if (row.chainSeq !== this.expectedSeq) return at('missing_row');
    if (row.prevHash !== this.expectedPrev) return at('prev_hash_mismatch');
    if (chainRowHash(row, row.chainSeq, row.prevHash) !== row.rowHash) {
      return at('row_hash_mismatch');
    }
    const anchored = this.anchors.get(row.chainSeq);
    if (anchored !== undefined) {
      this.anchorsChecked += 1;
      if (anchored !== row.rowHash) return at('anchor_mismatch');
    }
    return null;
  }

  /** Close the walk against the stored head. `complete` is false when the walk was capped. */
  finish(
    head: ChainHeadState | null,
    complete = true,
  ): {
    readonly checkedEvents: number;
    readonly anchorsChecked: number;
    readonly firstBreak: ChainBreak | null;
  } {
    let firstBreak = this.firstBreak;
    if (firstBreak === null && complete && head !== null) {
      const seen = this.expectedSeq - 1;
      if (head.chainSeq !== seen || head.headHash !== this.lastHash) {
        firstBreak = {
          reason: 'head_mismatch',
          eventId: head.lastEventId ?? this.lastId,
          chainSeq: head.chainSeq,
        };
      }
    }
    return { checkedEvents: this.checked, anchorsChecked: this.anchorsChecked, firstBreak };
  }
}
