import { PLATFORM_PERMISSIONS, platformPermissionsFor } from '@tmanage/domain';
import type { EditablePlatformPreset, PlatformPermission, PlatformPreset } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../../common/http/errors.js';
import { isPlatformAdminEmail, requireId, requireReason } from '../platform-admin.access.js';
import type { PlatformRequestContext } from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type {
  PlatformAdminRecord,
  PlatformAdminsRepository,
  PlatformAdminStatus,
  PlatformTeamRow,
  PlatformUserRow,
} from '../platform-admins.repository.js';
import { redactedJson } from '../../audit/audit-redaction.js';
import { platformAuditFor } from '../platform-audit.service.js';
import {
  customListFor,
  requireEditablePreset,
  requirePermissionList,
  requirePreset,
} from './presets.js';

/**
 * The platform admin team (SPEC §3.1, §5.1, D5/D6).
 *
 * The rules, each enforced here and not only on the screen:
 * - only an admin holding `platform.team.manage` reaches these writes (the guard; only the super
 *   admin preset carries that key);
 * - the server list (`PLATFORM_ADMIN_EMAILS`) is the bootstrap: those admins are always super
 *   admins, shown as locked rows and never edited here ("managed in Hostinger");
 * - nobody edits their own row;
 * - at least one active super admin must remain, and the server list counts;
 * - every change carries a reason (SPEC P6: admin-team changes are on the destructive list) and
 *   writes its platform audit row in the same transaction.
 */

export type TeamStore = Pick<
  PlatformAdminsRepository,
  | 'listTeam'
  | 'findById'
  | 'findUserByEmail'
  | 'findUserById'
  | 'findUsersByEmails'
  | 'insert'
  | 'update'
  | 'writePreset'
  | 'storedPresets'
>;

export interface PlatformTeamMemberView {
  /** The `platform_admins` id, or `null` for a server-list admin without a row. */
  readonly id: string | null;
  readonly userId: string | null;
  readonly email: string;
  readonly displayName: string | null;
  readonly source: 'env' | 'db';
  readonly preset: PlatformPreset;
  readonly permissions: readonly string[];
  readonly status: 'active' | 'disabled';
  /** Server-list rows: shown, never editable here. */
  readonly locked: boolean;
  /** The signed-in admin's own row: read-only. */
  readonly self: boolean;
  readonly addedByEmail: string | null;
  readonly createdAt: string | null;
  readonly disabledAt: string | null;
  readonly disabledReason: string | null;
  readonly lastStepUpAt: string | null;
}

export interface PlatformTeamView {
  readonly admins: readonly PlatformTeamMemberView[];
  readonly permissionCount: number;
  readonly superAdmins: number;
  readonly envSuperAdmins: number;
  /** Whether the viewer may add, edit and disable (holds `platform.team.manage`). */
  readonly canManage: boolean;
}

export interface PlatformPresetView {
  readonly preset: PlatformPreset;
  readonly permissions: readonly string[];
  /** The code default, for "Restore defaults". */
  readonly defaults: readonly string[];
  readonly editable: boolean;
  readonly adminCount: number;
}

export interface PlatformPresetsView {
  readonly presets: readonly PlatformPresetView[];
  readonly allPermissions: readonly string[];
  readonly canManage: boolean;
}

export interface PlatformTeamWriteView {
  readonly admin: PlatformTeamMemberView;
}

interface AddInput {
  readonly userId?: unknown;
  readonly email?: unknown;
  readonly preset?: unknown;
  readonly permissions?: unknown;
  readonly reason?: unknown;
}

