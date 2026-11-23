import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import { memberShareCredits } from '../billing/ai-allowance.js';
import { spendableCreditsOf } from '../billing/ai-allowance.service.js';
import type { AiAllowanceService } from '../billing/ai-allowance.service.js';
import { SubscriptionRepository } from '../billing/subscription.repository.js';
import { callerClassOf } from './ai-budget.service.js';
import { AiSettingsRepository } from './ai-settings.repository.js';
import type { AiOwnerSettings, AiOwnerSettingsRow } from './ai-settings.repository.js';
import {
  AI_MEMBER_SHARE_CHOICES,
  aiProvidersOf,
  applyAiSettingsPatch,
  blockableMember,
  changedSettings,
} from './ai-settings.rules.js';
import type { AiProvider, AiSettingsPatch } from './ai-settings.rules.js';
import type { AiWriteScope } from './copilot-chat.service.js';

/**
 * 62-17 (plan 62 J1, Figma G1 v2 `786:48751`) — Settings > AI, the owner's page.
 *
 * - {@link AiSettingsService.view}: the owner's settings, the block list with names, the credits
 *   the member share stands for (and each share choice's), and the provider line.
 * - {@link AiSettingsService.update}: the owner's change. One transaction holds the settings row
 *   (`for update`), writes it, adds or lifts blocks, and records one audit row per change
 *   (`ai_settings.updated` with each changed setting's before and after as change rows; one
 *   `ai_settings.member_blocked` / `ai_settings.member_allowed` per member) — all or nothing
 *   (DA-11).
 *
 * Absent off the test list (404, as the plan's row says). Only an ordinary member session reaches
 * it (a personal access token or the AI channel is 403); the controller adds the owner gate.
 */

export const AI_SETTINGS_UPDATED_AUDIT_ACTION = 'ai_settings.updated';
export const AI_SETTINGS_MEMBER_BLOCKED_AUDIT_ACTION = 'ai_settings.member_blocked';
export const AI_SETTINGS_MEMBER_ALLOWED_AUDIT_ACTION = 'ai_settings.member_allowed';

export interface AiBlockedMemberEntry {
  readonly membershipId: string;
  readonly displayName: string;
  readonly blockedAt: string;
}

export interface AiShareChoice {
  readonly percent: number;
  readonly memberCredits: number;
}

export interface AiSettingsView {
  readonly aiEnabled: boolean;
  readonly writeScope: AiWriteScope;
  readonly runAtOnce: boolean;
  readonly fileReading: boolean;
  readonly memberSharePercent: number;
  readonly conversationRetentionDays: number;
  readonly blockedMembers: readonly AiBlockedMemberEntry[];
  readonly credits: {
    /** What the workspace can spend this month (allowance plus packs). */
    readonly workspaceCredits: number;
    /** What one member may use at the saved share. */
    readonly memberCredits: number;
    /** Each share the Select offers, with what one member could use at it. */
    readonly shareChoices: readonly AiShareChoice[];
  };
  readonly providers: readonly AiProvider[];
  readonly updatedAt: string | null;
  /**
   * AI-TWO-WAYS: whether TManage AI can answer once it is on — `ready`, `flag_off` (the
   * workspace's "AI copilot" module is off) or `no_key` (TManage has no AI key for this
   * workspace's group yet). The owner sees it here before a member asks.
   */
  readonly readiness: AiReadiness;
}

export type AiReadiness = 'ready' | 'flag_off' | 'no_key';

export interface AiSettingsDeps {
  readonly database: Pick<TenantDatabase, 'read' | 'transaction'>;
  readonly audit: Pick<AuditService, 'record'>;
  readonly allowance: Pick<AiAllowanceService, 'resolveWith'>;
  readonly repository?: AiSettingsRepository;
  readonly people?: Pick<SubscriptionRepository, 'countInternalPeople'>;
  /** AI-TWO-WAYS: the chat's own gates, read for the owner (unwired: `ready`, unit tests only). */
  readonly readiness?: (context: TenantContext) => Promise<AiReadiness>;
  /** Whether search by meaning (Voyage embeddings) is wired; none is today. */
  readonly searchByMeaning?: () => boolean;
  readonly now?: () => Date;
}

const notFound = (auditCode: string) =>
  new ApiError(404, 'not_found', MESSAGES.notFound, undefined, auditCode);

function ownerSettingsOf(row: AiOwnerSettingsRow): AiOwnerSettings {
  return {
    aiEnabled: row.aiEnabled,
    writeScope: row.writeScope,
    runAtOnce: row.runAtOnce,
    fileReading: row.fileReading,
    memberSharePercent: row.memberSharePercent,
    conversationRetentionDays: row.conversationRetentionDays,
  };
}

