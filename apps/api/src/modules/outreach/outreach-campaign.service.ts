import { uuidv7 } from '@tmanage/domain';
import type { FieldCipher } from '@tmanage/domain/field-cipher';
import type { OutreachCampaignStatus } from '../../common/database/schema.js';
import { ApiError } from '../../common/http/errors.js';
import { requireId } from '../platform-admin/platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import type { RequestContext } from '../platform-admin/platform-admin.service.js';
import { platformAuditFor } from '../platform-admin/platform-audit.service.js';
import {
  normaliseCompany,
  planOutreachImport,
  readDecisionMakersCsv,
  type OutreachExclusion,
} from './outreach-import.js';
import type { OutreachRepository, RecipientInsert } from './outreach.repository.js';

/**
 * LANE-Q — Platform admin -> Outreach: import the decision-makers list, then start, pause or stop
 * the campaign. Platform admins only (the controller's guard and permission); every change is
 * audited. A campaign is always created `paused`: nothing is sent until an admin presses Start.
 * The page never shows an address: it lists company, first name, country, sender and status.
 */

export type OutreachStore = Pick<
  OutreachRepository,
  | 'activeSenders'
  | 'known'
  | 'insertCampaign'
  | 'campaigns'
  | 'campaign'
  | 'counts'
  | 'recipients'
  | 'setStatus'
  | 'markBounced'
>;

export type OutreachAction = 'start' | 'pause' | 'stop';

/** The allowed moves; `stopped` is final (a stopped campaign never sends again). */
const MOVES: Readonly<
  Record<
    OutreachAction,
    { readonly from: readonly OutreachCampaignStatus[]; readonly to: OutreachCampaignStatus }
  >
> = {
  start: { from: ['paused'], to: 'running' },
  pause: { from: ['running'], to: 'paused' },
  stop: { from: ['paused', 'running'], to: 'stopped' },
};

const AUDIT_ACTION: Readonly<Record<OutreachAction, string>> = {
  start: 'platform.outreach_started',
  pause: 'platform.outreach_paused',
  stop: 'platform.outreach_stopped',
};

const CIPHER_PURPOSE = 'outreach_email' as const;

export interface OutreachRecipientView {
  readonly id: string;
  readonly company: string;
  readonly firstName: string;
  readonly country: string;
  readonly language: string;
  readonly sender: string | null;
  readonly status: string;
  readonly sentAt: string | null;
  readonly trialRedeemedAt: string | null;
}

export interface OutreachCampaignView {
  readonly id: string;
  readonly name: string;
  readonly status: OutreachCampaignStatus;
  readonly firstStartedAt: string | null;
  readonly createdAt: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly trialsRedeemed: number;
}

export interface OutreachView {
  readonly campaigns: readonly OutreachCampaignView[];
  /** The newest campaign's recipients (no address). */
  readonly recipients: readonly OutreachRecipientView[];
  /** Whether `CAMPAIGN_POSTAL_ADDRESS` is set: US recipients are imported only then. */
  readonly postalAddressSet: boolean;
}

export interface OutreachImportView extends OutreachView {
  readonly imported: number;
  readonly rows: number;
  readonly excluded: Readonly<Partial<Record<OutreachExclusion, number>>>;
}

type Body = Readonly<Record<string, unknown>>;

