import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { PlatformAdminGuard } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import {
  RED_STREAK_TRIGGER_DAYS,
  TRIGGER_SENTENCE,
  gaugesFor,
  onePerUtcDay,
  parseHostProfile,
  redStreakDays,
} from './capacity-budget.js';
import type { CapacityReading, Gauge, HostProfile } from './capacity-budget.js';
import type { CapacityStore } from './capacity.repository.js';

export const CAPACITY_STORE = Symbol.for('tmanage.CapacityStore');

/** Nightly rows read for the streak: enough for 7 daily readings plus a retried night or two. */
const STREAK_WINDOW = 14;

export interface CapacityReadingView {
  readonly takenAt: string;
  readonly source: string;
  readonly rssMb: number;
  readonly heapMb: number;
  readonly loopLagMs: number;
  readonly sockets: number | null;
  readonly inodes: number | null;
  readonly diskMb: number | null;
  readonly dbMb: number | null;
  readonly dbConnections: number | null;
}

export interface CapacityView {
  readonly profile: HostProfile;
  readonly latest: {
    readonly sample: CapacityReadingView | null;
    readonly nightly: CapacityReadingView | null;
  };
  readonly gauges: readonly Gauge[];
  readonly trigger: { readonly sentence: string; readonly days: number; readonly due: boolean };
  readonly redStreakDays: number;
}

function view(reading: CapacityReading | null): CapacityReadingView | null {
  return reading === null ? null : { ...reading, takenAt: reading.takenAt.toISOString() };
}

/** The view, from the store. Exported for the controller test. */
export async function readCapacity(store: CapacityStore): Promise<CapacityView> {
  const [profileJson, sample, nightlyRows] = await Promise.all([
    store.readProfileJson(),
    store.latest('sample'),
    store.recentNightly(STREAK_WINDOW),
  ]);
  const profile = parseHostProfile(profileJson);
  const nightly = nightlyRows[0] ?? null;
  // The freshest of the two drives the live lines; the nightly fills inodes, disk and DB.
  const primary =
    sample !== null && (nightly === null || sample.takenAt >= nightly.takenAt) ? sample : nightly;
  const streak = redStreakDays(profile, onePerUtcDay(nightlyRows));
  return {
    profile,
    latest: { sample: view(sample), nightly: view(nightly) },
    gauges: gaugesFor(profile, primary, nightly),
    trigger: {
      sentence: TRIGGER_SENTENCE,
      days: RED_STREAK_TRIGGER_DAYS,
      due: streak >= RED_STREAK_TRIGGER_DAYS,
    },
    redStreakDays: streak,
  };
}

/**
 * `GET /v1/platform/health/capacity` — the Platform → Health "Host capacity" card's data (56-32):
 * six gauges against the plan ceilings, the latest sample and nightly readings, and how many
 * consecutive daily readings a gauge has been red. Platform admin read (`platform.activity.view`).
 * Readings carry no customer data. EN-neutral: the card's copy lives with the card.
 */
@Controller('v1/platform/health')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformCapacityController {
  constructor(@Inject(CAPACITY_STORE) private readonly store: CapacityStore) {}

  @Get('capacity')
  @RequirePlatformPermission('platform.activity.view')
  read(): Promise<CapacityView> {
    return readCapacity(this.store);
  }
}
