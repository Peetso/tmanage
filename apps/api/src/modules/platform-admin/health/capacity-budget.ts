/**
 * 56-32 — the shared-hosting capacity budget, as pure arithmetic (spec 56 §12.2).
 *
 * Six budget lines, each a reading against a ceiling: the ceiling is the plan figure read from
 * hPanel (`platform_settings.host_profile_json`), or the planning value below until the R0 live
 * check measures it. A gauge is `green` under 60 % of its ceiling, `amber` under 80 %, `red`
 * beyond — the same colours for every line. `budgetPercent` is the line's own steady-use budget
 * (RAM 60 %, inodes 50 %, …), reported beside the colour so the card can draw the budget mark.
 *
 * EN-neutral: keys and numbers only. The card's copy lives with the card (51-15).
 */

export const CAPACITY_SOURCES = ['sample', 'nightly', 'train'] as const;
export type CapacitySource = (typeof CAPACITY_SOURCES)[number];

export const GAUGE_KEYS = [
  'ram',
  'loop_lag',
  'sockets',
  'inodes',
  'disk',
  'db_connections',
] as const;
export type GaugeKey = (typeof GAUGE_KEYS)[number];

export type GaugeColour = 'green' | 'amber' | 'red';

/** The days a gauge must stay red before the move is due. */
export const RED_STREAK_TRIGGER_DAYS = 7;

export const TRIGGER_SENTENCE =
  'Move to KVM when any gauge is red for 7 consecutive daily readings';

/** The plan ceilings. Every figure is the plan's, not the budget's. */
export interface HostProfile {
  readonly plan: string | null;
  /** RAM per Node process, MiB. */
  readonly ramMb: number;
  /** p95 event-loop lag ceiling, ms. */
  readonly loopLagMs: number;
  /** Concurrent sockets, realtime included. */
  readonly sockets: number;
  readonly inodes: number;
  readonly diskMb: number;
  /** Connection cap per database user. */
  readonly dbConnections: number;
  readonly measuredAt: string | null;
  /** `planning` until `host_profile_json` is written from hPanel. */
  readonly source: 'planning' | 'settings';
}

/**
 * The planning values (spec 56 §12.2, Hostinger shared): conservative ends of "typically 1–2 GB"
 * RAM and "hundreds of thousands" of inodes; the measured profile replaces them at R0.
 */
export const PLANNING_PROFILE: HostProfile = Object.freeze({
  plan: null,
  ramMb: 1024,
  loopLagMs: 100,
  sockets: 500,
  inodes: 400_000,
  diskMb: 51_200,
  dbConnections: 25,
  measuredAt: null,
  source: 'planning',
});

/** Each line's steady-use budget, as a percent of its ceiling. */
export const BUDGET_PERCENT: Readonly<Record<GaugeKey, number>> = Object.freeze({
  ram: 60,
  loop_lag: 100,
  sockets: 100,
  inodes: 50,
  disk: 60,
  db_connections: 70,
});

const PROFILE_FIELDS = {
  ramMb: 'ramMb',
  loopLagMs: 'loopLagMs',
  sockets: 'sockets',
  inodes: 'inodes',
  diskMb: 'diskMb',
  dbConnections: 'dbConnections',
} as const;

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * `host_profile_json` → a profile. A missing, unparseable or non-object value is the planning
 * profile; a field that is missing or not a positive integer keeps its planning value, so one
 * typo never zeroes a ceiling (a zero ceiling would make every gauge red).
 */
export function parseHostProfile(raw: string | null | undefined): HostProfile {
  if (typeof raw !== 'string' || raw.trim() === '') return PLANNING_PROFILE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return PLANNING_PROFILE;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return PLANNING_PROFILE;
  }
  const record = parsed as Record<string, unknown>;
  const out: Record<string, unknown> = { ...PLANNING_PROFILE, source: 'settings' };
  for (const field of Object.values(PROFILE_FIELDS)) {
    const value = positiveInt(record[field]);
    if (value !== null) out[field] = value;
  }
  const plan = record['plan'];
  out['plan'] = typeof plan === 'string' && plan.length <= 64 ? plan : null;
  const measuredAt = record['measuredAt'];
  out['measuredAt'] =
    typeof measuredAt === 'string' && !Number.isNaN(Date.parse(measuredAt)) ? measuredAt : null;
  return out as unknown as HostProfile;
}

/** One reading as the budget sees it. NULL = not measured in this reading. */
export interface CapacityReading {
  readonly takenAt: Date;
  readonly source: CapacitySource;
  readonly rssMb: number;
  readonly heapMb: number;
  readonly loopLagMs: number;
  readonly sockets: number | null;
  readonly inodes: number | null;
  readonly diskMb: number | null;
  readonly dbMb: number | null;
  readonly dbConnections: number | null;
}

