/**
 * 62-07 (plan 62 §5). Credit packs: credits on top of the monthly allowance. Pure rules; the
 * statements are in `ai-packs.repository.ts`, the transactions in `ai-packs.service.ts`.
 *
 * "Allowance first, then the oldest pack." A workspace's holds are taken on its period row against
 * `allowance_credits + pack_credits` (62-06's one conditional UPDATE). When the allowance alone
 * cannot cover a hold, exactly the credits missing are MOVED from the oldest live packs into the
 * period ({@link planDraw}); every move is a row in the packs ledger. Unused pack credits of a closed
 * period go back to the packs they came from, newest first, while those packs are still live
 * ({@link planReturn}); credits of a pack that expired in the meantime are gone, like the pack.
 *
 * A pack lives {@link AI_PACK_LIFETIME_MONTHS} months from its grant. Testing: an owner requests one,
 * a platform admin grants it (any size up to what the whole platform cap pays for). Paid purchase is
 * phase 6 and needs a payment provider; no overage, no auto-renew.
 */

/** Plan 62 §5: a pack expires 6 months after it is granted. */
export const AI_PACK_LIFETIME_MONTHS = 6;

/** The pack's expiry: the same day-of-month 6 months on (UTC), or that month's last day. */
export function packExpiresAt(grantedAt: Date): Date {
  const year = grantedAt.getUTCFullYear();
  const month = grantedAt.getUTCMonth() + AI_PACK_LIFETIME_MONTHS;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(grantedAt.getUTCDate(), lastDay),
      grantedAt.getUTCHours(),
      grantedAt.getUTCMinutes(),
      grantedAt.getUTCSeconds(),
      grantedAt.getUTCMilliseconds(),
    ),
  );
}

export interface LivePack {
  readonly id: string;
  readonly remainingCredits: number;
  readonly grantedAt: Date;
  readonly expiresAt: Date;
}

/** One move of credits between a pack and a period. */
export interface PackMove {
  readonly packId: string;
  readonly credits: number;
}

/** The period counters a draw or a return is computed from (`ai_workspace_periods`). */
export interface PeriodCredits {
  readonly allowanceCredits: number;
  readonly packCredits: number;
  readonly settledCredits: number;
  readonly reservedCredits: number;
}

export function isLive(pack: Pick<LivePack, 'expiresAt'>, now: Date): boolean {
  return pack.expiresAt.getTime() > now.getTime();
}

/** Oldest grant first; the id breaks a tie so the order is total. */
function byGrant(a: LivePack, b: LivePack): number {
  return a.grantedAt.getTime() - b.grantedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Credits a hold of `holdCredits` is short of on this period (0 when the period covers it). */
export function creditsShort(period: PeriodCredits, holdCredits: number): number {
  return Math.max(
    0,
    period.settledCredits +
      period.reservedCredits +
      holdCredits -
      period.allowanceCredits -
      period.packCredits,
  );
}

/**
 * Take `need` credits from the live packs, oldest grant first. `null` when the live packs together
 * hold less than `need`: nothing is taken (a hold is all or nothing).
 */
export function planDraw(packs: readonly LivePack[], need: number, now: Date): PackMove[] | null {
  if (need <= 0) return [];
  const moves: PackMove[] = [];
  let left = need;
  for (const pack of packs.filter((p) => isLive(p, now) && p.remainingCredits > 0).sort(byGrant)) {
    const take = Math.min(left, pack.remainingCredits);
    moves.push({ packId: pack.id, credits: take });
    left -= take;
    if (left === 0) return moves;
  }
  return null;
}

/**
 * The pack credits a closed period did not use: never more than were moved in, and the allowance is
 * counted as spent first (so pack credits are the last to be used and the first to go back).
 */
export function unusedPackCredits(period: PeriodCredits): number {
  const unused =
    period.allowanceCredits + period.packCredits - period.settledCredits - period.reservedCredits;
  return Math.max(0, Math.min(period.packCredits, unused));
}

/** What a period drew from one pack, with that pack's grant and expiry. */
export interface PeriodDraw extends LivePack {
  /** Credits drawn from this pack into the period. */
  readonly drawnCredits: number;
}

/**
 * Give `unused` credits back, newest grant first (the oldest pack was spent first, so what is left
 * came from the newest), each pack at most what the period drew from it, live packs only.
 */
export function planReturn(draws: readonly PeriodDraw[], unused: number, now: Date): PackMove[] {
  const moves: PackMove[] = [];
  let left = unused;
  for (const draw of [...draws].sort(byGrant).reverse()) {
    if (left <= 0) break;
    const give = Math.min(left, draw.drawnCredits);
    left -= give;
    if (give > 0 && isLive(draw, now)) moves.push({ packId: draw.id, credits: give });
  }
  return moves;
}

/** The credits the live packs still hold. */
export function packBalance(packs: readonly LivePack[], now: Date): number {
  return packs.filter((p) => isLive(p, now)).reduce((sum, p) => sum + p.remainingCredits, 0);
}