export class OutreachCampaignService {
  constructor(
    private readonly store: OutreachStore,
    private readonly cipher: FieldCipher,
    private readonly postalAddress: () => string = () =>
      (process.env['CAMPAIGN_POSTAL_ADDRESS'] ?? '').trim(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async view(context: RequestContext): Promise<OutreachView> {
    const [campaigns, counts] = await Promise.all([
      this.store.campaigns(context.correlationId),
      this.store.counts(context.correlationId),
    ]);
    const newest = campaigns[0];
    const recipients =
      newest === undefined ? [] : await this.store.recipients(newest.id, context.correlationId);
    return {
      campaigns: campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        firstStartedAt: c.firstStartedAt?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
        counts: counts.get(c.id)?.byStatus ?? {},
        trialsRedeemed: counts.get(c.id)?.redeemed ?? 0,
      })),
      recipients: recipients.map((r) => ({
        id: r.id,
        company: r.company,
        firstName: r.firstName,
        country: r.country,
        language: r.language,
        sender: r.senderAddress,
        status: r.status,
        sentAt: r.sentAt?.toISOString() ?? null,
        trialRedeemedAt: r.trialRedeemedAt?.toISOString() ?? null,
      })),
      postalAddressSet: this.postalAddress() !== '',
    };
  }

  async importCsv(
    actor: PlatformAdminActor,
    body: Body,
    context: RequestContext,
  ): Promise<OutreachImportView> {
    const rows = readDecisionMakersCsv(body['csv']);
    const name =
      typeof body['name'] === 'string' && body['name'].trim() !== ''
        ? body['name'].trim().slice(0, 120)
        : `Outreach ${this.now().toISOString().slice(0, 10)}`;
    if (!this.cipher.enabled) {
      throw new ApiError(
        409,
        'conflict',
        'Addresses cannot be stored: FIELD_CIPHER_KEYS is not set on this server.',
      );
    }
    const [senders, known] = await Promise.all([
      this.store.activeSenders(context.correlationId),
      this.store.known(context.correlationId),
    ]);
    const plan = planOutreachImport(rows, {
      senders,
      postalAddressSet: this.postalAddress() !== '',
      knownHashes: known.hashes,
      knownCompanies: new Set(known.companies.map(normaliseCompany)),
    });
    if (plan.recipients.length === 0) {
      throw new ApiError(400, 'validation_failed', 'No row in the file can be written to.', [
        { field: 'csv', message: JSON.stringify(plan.excluded) },
      ]);
    }
    const at = this.now();
    const campaignId = uuidv7();
    const recipients: RecipientInsert[] = plan.recipients.map((r) => {
      const id = uuidv7();
      return {
        id,
        campaignId,
        company: r.company,
        personName: r.personName,
        firstName: r.firstName,
        emailEnc: this.cipher.encrypt(r.email, { purpose: CIPHER_PURPOSE, ownerId: id }),
        emailHash: r.emailHash,
        country: r.country,
        timeZone: r.timeZone,
        language: r.language,
        senderPersonId: r.senderPersonId,
      };
    });
    await this.store.insertCampaign(
      { id: campaignId, name, createdBy: actor.account.userId, at },
      recipients,
      platformAuditFor(actor, context, {
        action: 'platform.outreach_imported',
        targetType: 'setting',
        targetId: null,
        targetLabel: `${name}: ${String(recipients.length)} recipients`,
        reason: null,
        beforeJson: null,
        // Counts only: no address, no name.
        afterJson: JSON.stringify({
          campaignId,
          imported: recipients.length,
          excluded: plan.excluded,
        }),
      }),
    );
    return {
      ...(await this.view(context)),
      imported: recipients.length,
      rows: plan.rows,
      excluded: plan.excluded,
    };
  }

  async move(
    actor: PlatformAdminActor,
    rawId: string,
    action: OutreachAction,
    context: RequestContext,
  ): Promise<OutreachView> {
    const id = requireId(rawId);
    const campaign = await this.store.campaign(id, context.correlationId);
    if (campaign === null) throw new ApiError(404, 'not_found', 'That campaign does not exist.');
    const move = MOVES[action];
    if (!move.from.includes(campaign.status)) {
      throw new ApiError(409, 'conflict', `A ${campaign.status} campaign cannot ${action}.`);
    }
    const moved = await this.store.setStatus(
      id,
      campaign.status,
      move.to,
      this.now(),
      platformAuditFor(actor, context, {
        action: AUDIT_ACTION[action],
        targetType: 'setting',
        targetId: null,
        targetLabel: campaign.name,
        reason: null,
        beforeJson: JSON.stringify({ status: campaign.status }),
        afterJson: JSON.stringify({ status: move.to }),
      }),
    );
    if (!moved) throw new ApiError(409, 'conflict', 'The campaign changed meanwhile. Reload.');
    return this.view(context);
  }

  async markBounced(
    actor: PlatformAdminActor,
    rawId: string,
    context: RequestContext,
  ): Promise<OutreachView> {
    const id = requireId(rawId);
    const done = await this.store.markBounced(
      id,
      this.now(),
      platformAuditFor(actor, context, {
        action: 'platform.outreach_recipient_bounced',
        targetType: 'setting',
        targetId: null,
        targetLabel: id,
        reason: null,
        beforeJson: null,
        afterJson: JSON.stringify({ status: 'bounced' }),
      }),
    );
    if (!done) throw new ApiError(404, 'not_found', 'That recipient does not exist.');
    return this.view(context);
  }
}