interface UpdateInput {
  readonly preset?: unknown;
  readonly permissions?: unknown;
  readonly status?: unknown;
  readonly reason?: unknown;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export class PlatformTeamService {
  constructor(
    private readonly store: TeamStore,
    private readonly allowlist: readonly string[],
  ) {}

  async list(
    actor: PlatformAdminActor,
    context: PlatformRequestContext,
  ): Promise<PlatformTeamView> {
    const [rows, envUsers] = await Promise.all([
      this.store.listTeam(context.correlationId),
      this.store.findUsersByEmails(this.allowlist, context.correlationId),
    ]);
    const admins = this.members(actor, rows, envUsers);
    const envSuperAdmins = admins.filter((admin) => admin.source === 'env').length;
    return {
      admins,
      permissionCount: PLATFORM_PERMISSIONS.length,
      superAdmins: admins.filter(
        (admin) => admin.preset === 'super_admin' && admin.status === 'active',
      ).length,
      envSuperAdmins,
      canManage: (actor.permissions ?? []).includes('platform.team.manage'),
    };
  }

  async add(
    actor: PlatformAdminActor,
    body: AddInput,
    context: PlatformRequestContext,
  ): Promise<PlatformTeamWriteView> {
    const preset = requirePreset(body?.preset);
    const custom = customListFor(preset, body?.permissions);
    const reason = requireReason(body?.reason);
    const user = await this.findTarget(body, context);
    if (user.userId === actor.account.userId) throw ownRow();
    if (isPlatformAdminEmail(this.allowlist, user.email)) throw locked();
    const existing = (await this.store.listTeam(context.correlationId)).find(
      (row) => row.userId === user.userId,
    );
    if (existing) {
      throw new ApiError(
        409,
        'conflict',
        existing.status === 'active'
          ? 'This person is already a platform admin.'
          : 'This person is disabled. Enable them instead.',
      );
    }
    const permissions = platformPermissionsFor(preset, custom, await this.presets(context));
    const id = await this.store.insert(
      { userId: user.userId, preset, customPermissions: custom, createdBy: actor.account.userId },
      platformAuditFor(actor, context, {
        action: 'platform.team_admin_added',
        targetType: 'platform_admin',
        targetId: null,
        targetLabel: user.email,
        reason,
        afterJson: redactedJson({ preset, permissions, status: 'active' }),
      }),
    );
    return { admin: await this.memberById(actor, id, context) };
  }

  async update(
    actor: PlatformAdminActor,
    rawId: unknown,
    body: UpdateInput,
    context: PlatformRequestContext,
  ): Promise<PlatformTeamWriteView> {
    const id = requireId(rawId);
    const { row, label } = await this.editable(actor, id, context);
    const preset = body?.preset === undefined ? row.preset : requirePreset(body.preset);
    const custom =
      preset !== 'custom'
        ? null
        : body?.permissions === undefined && row.preset === 'custom'
          ? [...(row.customPermissions ?? [])]
          : requirePermissionList(body?.permissions ?? []);
    const status = body?.status === undefined ? row.status : requireStatus(body.status);
    const reason = requireReason(body?.reason);
    await this.keepOneSuperAdmin(row, preset, status, context);
    const action =
      status !== row.status
        ? status === 'disabled'
          ? 'platform.team_admin_disabled'
          : 'platform.team_admin_enabled'
        : 'platform.team_admin_updated';
    await this.write(actor, row, label, { preset, custom, status, reason, action }, context);
    return { admin: await this.memberById(actor, id, context) };
  }

  /** `DELETE team/:adminId` — the row stays (no DELETE grant) as `disabled`, the reason kept. */
  async remove(
    actor: PlatformAdminActor,
    rawId: unknown,
    body: { readonly reason?: unknown },
    context: PlatformRequestContext,
  ): Promise<PlatformTeamWriteView> {
    const id = requireId(rawId);
    const { row, label } = await this.editable(actor, id, context);
    const reason = requireReason(body?.reason);
    await this.keepOneSuperAdmin(row, row.preset, 'disabled', context);
    await this.write(
      actor,
      row,
      label,
      {
        preset: row.preset,
        custom: row.customPermissions ? [...row.customPermissions] : null,
        status: 'disabled',
        reason,
        action: 'platform.team_admin_removed',
      },
      context,
    );
    return { admin: await this.memberById(actor, id, context) };
  }

  async presetsView(
    actor: PlatformAdminActor,
    context: PlatformRequestContext,
  ): Promise<PlatformPresetsView> {
    const [stored, team] = await Promise.all([this.presets(context), this.list(actor, context)]);
    const count = (preset: PlatformPreset) =>
      team.admins.filter((admin) => admin.preset === preset && admin.status === 'active').length;
    const order: PlatformPreset[] = ['super_admin', 'support', 'auditor', 'custom'];
    return {
      allPermissions: [...PLATFORM_PERMISSIONS],
      canManage: team.canManage,
      presets: order.map((preset) => ({
        preset,
        permissions: preset === 'custom' ? [] : platformPermissionsFor(preset, null, stored),
        defaults: preset === 'custom' ? [] : platformPermissionsFor(preset, null, {}),
        editable: preset === 'support' || preset === 'auditor',
        adminCount: count(preset),
      })),
    };
  }

  async writePreset(
    actor: PlatformAdminActor,
    rawPreset: unknown,
    body: { readonly permissions?: unknown; readonly reason?: unknown },
    context: PlatformRequestContext,
  ): Promise<PlatformPresetsView> {
    const preset: EditablePlatformPreset = requireEditablePreset(rawPreset);
    const permissions = requirePermissionList(body?.permissions);
    const reason = requireReason(body?.reason);
    const before = platformPermissionsFor(preset, null, await this.presets(context));
    await this.store.writePreset(
      preset,
      permissions,
      platformAuditFor(actor, context, {
        action: 'platform.team_preset_updated',
        targetType: 'platform_preset',
        targetId: null,
        targetLabel: preset,
        reason,
        beforeJson: redactedJson({ permissions: before }),
        afterJson: redactedJson({ permissions }),
      }),
    );
    return this.presetsView(actor, context);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private presets(context: PlatformRequestContext) {
    return this.store.storedPresets(context.correlationId);
  }

  private async findTarget(
    body: AddInput,
    context: PlatformRequestContext,
  ): Promise<PlatformUserRow> {
    let user: PlatformUserRow | null = null;
    if (typeof body?.userId === 'string' && body.userId !== '') {
      user = await this.store.findUserById(requireId(body.userId), context.correlationId);
    } else if (typeof body?.email === 'string' && body.email.trim() !== '') {
      const email = body.email.trim().toLowerCase();
      if (email.length > 254) throw noAccount();
      user = await this.store.findUserByEmail(email, context.correlationId);
    } else {
      throw new ApiError(400, 'validation_failed', 'Enter the email of a TManage account.', [
        { field: 'email', message: 'required' },
      ]);
    }
    if (!user || !user.emailVerified) throw noAccount();
    return user;
  }

  private async editable(
    actor: PlatformAdminActor,
    id: string,
    context: PlatformRequestContext,
  ): Promise<{ row: PlatformAdminRecord; label: string }> {
    const row = await this.store.findById(id, context.correlationId);
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    if (row.userId === actor.account.userId) throw ownRow();
    const user = await this.store.findUserById(row.userId, context.correlationId);
    if (user && isPlatformAdminEmail(this.allowlist, user.email)) throw locked();
    return { row, label: user?.email ?? row.userId };
  }

  /** Refuse a change that would leave no active super admin. The server list counts. */
  private async keepOneSuperAdmin(
    row: PlatformAdminRecord,
    preset: PlatformPreset,
    status: PlatformAdminStatus,
    context: PlatformRequestContext,
  ): Promise<void> {
    const wasSuper = row.preset === 'super_admin' && row.status === 'active';
    const staysSuper = preset === 'super_admin' && status === 'active';
    if (!wasSuper || staysSuper) return;
    const team = await this.store.listTeam(context.correlationId);
    const envUsers = await this.store.findUsersByEmails(this.allowlist, context.correlationId);
    const envIds = new Set(envUsers.map((user) => user.userId));
    const remainingDb = team.filter(
      (other) =>
        other.id !== row.id &&
        other.preset === 'super_admin' &&
        other.status === 'active' &&
        !envIds.has(other.userId),
    ).length;
    if (remainingDb + this.allowlist.length < 1) {
      throw new ApiError(
        409,
        'conflict',
        'At least one super admin must remain, so nobody can lock the platform out.',
      );
    }
  }

  private async write(
    actor: PlatformAdminActor,
    row: PlatformAdminRecord,
    label: string,
    next: {
      readonly preset: PlatformPreset;
      readonly custom: PlatformPermission[] | null;
      readonly status: PlatformAdminStatus;
      readonly reason: string;
      readonly action: string;
    },
    context: PlatformRequestContext,
  ): Promise<void> {
    const stored = await this.presets(context);
    const after = platformPermissionsFor(next.preset, next.custom, stored);
    await this.store.update(
      row.id,
      {
        preset: next.preset,
        customPermissions: next.custom,
        status: next.status,
        disabledReason: next.status === 'disabled' ? next.reason : null,
      },
      platformAuditFor(actor, context, {
        action: next.action,
        targetType: 'platform_admin',
        targetId: row.id,
        targetLabel: label,
        reason: next.reason,
        beforeJson: redactedJson({
          preset: row.preset,
          permissions: row.permissions,
          status: row.status,
        }),
        afterJson: redactedJson({ preset: next.preset, permissions: after, status: next.status }),
      }),
    );
  }

  private async memberById(
    actor: PlatformAdminActor,
    id: string,
    context: PlatformRequestContext,
  ): Promise<PlatformTeamMemberView> {
    const team = await this.list(actor, context);
    const member = team.admins.find((admin) => admin.id === id);
    if (!member) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return member;
  }

  private members(
    actor: PlatformAdminActor,
    rows: readonly PlatformTeamRow[],
    envUsers: readonly PlatformUserRow[],
  ): PlatformTeamMemberView[] {
    const envIds = new Set<string>();
    const env: PlatformTeamMemberView[] = this.allowlist.map((email) => {
      const user = envUsers.find((candidate) => candidate.email.toLowerCase() === email);
      if (user) envIds.add(user.userId);
      return {
        id: null,
        userId: user?.userId ?? null,
        email,
        displayName: user?.displayName ?? null,
        source: 'env',
        preset: 'super_admin',
        permissions: [...PLATFORM_PERMISSIONS],
        status: 'active',
        locked: true,
        self: user?.userId === actor.account.userId,
        addedByEmail: null,
        createdAt: null,
        disabledAt: null,
        disabledReason: null,
        lastStepUpAt: iso(user?.lastStepUpAt ?? null),
      };
    });
    // A team row for a server-list person changes nothing (the list wins), so it is not shown.
    const db: PlatformTeamMemberView[] = rows
      .filter((row) => !envIds.has(row.userId))
      .map((row) => ({
        id: row.id,
        userId: row.userId,
        email: row.email,
        displayName: row.displayName,
        source: 'db',
        preset: row.preset,
        permissions: [...row.permissions],
        status: row.status,
        locked: false,
        self: row.userId === actor.account.userId,
        addedByEmail: row.createdByEmail,
        createdAt: iso(row.createdAt),
        disabledAt: iso(row.disabledAt),
        disabledReason: row.disabledReason,
        lastStepUpAt: iso(row.lastStepUpAt),
      }));
    return [...env, ...db];
  }
}

function requireStatus(raw: unknown): PlatformAdminStatus {
  if (raw !== 'active' && raw !== 'disabled') {
    throw new ApiError(400, 'validation_failed', 'Choose active or disabled.', [
      { field: 'status', message: 'active or disabled' },
    ]);
  }
  return raw;
}

function ownRow(): ApiError {
  return new ApiError(409, 'conflict', 'Your own row is read-only. Ask another super admin.');
}

function locked(): ApiError {
  return new ApiError(
    409,
    'conflict',
    'This admin is on the server list and is managed in Hostinger.',
  );
}

function noAccount(): ApiError {
  return new ApiError(404, 'not_found', 'No verified TManage account has that email.', [
    { field: 'email', message: 'no verified account' },
  ]);
}
