import { uuidv7 } from '@tmanage/domain';
import {
  createServiceContext,
  type IdentityQueryRunner,
  type TenantContext,
  type TenantDatabase,
} from '../../common/database/tenant-context.js';
import { billingMode } from './billing-mode.js';
import type { BillingMode } from './billing-mode.js';
import {
  PARTNER_TABLES,
  REFERRAL_PLATFORM_REASON,
  REFERRAL_PLATFORM_TABLES,
  REFERRAL_RESOLVE_REASON,
  REFERRAL_RESOLVE_TABLES,
  ReferralsRepository,
  isDuplicateKey,
} from './referrals.repository.js';
import type { PartnerRecord, PartnerSignupRecord } from './referrals.repository.js';
import {
  classifyReferral,
  isPartnerCode,
  newPartnerCode,
  newWorkspaceCode,
  parseReferralCode,
} from './referrals.rules.js';
import type { ReferralOutcome } from './referrals.rules.js';

/** What Settings › Invite agencies draws. No address, no invited count: a link cannot know them. */
export interface ReferralView {
  /** The workspace's code, or `null` before the owner first opens the page. */
  readonly code: string | null;
  /** Agencies that signed up through the link (counted only). */
  readonly signedUp: number;
  /** Newest first, at most 200: the new workspace's name and the date, nothing else. */
  readonly agencies: readonly { readonly name: string; readonly signedUpAt: string }[];
  /** `null` while `beta_free`: a reward is recorded but never shown in the beta. */
  readonly rewards: { readonly recorded: number } | null;
}

export interface PlatformPartnerView {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly createdAt: string;
  readonly counted: number;
  readonly signups: readonly {
    readonly name: string;
    readonly outcome: ReferralOutcome;
    readonly signedUpAt: string;
  }[];
}

export interface PlatformReferralsView {
  /** Workspace invite-link sign-ups across TManage, by outcome (no names). */
  readonly workspaceTotals: Readonly<Record<ReferralOutcome, number>>;
  readonly partners: readonly PlatformPartnerView[];
}

export interface ReferralSignupInput {
  readonly code: unknown;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly email: string;
  readonly correlationId: string;
}

/** What sign-up needs: record a sign-up against a code. */
export interface ReferralRecorder {
  recordSignup(input: ReferralSignupInput): Promise<ReferralOutcome | null>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CODE_ATTEMPTS = 5;

export function buildPartnerViews(
  partners: readonly PartnerRecord[],
  signups: readonly PartnerSignupRecord[],
): PlatformPartnerView[] {
  return partners.map((partner) => {
    const own = signups.filter((signup) => signup.partnerId === partner.id);
    return {
      id: partner.id,
      name: partner.name,
      code: partner.code,
      createdAt: partner.createdAt.toISOString(),
      counted: own.filter((signup) => signup.outcome === 'counted').length,
      signups: own.slice(0, 200).map((signup) => ({
        name: signup.name,
        outcome: signup.outcome,
        signedUpAt: signup.signedUpAt.toISOString(),
      })),
    };
  });
}

/**
 * 57-08 REFERRAL — invite links, the sign-up record and partner codes.
 *
 * Owner-only reads and writes are checked by the controller ({@link requireReferralOwner});
 * this service trusts the context it is given and never reads a workspace from input.
 */
export class ReferralsService implements ReferralRecorder {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: ReferralsRepository = new ReferralsRepository(),
    private readonly now: () => Date = () => new Date(),
    private readonly mode: () => BillingMode = () => billingMode(),
  ) {}

  async view(context: TenantContext): Promise<ReferralView> {
    return this.database.read(context, async (runner) => {
      const code = await this.repository.readCode(runner, context);
      const list = await this.repository.listCounted(runner, context);
      const rewards =
        this.mode() === 'beta_free'
          ? null
          : { recorded: await this.repository.countRecordedRewards(runner, context) };
      return {
        code: code?.code ?? null,
        signedUp: list.total,
        agencies: list.agencies.map((agency) => ({
          name: agency.name,
          signedUpAt: agency.signedUpAt.toISOString(),
        })),
        rewards,
      };
    });
  }

  /** The workspace's code, created on first use. Idempotent: a second call returns the same one. */
  async ensureCode(context: TenantContext): Promise<ReferralView> {
    for (let attempt = 1; attempt <= CODE_ATTEMPTS; attempt += 1) {
      try {
        await this.database.transaction(context, async (tx) => {
          if ((await this.repository.readCode(tx, context)) !== null) return;
          const slug = await this.repository.readSlug(tx, context);
          await this.repository.insertCode(tx, context, newWorkspaceCode(slug), this.now());
        });
        break;
      } catch (error) {
        // A taken code (another workspace drew the same tail) retries; a racing second insert for
        // this workspace lands here too and the next pass finds the code.
        if (!isDuplicateKey(error) || attempt === CODE_ATTEMPTS) throw error;
      }
    }
    return this.view(context);
  }

