/**
 * 55-11 / 55-24 / 55-22 — the getting-started checklist and the owner's Setup health, as pure rules.
 *
 * The checklist is fixed and ordered. A step is done when the company's own data says so (a
 * teammate invited, a project created, a client added, storage connected, working hours set, an
 * AI assistant connected over MCP) or when the member marked it done by hand. Only the member's
 * hand marks and the dismissal are stored, under `gettingStarted` in their own
 * `user_preferences.prefs_json` (merged, so no other key is touched) — no new table.
 */

export const CHECKLIST_STEPS = [
  'invite_teammate',
  'create_project',
  'add_client',
  'connect_storage',
  'set_working_hours',
  'try_ai_assistant',
] as const;
export type ChecklistStep = (typeof CHECKLIST_STEPS)[number];

/** What the company's data already proves, one flag per step. */
export type ChecklistSignals = Readonly<Record<ChecklistStep, boolean>>;

/** The stored half: hand marks and the dismissal. */
export interface StoredChecklist {
  readonly marked: readonly ChecklistStep[];
  readonly dismissedAt: string | null;
}

export interface GettingStartedView {
  readonly dismissed: boolean;
  readonly completedCount: number;
  readonly totalCount: number;
  readonly nextStep: ChecklistStep | null;
  readonly steps: readonly { readonly step: ChecklistStep; readonly done: boolean }[];
}

export const SETUP_HEALTH_CHECKS = [
  'storage',
  'sign_in_security',
  'backups',
  'domain_mail',
] as const;
export type SetupHealthCheck = (typeof SETUP_HEALTH_CHECKS)[number];

export interface SetupHealthView {
  readonly okCount: number;
  readonly checks: readonly { readonly check: SetupHealthCheck; readonly ok: boolean }[];
}

export function isChecklistStep(value: unknown): value is ChecklistStep {
  return typeof value === 'string' && (CHECKLIST_STEPS as readonly string[]).includes(value);
}

/** The stored JSON, tolerant of anything malformed: unknown steps are dropped, never trusted. */
export function parseStoredChecklist(raw: unknown): StoredChecklist {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
  }
  if (value === null || typeof value !== 'object') return { marked: [], dismissedAt: null };
  const record = value as Record<string, unknown>;
  const marked = Array.isArray(record['marked'])
    ? CHECKLIST_STEPS.filter((step) => (record['marked'] as unknown[]).includes(step))
    : [];
  const dismissedAt = typeof record['dismissedAt'] === 'string' ? record['dismissedAt'] : null;
  return { marked, dismissedAt };
}

/** The checklist as the screen reads it: data signals OR hand marks, in the fixed order. */
export function projectChecklist(
  signals: ChecklistSignals,
  stored: StoredChecklist,
): GettingStartedView {
  const steps = CHECKLIST_STEPS.map((step) => ({
    step,
    done: signals[step] || stored.marked.includes(step),
  }));
  const completedCount = steps.filter((entry) => entry.done).length;
  return {
    dismissed: stored.dismissedAt !== null,
    completedCount,
    totalCount: steps.length,
    nextStep: steps.find((entry) => !entry.done)?.step ?? null,
    steps,
  };
}

/** Add a hand mark; marking twice changes nothing (idempotent). */
export function markStep(stored: StoredChecklist, step: ChecklistStep): StoredChecklist {
  if (stored.marked.includes(step)) return stored;
  const marked = CHECKLIST_STEPS.filter((s) => s === step || stored.marked.includes(s));
  return { ...stored, marked };
}

/** What the owner's Setup health reads from the company's data. */
export interface SetupHealthSignals {
  readonly storageConnected: boolean;
  /** At least one role must use two-step sign-in (`security.require_two_step_roles`). */
  readonly twoStepRequired: boolean;
  /** A company export finished within the last {@link BACKUP_FRESH_DAYS} days. */
  readonly recentExport: boolean;
  /** The company's mail-in address is active. */
  readonly mailInActive: boolean;
}

export const BACKUP_FRESH_DAYS = 90;

export function projectSetupHealth(signals: SetupHealthSignals): SetupHealthView {
  const flags: Record<SetupHealthCheck, boolean> = {
    storage: signals.storageConnected,
    sign_in_security: signals.twoStepRequired,
    backups: signals.recentExport,
    domain_mail: signals.mailInActive,
  };
  const checks = SETUP_HEALTH_CHECKS.map((check) => ({ check, ok: flags[check] }));
  return { okCount: checks.filter((c) => c.ok).length, checks };
}

/** Whether a stored `security.require_two_step_roles` value requires two-step for anyone. */
export function requiresTwoStep(value: unknown): boolean {
  return value === 'admins' || value === 'everyone';
}
