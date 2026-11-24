import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 60-07 (plan 60 v2 §4.5, §4.6; screen S5) — the consent page's "This agent works as" choice.
 *
 * A signed-in person may connect an AI app as themselves ("Me") or as one of the workspace's AI
 * employees they may bind. This file is the OAuth side's port only: the rules about AI employees
 * (who may bind, which status, the switches, the cap of live credentials) belong to the
 * AI-employee module (AR-7), which provides {@link WorksAsPort} under {@link WORKS_AS_PORT}.
 *
 * The client's choice is never trusted: the page sends an id, and the approve route hands it to
 * {@link WorksAsPort.binder}, whose binder re-checks every rule inside the grant's own transaction
 * (with the AI employee's row locked), so a choice that became invalid between the page load and
 * "Allow" is refused.
 */

/** Why a row on the page cannot be chosen. */
export type WorksAsUnavailableReason = 'paused' | 'not_allowed' | 'limit';

/** One AI employee row of the "works as" list. */
export interface WorksAsOptionView {
  readonly id: string;
  readonly displayName: string;
  readonly jobTitle: string;
  /** True when choosing it and pressing Allow would succeed now. */
  readonly available: boolean;
  /** Set exactly when `available` is false. */
  readonly unavailableReason: WorksAsUnavailableReason | null;
}

/** `GET /v1/organizations/:orgSlug/oauth/consent/works-as`. */
export interface ConsentWorksAsView {
  /**
   * The AI employees the page lists. Empty when the person may bind none of them, when the
   * workspace or server switch is off, or when the workspace has none: the page then shows the
   * ordinary consent, unchanged.
   */
  readonly aiEmployees: readonly WorksAsOptionView[];
}

/** The AI employee's membership a grant is bound to. */
export interface WorksAsTarget {
  readonly membershipId: string;
  readonly userId: string;
}

/**
 * Runs first inside the grant's transaction: locks the AI employee, re-checks every rule, writes
 * the audit row naming `grantId`, and answers the membership the grant is bound to. Throws an
 * `ApiError` (403 / 404 / 409) when the binding is not allowed.
 */
export type WorksAsBinder = (
  tx: TenantQueryRunner,
  context: TenantContext,
  grantId: string,
) => Promise<WorksAsTarget>;

export interface WorksAsPort {
  /** The list the page shows, for the signed-in person in this workspace. */
  options(context: TenantContext): Promise<ConsentWorksAsView>;
  /** The binder for one chosen AI employee (nothing is read until the transaction runs it). */
  binder(aiEmployeeId: string): WorksAsBinder;
}

export const WORKS_AS_PORT = Symbol.for('tmanage.OAuthWorksAs');

/** The approve body's `worksAs`: absent, null or `"me"` = the person; otherwise an id. */
export type WorksAsChoice =
  { readonly ok: true; readonly aiEmployeeId: string | null } | { readonly ok: false };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function parseWorksAs(raw: unknown): WorksAsChoice {
  if (raw === undefined || raw === null || raw === 'me') return { ok: true, aiEmployeeId: null };
  if (typeof raw === 'string' && ID.test(raw)) {
    return { ok: true, aiEmployeeId: raw.toLowerCase() };
  }
  return { ok: false };
}