export class AiSettingsService {
  private readonly repository: AiSettingsRepository;
  private readonly people: Pick<SubscriptionRepository, 'countInternalPeople'>;
  private readonly searchByMeaning: () => boolean;
  private readonly now: () => Date;

  constructor(private readonly deps: AiSettingsDeps) {
    this.repository = deps.repository ?? new AiSettingsRepository();
    this.people = deps.people ?? new SubscriptionRepository();
    this.searchByMeaning = deps.searchByMeaning ?? (() => false);
    this.now = deps.now ?? (() => new Date());
  }

  async view(context: TenantContext): Promise<AiSettingsView> {
    requireMemberSession(context);
    const view = await this.deps.database.read(context, async (runner) => {
      const row = await this.repository.read(runner, context);
      if (row === null || !row.onTestList) throw notFound('copilot.settings:not_on_test_list');
      return this.viewOf(runner, context, row);
    });
    const readiness =
      this.deps.readiness === undefined ? 'ready' : await this.deps.readiness(context);
    return { ...view, readiness };
  }

  async update(context: TenantContext, patch: AiSettingsPatch): Promise<AiSettingsView> {
    requireMemberSession(context);
    const at = this.now();
    await this.deps.database.transaction(context, async (tx) => {
      const row = await this.repository.read(tx, context, true);
      if (row === null || !row.onTestList) throw notFound('copilot.settings:not_on_test_list');
      const before = ownerSettingsOf(row);
      const after = applyAiSettingsPatch(before, patch);
      const changes = changedSettings(before, after);
      if (changes.length > 0) {
        await this.repository.write(tx, context, after, at);
        await this.deps.audit.record(tx, context, {
          action: AI_SETTINGS_UPDATED_AUDIT_ACTION,
          result: 'allowed',
          objectId: context.organizationId,
          actorUserId: context.userId,
          metadata: { settings: changes.map((change) => change.field) },
          changes,
        });
      }
      for (const membershipId of patch.blockMembershipIds ?? []) {
        const member = await this.repository.member(tx, context, membershipId);
        const verdict = blockableMember(member);
        if (verdict === 'absent') throw notFound('copilot.settings:member_not_found');
        if (verdict === 'owner') {
          throw new ApiError(400, 'validation_failed', 'The owner cannot be blocked.', [
            { field: 'blockMembershipIds', message: 'the owner cannot be blocked' },
          ]);
        }
        if (await this.repository.block(tx, context, membershipId, at)) {
          await this.deps.audit.record(tx, context, {
            action: AI_SETTINGS_MEMBER_BLOCKED_AUDIT_ACTION,
            result: 'allowed',
            objectId: membershipId,
            actorUserId: context.userId,
            metadata: {},
          });
        }
      }
      for (const membershipId of patch.allowMembershipIds ?? []) {
        // Another workspace's id is absent (404), never a silent no-op.
        if ((await this.repository.member(tx, context, membershipId)) === null) {
          throw notFound('copilot.settings:member_not_found');
        }
        if (await this.repository.allow(tx, context, membershipId)) {
          await this.deps.audit.record(tx, context, {
            action: AI_SETTINGS_MEMBER_ALLOWED_AUDIT_ACTION,
            result: 'allowed',
            objectId: membershipId,
            actorUserId: context.userId,
            metadata: {},
          });
        }
      }
    });
    return this.view(context);
  }

  private async viewOf(
    runner: TenantQueryRunner,
    context: TenantContext,
    row: AiOwnerSettingsRow,
  ): Promise<Omit<AiSettingsView, 'readiness'>> {
    const blocked = await this.repository.blockedMembers(runner, context);
    const resolved = await this.deps.allowance.resolveWith(runner, context);
    const workspaceCredits = spendableCreditsOf(resolved);
    const people = await this.people.countInternalPeople(runner, context);
    return {
      ...ownerSettingsOf(row),
      blockedMembers: blocked.map((member) => ({
        membershipId: member.membershipId,
        displayName: member.displayName,
        blockedAt: member.blockedAt.toISOString(),
      })),
      credits: {
        workspaceCredits,
        memberCredits: memberShareCredits(workspaceCredits, row.memberSharePercent, people),
        shareChoices: AI_MEMBER_SHARE_CHOICES.map((percent) => ({
          percent,
          memberCredits: memberShareCredits(workspaceCredits, percent, people),
        })),
      },
      providers: aiProvidersOf(this.searchByMeaning()),
      updatedAt: row.updatedAt?.toISOString() ?? null,
    };
  }
}

/** A person on an ordinary session only: a token, the AI channel or a service is refused (403). */
function requireMemberSession(context: TenantContext): void {
  if (callerClassOf(context).kind !== 'member') {
    throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'copilot.settings:caller');
  }
}
