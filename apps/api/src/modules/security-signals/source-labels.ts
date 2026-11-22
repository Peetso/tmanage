import { IpRangeSet, ipKey, parseCidrValue, parseIpRange } from '@tmanage/domain';
import type { CidrValue, IpRange } from '@tmanage/domain';

/**
 * SEC-TRACKER (Fable ruling, gap 2) — source labels: how the attack tracker READS a source's
 * activity. `known_tester` means "this activity is ours; read it as a test" (the 2026-11-21
 * incident was the Instinct tester, and the screen could not say so).
 *
 * A label is deliberately not an allowlist entry, and the two are never coupled:
 * - allowlist = "let this address through the door" (identity, `network-access`);
 * - label = "read this activity as a test" (here). A tester must be able to stay outside the
 *   allowlist so a real test meets the real door, and an allowlisted office is not a tester.
 *
 * What a label does: a capsule on the row and in the detail, and a sort after unlabelled sources
 * of the same severity ({@link compareLabelled}). What it never does: lower the stored or computed
 * severity, silence or change an alert (the findings job and the worker detector never read this
 * table), or change the sign-in door. `attack-tracks.test.ts` holds all three.
 */

export const SOURCE_LABEL_KINDS = ['known_tester'] as const;
export type SourceLabelKind = (typeof SOURCE_LABEL_KINDS)[number];

/**
 * At most a /24 (IPv4) or a /48 (IPv6): a label names one tester's line, not a provider. The
 * block list's limits, for the same reason a wide entry would mislabel strangers.
 */
export const LABEL_MIN_PREFIX = { 4: 24, 6: 48 } as const;

export interface SourceLabel {
  readonly id: string;
  /** Canonical address or CIDR (`48.47.63.166/32`). */
  readonly value: string;
  readonly label: SourceLabelKind;
  readonly note: string | null;
  readonly createdAt: Date;
}

export function isSourceLabelKind(value: unknown): value is SourceLabelKind {
  return typeof value === 'string' && (SOURCE_LABEL_KINDS as readonly string[]).includes(value);
}

/** A label value: an address or a CIDR no wider than {@link LABEL_MIN_PREFIX}, else null. */
export function parseLabelValue(raw: string): CidrValue | null {
  const parsed = parseCidrValue(raw);
  if (parsed === null || parsed.bits < LABEL_MIN_PREFIX[parsed.family]) return null;
  return parsed;
}

/** The label of a source address, from the (small) label table read once per request. */
export class SourceLabelMatcher {
  private readonly entries: readonly { readonly label: SourceLabel; readonly range: IpRange }[];
  private readonly ranges: IpRangeSet;

  constructor(labels: readonly SourceLabel[]) {
    this.entries = labels.flatMap((label) => {
      const range = parseIpRange(label.value);
      return range === null ? [] : [{ label, range }];
    });
    this.ranges = new IpRangeSet(this.entries.map((e) => e.range));
  }

  labelOf(ip: string): SourceLabel | null {
    const key = ipKey(ip);
    if (key === null || !this.ranges.hasKey(key)) return null;
    return this.entries.find((e) => e.range.start <= key && key <= e.range.end)?.label ?? null;
  }
}