export interface Gauge {
  readonly key: GaugeKey;
  readonly value: number;
  readonly ceiling: number;
  /** Whole percent of the ceiling, one decimal. */
  readonly percent: number;
  readonly colour: GaugeColour;
  readonly budgetPercent: number;
  readonly withinBudget: boolean;
}

export function gaugeColour(percent: number): GaugeColour {
  if (percent < 60) return 'green';
  if (percent < 80) return 'amber';
  return 'red';
}

function ceilingOf(key: GaugeKey, profile: HostProfile): number {
  switch (key) {
    case 'ram':
      return profile.ramMb;
    case 'loop_lag':
      return profile.loopLagMs;
    case 'sockets':
      return profile.sockets;
    case 'inodes':
      return profile.inodes;
    case 'disk':
      return profile.diskMb;
    case 'db_connections':
      return profile.dbConnections;
  }
}

export function gauge(key: GaugeKey, value: number, profile: HostProfile): Gauge {
  const ceiling = ceilingOf(key, profile);
  const percent = Math.round((value / ceiling) * 1000) / 10;
  const budgetPercent = BUDGET_PERCENT[key];
  return {
    key,
    value,
    ceiling,
    percent,
    colour: gaugeColour(percent),
    budgetPercent,
    withinBudget: percent <= budgetPercent,
  };
}

/** The value a reading holds for a gauge, or null when the reading did not measure it. */
export function valueOf(key: GaugeKey, reading: CapacityReading): number | null {
  switch (key) {
    case 'ram':
      return reading.rssMb;
    case 'loop_lag':
      return reading.loopLagMs;
    case 'sockets':
      return reading.sockets;
    case 'inodes':
      return reading.inodes;
    case 'disk':
      return reading.diskMb;
    case 'db_connections':
      return reading.dbConnections;
  }
}

/**
 * The six gauges from the freshest reading that measured each line: the live lines (RAM, lag,
 * sockets) from `primary`, the nightly-only lines from `nightly` when `primary` lacks them.
 */
export function gaugesFor(
  profile: HostProfile,
  primary: CapacityReading | null,
  nightly: CapacityReading | null,
): Gauge[] {
  const gauges: Gauge[] = [];
  for (const key of GAUGE_KEYS) {
    const value =
      (primary === null ? null : valueOf(key, primary)) ??
      (nightly === null ? null : valueOf(key, nightly));
    if (value !== null) gauges.push(gauge(key, value, profile));
  }
  return gauges;
}

/** The gauges of one reading that are red. */
export function redGauges(profile: HostProfile, reading: CapacityReading): GaugeKey[] {
  return gaugesFor(profile, reading, null)
    .filter((g) => g.colour === 'red')
    .map((g) => g.key);
}

/**
 * Consecutive daily readings, newest first, in which the same gauge was red; the longest run
 * over the six gauges. `daily` is one reading per UTC day, newest first (the nightly rows).
 */
export function redStreakDays(profile: HostProfile, daily: readonly CapacityReading[]): number {
  let longest = 0;
  for (const key of GAUGE_KEYS) {
    let run = 0;
    for (const reading of daily) {
      const value = valueOf(key, reading);
      if (value === null || gauge(key, value, profile).colour !== 'red') break;
      run += 1;
    }
    longest = Math.max(longest, run);
  }
  return longest;
}

/** One reading per UTC day — the latest of each day — newest first. */
export function onePerUtcDay(readings: readonly CapacityReading[]): CapacityReading[] {
  const byDay = new Map<string, CapacityReading>();
  for (const reading of readings) {
    const day = reading.takenAt.toISOString().slice(0, 10);
    const seen = byDay.get(day);
    if (seen === undefined || seen.takenAt < reading.takenAt) byDay.set(day, reading);
  }
  return [...byDay.values()].sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
}

/**
 * A red gauge alerts once per UTC day per gauge: `shouldAlert` answers true the first time a
 * gauge is seen red on a day and false for the rest of that day.
 */
export class DailyRedAlertGate {
  private readonly lastDay = new Map<GaugeKey, string>();

  shouldAlert(key: GaugeKey, at: Date): boolean {
    const day = at.toISOString().slice(0, 10);
    if (this.lastDay.get(key) === day) return false;
    this.lastDay.set(key, day);
    return true;
  }
}

export function alertKind(key: GaugeKey): string {
  return `capacity:red:${key}`;
}
