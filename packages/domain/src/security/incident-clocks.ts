/**
 * 56-13 — incident response, one-person edition: the severity ladder and the legal notification
 * clocks. Pure: no clock of its own (every function takes `now` or the instants it needs), no I/O.
 *
 * The register is the GLOBAL `incidents` table (0060 + 0302). An incident that touches personal
 * data starts one clock per jurisdiction its affected customers are in, plus the customer clock our
 * DPA promises. These are the operator's deadlines, not legal advice: the runbook
 * (`docs/runbooks/incident-response.md`) says when to call counsel.
 *
 * Sources (checked 2026-11-02):
 * - EU/EEA — GDPR Art. 33(1): notify the supervisory authority "without undue delay and, where
 *   feasible, not later than 72 hours after having become aware of it". Art. 34: the data subjects
 *   "without undue delay" when the breach is likely to result in a high risk.
 * - KSA — PDPL Implementing Regulations Art. 24 (SDAIA, 2023): notify SDAIA within 72 hours of
 *   becoming aware of the incident.
 * - UAE — Federal Decree-Law 45/2021 (PDPL) Art. 9: notify the Data Office "as soon as practicable";
 *   treated here as 72 hours, the strictest reading in the region.
 * - Egypt — Law 151/2020 (PDPL) Art. 7: notify the Personal Data Protection Center within 72 hours.
 * - Customers — the TManage DPA: the controller (our customer) is told within 48 hours.
 */

/** SEV0 cross-tenant or credential exposure … SEV3 minor, no data at risk. VARCHAR(4) in 0302. */
export const SEVERITIES = ['SEV0', 'SEV1', 'SEV2', 'SEV3'] as const;
export type IncidentSeverity = (typeof SEVERITIES)[number];

export function isIncidentSeverity(value: unknown): value is IncidentSeverity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value);
}

export const JURISDICTIONS = ['EU', 'SA', 'AE', 'EG'] as const;
export type Jurisdiction = (typeof JURISDICTIONS)[number];

const HOUR_MS = 3_600_000;

/** Hours from detection to the authority notice, per jurisdiction. */
export const AUTHORITY_CLOCK_HOURS: Readonly<Record<Jurisdiction, number>> = {
  EU: 72,
  SA: 72,
  AE: 72,
  EG: 72,
};

/** Hours from detection to the customer (controller) notice — the DPA promise. */
export const CUSTOMER_CLOCK_HOURS = 48;

/** A clock within this many hours of its deadline is `due_soon`. */
export const DUE_SOON_HOURS = 12;

const BASIS: Readonly<Record<Jurisdiction, string>> = {
  EU: 'GDPR Art. 33 — supervisory authority within 72 hours',
  SA: 'KSA PDPL Implementing Regulations Art. 24 — SDAIA within 72 hours',
  AE: 'UAE PDPL Art. 9 — Data Office as soon as practicable (treated as 72 hours)',
  EG: 'Egypt Law 151/2020 Art. 7 — PDPC within 72 hours',
};

/** EU member states plus the EEA three (GDPR applies through the EEA Agreement). ISO 3166-1 alpha-2. */
const EU_EEA = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV',
  'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO',
]); // prettier-ignore

/** The jurisdiction whose clock a customer country starts, or `null` when none of the four applies. */
export function jurisdictionOf(country: string): Jurisdiction | null {
  const code = country.trim().toUpperCase();
  if (code === 'EU' || EU_EEA.has(code)) return 'EU';
  if (code === 'SA' || code === 'AE' || code === 'EG') return code;
  return null;
}

export interface AuthorityDeadline {
  readonly jurisdiction: Jurisdiction;
  readonly dueAt: Date;
  readonly basis: string;
}

export interface NotificationDeadlines {
  /** One per jurisdiction, in `JURISDICTIONS` order; empty when no personal data is involved. */
  readonly authority: readonly AuthorityDeadline[];
  /** The DPA's 48-hour customer clock; `null` when no personal data is involved. */
  readonly customersDueAt: Date | null;
  /** GDPR Art. 34-style: tell the people themselves without undue delay (high-risk breach). */
  readonly subjectsWithoutUndueDelay: boolean;
}

export interface DeadlineInput {
  readonly detectedAt: Date;
  /** Customer countries (ISO alpha-2, or `EU`). Unknown codes start no clock. */
  readonly countries: readonly string[];
  readonly personalData: boolean;
  /** SEV0/SEV1 with personal data is treated as high risk to the people concerned. */
  readonly severity?: IncidentSeverity;
}

/** Every clock an incident starts. No personal data → no clock at all. */
export function notificationDeadlines(input: DeadlineInput): NotificationDeadlines {
  if (!input.personalData) {
    return { authority: [], customersDueAt: null, subjectsWithoutUndueDelay: false };
  }
  const applies = new Set(
    input.countries.map(jurisdictionOf).filter((j): j is Jurisdiction => j !== null),
  );
  const detected = input.detectedAt.getTime();
  return {
    authority: JURISDICTIONS.filter((j) => applies.has(j)).map((jurisdiction) => ({
      jurisdiction,
      dueAt: new Date(detected + AUTHORITY_CLOCK_HOURS[jurisdiction] * HOUR_MS),
      basis: BASIS[jurisdiction],
    })),
    customersDueAt: new Date(detected + CUSTOMER_CLOCK_HOURS * HOUR_MS),
    subjectsWithoutUndueDelay: input.severity === 'SEV0' || input.severity === 'SEV1',
  };
}

export type ClockStatus = 'ok' | 'due_soon' | 'overdue';

/** Where one clock stands at `now`. A clock already answered (`doneAt` set) is `ok`. */
export function clockStatus(dueAt: Date, now: Date, doneAt: Date | null = null): ClockStatus {
  if (doneAt !== null) return 'ok';
  const left = dueAt.getTime() - now.getTime();
  if (left < 0) return 'overdue';
  return left <= DUE_SOON_HOURS * HOUR_MS ? 'due_soon' : 'ok';
}

export interface ResolvableIncident {
  readonly severity: IncidentSeverity;
  readonly personalData: boolean;
  readonly countries: readonly string[];
  readonly notifiedCustomersAt: Date | null;
  readonly notifiedAuthorityAt: Date | null;
}

export type ResolveRefusal = 'customers_not_notified' | 'authority_not_notified';

export interface ResolveCheck {
  readonly ok: boolean;
  readonly missing: readonly ResolveRefusal[];
}

/**
 * Whether an incident may be marked resolved. SEV0/SEV1 with personal data needs the customer notice
 * and — when any authority clock applies — the authority notice or an explicit reason it was not
 * required (`authorityNotRequiredReason`, recorded in the platform audit). Everything else may close.
 */
export function canResolve(
  incident: ResolvableIncident,
  authorityNotRequiredReason: string | null = null,
): ResolveCheck {
  if (!incident.personalData || (incident.severity !== 'SEV0' && incident.severity !== 'SEV1')) {
    return { ok: true, missing: [] };
  }
  const missing: ResolveRefusal[] = [];
  if (incident.notifiedCustomersAt === null) missing.push('customers_not_notified');
  const authorityClock = incident.countries.some((country) => jurisdictionOf(country) !== null);
  const excused = authorityNotRequiredReason !== null && authorityNotRequiredReason.trim() !== '';
  if (authorityClock && incident.notifiedAuthorityAt === null && !excused) {
    missing.push('authority_not_notified');
  }
  return { ok: missing.length === 0, missing };
}