  /**
   * Record a new workspace against the code it signed up with. Never throws for an unknown or
   * malformed code (`null`): a referral must never fail a sign-up, and the caller also catches.
   */
  async recordSignup(input: ReferralSignupInput): Promise<ReferralOutcome | null> {
    const code = parseReferralCode(input.code);
    if (code === null) return null;
    return isPartnerCode(code)
      ? this.recordPartner(code, input)
      : this.recordWorkspace(code, input);
  }

  private async recordWorkspace(
    code: string,
    input: ReferralSignupInput,
  ): Promise<ReferralOutcome | null> {
    const target = await this.database.bootstrapRead(
      {
        correlationId: input.correlationId,
        reason: REFERRAL_RESOLVE_REASON,
        tables: [...REFERRAL_RESOLVE_TABLES],
      },
      (runner) => this.repository.resolveWorkspaceCode(runner, code),
    );
    if (target === null || target.organizationId === input.organizationId) return null;
    const teamEmails = await this.database.identityRead(
      { correlationId: input.correlationId, tables: ['users'] },
      (runner) => this.repository.emailsOf(runner, target.teamUserIds),
    );
    const context = createServiceContext({
      organizationId: target.organizationId,
      correlationId: input.correlationId,
      policyVersion: 'referral-signup',
    });
    const now = this.now();
    return this.database.transaction(context, async (tx) => {
      const outcome = classifyReferral({
        newEmail: input.email,
        teamEmails,
        countedLastDay: await this.repository.countCountedSince(
          tx,
          context,
          new Date(now.getTime() - DAY_MS),
        ),
      });
      await this.repository.insertSignup(tx, context, {
        referralCodeId: target.codeId,
        referredOrganizationId: input.organizationId,
        referredName: input.organizationName,
        outcome,
        signedUpAt: now,
      });
      return outcome;
    });
  }

  private async recordPartner(
    code: string,
    input: ReferralSignupInput,
  ): Promise<ReferralOutcome | null> {
    const now = this.now();
    return this.database.identityTransaction(
      { correlationId: input.correlationId, tables: [...PARTNER_TABLES] },
      async (tx) => {
        const partner = await this.repository.findPartner(tx, code);
        if (partner === null) return null;
        const outcome = classifyReferral({
          newEmail: input.email,
          teamEmails: [],
          countedLastDay: await this.repository.countPartnerCountedSince(
            tx,
            partner.id,
            new Date(now.getTime() - DAY_MS),
          ),
        });
        await this.repository.insertPartnerSignup(tx, {
          partnerId: partner.id,
          referredOrganizationId: input.organizationId,
          referredName: input.organizationName,
          outcome,
          signedUpAt: now,
        });
        return outcome;
      },
    );
  }

  // ── Platform admin ─────────────────────────────────────────────────────────

  async platformView(correlationId: string): Promise<PlatformReferralsView> {
    const workspaceTotals = await this.database.bootstrapRead(
      { correlationId, reason: REFERRAL_PLATFORM_REASON, tables: [...REFERRAL_PLATFORM_TABLES] },
      (runner) => this.repository.workspaceTotals(runner),
    );
    const partners = await this.database.identityRead(
      { correlationId, tables: [...PARTNER_TABLES] },
      async (runner) =>
        buildPartnerViews(
          await this.repository.listPartners(runner),
          await this.repository.listPartnerSignups(runner),
        ),
    );
    return { workspaceTotals, partners };
  }

  /** A new partner code. The caller writes the platform audit row in the same transaction. */
  async createPartner(
    name: string,
    createdByUserId: string,
    correlationId: string,
    audit: (
      tx: IdentityQueryRunner,
      partner: { readonly id: string; readonly code: string },
    ) => Promise<void>,
  ): Promise<{ readonly id: string; readonly code: string }> {
    for (let attempt = 1; ; attempt += 1) {
      const partner = { id: uuidv7(), code: newPartnerCode(name), name };
      try {
        await this.database.identityTransaction(
          { correlationId, tables: [...PARTNER_TABLES, 'platform_admin_audit_events'] },
          async (tx) => {
            await this.repository.insertPartner(tx, partner, createdByUserId, this.now());
            await audit(tx, partner);
          },
        );
        return { id: partner.id, code: partner.code };
      } catch (error) {
        if (!isDuplicateKey(error) || attempt === CODE_ATTEMPTS) throw error;
      }
    }
  }
}
