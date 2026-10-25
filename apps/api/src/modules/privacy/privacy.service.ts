import type { Principal } from '@tmanage/domain';
import { ObjectNotFoundError } from '@tmanage/storage';
import type { ObjectStore } from '@tmanage/storage';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { PrivacyDeletionRequestRow, PrivacyExportRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { readDownloadScanPolicy } from '../tenancy/download-scan-policy.js';
import type { ScannerPresence } from '../tenancy/download-scan-policy.js';
import { archiveFileName } from './privacy-archive.repository.js';
import {
  DELETION_GRACE_PERIOD_DAYS,
  EXPORT_LINK_DAYS,
  addDays,
  confirmsCompanyName,
  daysLeft,
  exportStateOf,
} from './privacy-policy.js';
import type { PrivacyExportState } from './privacy-policy.js';
import { PrivacyRepository } from './privacy.repository.js';
import type { PrivacyMemberRow } from './privacy.repository.js';

/**
 * D5 (Figma F5, 390:23496) — the data-rights workflow behind Control › Privacy and the phone's
 * "My data".
 *
 * Two audiences, two doors:
 *
 * - **The company's owners** (`/admin/privacy`). Only an owner may export the whole company, export
 *   one member's personal data, or ask for the company to be deleted (and cancel that). Admins hold
 *   `org.manage` too, so the decorator is the coarse gate and `requireOwner` is the rule.
 * - **Every internal member, about themselves** (`/me/privacy`). Their own personal-data export and
 *   their own account deletion. An owner's export of a member comes to the owner, not to the member
 *   ("The file comes to you, not to them"), so it is never listed on the member's own page.
 *
 * Nothing here builds an archive or deletes anything: a request is a row. The in-process privacy job
 * (`privacy-job.ts`) builds archives through the scanner and carries out deletions after the grace
 * period. A download is served only for a `ready`, unexpired archive, to the person allowed to have
 * it, under the owner's "downloads before a virus scan" policy.
 */

export interface PrivacyPersonView {
  readonly userId: string;
  readonly displayName: string;
}

export interface PrivacyExportView {
  readonly id: string;
  readonly kind: 'company' | 'member';
  readonly state: PrivacyExportState;
  readonly progressPercent: number;
  readonly sizeBytes: number | null;
  readonly scanStatus: 'clean' | 'not_scanned' | null;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly expiresAt: string | null;
  readonly requestedBy: PrivacyPersonView;
  readonly subject: PrivacyPersonView | null;
}

export interface PrivacyDeletionView {
  readonly id: string;
  readonly kind: 'company' | 'account';
  readonly requestedAt: string;
  readonly scheduledFor: string;
  readonly daysLeft: number;
  readonly requestedBy: PrivacyPersonView;
}

export interface PrivacyMemberOptionView {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly jobTitle: string | null;
  readonly role: string;
}

export interface PrivacyOverviewView {
  readonly organizationName: string;
  readonly memberCount: number;
  readonly gracePeriodDays: number;
  readonly linkDays: number;
  /** The company exports, newest first; the first is the current one. */
  readonly companyExports: readonly PrivacyExportView[];
  /** The latest member export per person, newest first. */
  readonly memberExports: readonly PrivacyExportView[];
  readonly members: readonly PrivacyMemberOptionView[];
  readonly deletion: PrivacyDeletionView | null;
}

export interface MyPrivacyView {
  readonly organizationName: string;
  readonly gracePeriodDays: number;
  readonly linkDays: number;
  readonly export: PrivacyExportView | null;
  readonly deletion: PrivacyDeletionView | null;
}

/** What the download route streams. */
export interface PrivacyDownload {
  readonly stream: NodeJS.ReadableStream;
  readonly sizeBytes: number;
  readonly fileName: string;
  readonly scanStatus: 'clean' | 'not_scanned';
}

/** Asks the privacy job for a pass soon (an export was just requested). */
export interface PrivacyJobRequester {
  request(): void;
}

const COMPANY_EXPORT_LIMIT = 10;
const MEMBER_EXPORT_LIMIT = 100;
const MEMBER_EXPORTS_SHOWN = 20;

export class PrivacyService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly store: ObjectStore,
    private readonly audit: AuditService | undefined,
    private readonly outbox: OutboxEventsRepository | undefined,
    private readonly scanner: ScannerPresence | undefined,
    private readonly job: PrivacyJobRequester | undefined,
    private readonly repository: PrivacyRepository = new PrivacyRepository(),
    private readonly now: () => Date = () => new Date(),
    /** The owner's effective "downloads before a virus scan" value (B3); injectable for a test. */
    private readonly scanPolicy: (
      context: TenantContext,
    ) => Promise<'block' | 'allow_labeled'> = async (context) =>
      (await readDownloadScanPolicy(this.database, context, this.scanner)).effective,
  ) {}

  // ── Owners ─────────────────────────────────────────────────────────────────────────────────────

  async overview(context: TenantContext, principal: Principal): Promise<PrivacyOverviewView> {
    requireOwner(principal);
    const now = this.now();
    return this.database.read(context, async (runner) => {
      const org = await this.requireOrganization(runner, context);
      const members = await this.repository.activeMembers(runner, context);
      const company = await this.repository.listExports(runner, context, {
        kind: 'company',
        limit: COMPANY_EXPORT_LIMIT,
      });
      // The owner's member exports: the latest per person, only those this owner asked for.
      const memberRows = await this.repository.listExports(runner, context, {
        kind: 'member',
        requestedByUserId: principal.userId,
        limit: MEMBER_EXPORT_LIMIT,
      });
      const latest = latestPerSubject(memberRows).slice(0, MEMBER_EXPORTS_SHOWN);
      const deletion = await this.repository.activeDeletion(runner, context, 'company', null);
      const names = await this.repository.displayNames(runner, context, [
        ...company.map((row) => row.requestedByUserId),
        ...latest.flatMap((row) => [row.requestedByUserId, row.subjectUserId ?? '']),
        ...(deletion ? [deletion.requestedByUserId] : []),
      ]);
      return {
        organizationName: org.name,
        memberCount: members.length,
        gracePeriodDays: DELETION_GRACE_PERIOD_DAYS,
        linkDays: EXPORT_LINK_DAYS,
        companyExports: company.map((row) => toExportView(row, names, now)),
        memberExports: latest.map((row) => toExportView(row, names, now)),
        members: members.map(toMemberOption),
        deletion: deletion ? toDeletionView(deletion, names, now) : null,
      };
    });
  }

  /** `{ kind: 'company' }` or `{ kind: 'member', membershipId }`. Owner-only. */
  async requestOwnerExport(
    context: TenantContext,
    principal: Principal,
    body: { readonly kind?: unknown; readonly membershipId?: unknown } | undefined,
  ): Promise<PrivacyOverviewView> {
    requireOwner(principal);
    const kind = body?.kind;
    if (kind !== 'company' && kind !== 'member') {
      throw validation('kind', 'Choose what to export.');
    }
    await this.database.transaction(context, async (tx) => {
      await this.requireOrganization(tx, context);
      let subjectUserId: string | null = null;
      if (kind === 'member') {
        const membershipId = body?.membershipId;
        if (typeof membershipId !== 'string' || membershipId === '') {
          throw validation('membershipId', 'Choose the person.');
        }
        const members = await this.repository.activeMembers(tx, context);
        const member = members.find((row) => row.membershipId === membershipId);
        if (!member) throw new ApiError(404, 'not_found', MESSAGES.notFound);
        subjectUserId = member.userId;
      }
      await this.insertExport(tx, context, principal, kind, subjectUserId);
    });
    this.job?.request();
    return this.overview(context, principal);
  }

  async requestCompanyDeletion(
    context: TenantContext,
    principal: Principal,
    body: { readonly confirmName?: unknown } | undefined,
  ): Promise<PrivacyOverviewView> {
    requireOwner(principal);
    await this.database.transaction(context, async (tx) => {
      const org = await this.requireOrganization(tx, context);
      if (!confirmsCompanyName(body?.confirmName, org.name)) {
        throw validation('confirmName', 'Type the company name exactly as it is shown.');
      }
      await this.repository.lockOrganization(tx, context);
      const active = await this.repository.activeDeletion(tx, context, 'company', null);
      if (active) throw alreadyRequested();
      await this.insertDeletion(tx, context, principal, 'company', null);
    });
    return this.overview(context, principal);
  }

  async cancelCompanyDeletion(
    context: TenantContext,
    principal: Principal,
  ): Promise<PrivacyOverviewView> {
    requireOwner(principal);
    await this.database.transaction(context, async (tx) => {
      await this.requireOrganization(tx, context);
      await this.repository.lockOrganization(tx, context);
      const active = await this.repository.activeDeletion(tx, context, 'company', null);
      if (!active) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      await this.cancel(tx, context, principal, active);
    });
    return this.overview(context, principal);
  }

  // ── Every member, about themselves ─────────────────────────────────────────────────────────────

  async mine(context: TenantContext, principal: Principal): Promise<MyPrivacyView> {
    requireInternal(principal);
    const now = this.now();
    return this.database.read(context, async (runner) => {
      const org = await this.requireOrganization(runner, context);
      const own = await this.repository.listExports(runner, context, {
        kind: 'member',
        subjectUserId: principal.userId,
        requestedByUserId: principal.userId,
        limit: 1,
      });
      const deletion = await this.repository.activeDeletion(
        runner,
        context,
        'account',
        principal.userId,
      );
      const names = await this.repository.displayNames(runner, context, [principal.userId]);
      const latest = own[0];
      return {
        organizationName: org.name,
        gracePeriodDays: DELETION_GRACE_PERIOD_DAYS,
        linkDays: EXPORT_LINK_DAYS,
        export: latest ? toExportView(latest, names, now) : null,
        deletion: deletion ? toDeletionView(deletion, names, now) : null,
      };
    });
  }

  async requestMyExport(context: TenantContext, principal: Principal): Promise<MyPrivacyView> {
    requireInternal(principal);
    await this.database.transaction(context, async (tx) => {
      await this.requireOrganization(tx, context);
      await this.insertExport(tx, context, principal, 'member', principal.userId);
    });
    this.job?.request();
    return this.mine(context, principal);
  }

  async requestMyDeletion(context: TenantContext, principal: Principal): Promise<MyPrivacyView> {
    requireInternal(principal);
    await this.database.transaction(context, async (tx) => {
      await this.requireOrganization(tx, context);
      await this.repository.lockOrganization(tx, context);
      // The last owner cannot leave: the company would be left with nobody who can run it.
      if (
        principal.role === 'owner' &&
        (await this.repository.activeOwnerCount(tx, context)) <= 1
      ) {
        throw new ApiError(
          409,
          'conflict',
          'You are the only owner. Make someone else an owner before you delete your account.',
          [{ field: 'status', message: 'last_owner' }],
          'privacy_deletion.last_owner',
        );
      }
      const active = await this.repository.activeDeletion(tx, context, 'account', principal.userId);
      if (active) throw alreadyRequested();
      await this.insertDeletion(tx, context, principal, 'account', principal.userId);
    });
    return this.mine(context, principal);
  }

  async cancelMyDeletion(context: TenantContext, principal: Principal): Promise<MyPrivacyView> {
    requireInternal(principal);
    await this.database.transaction(context, async (tx) => {
      await this.requireOrganization(tx, context);
      await this.repository.lockOrganization(tx, context);
      const active = await this.repository.activeDeletion(tx, context, 'account', principal.userId);
      if (!active) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      await this.cancel(tx, context, principal, active);
    });
    return this.mine(context, principal);
  }

  // ── Downloads ──────────────────────────────────────────────────────────────────────────────────

  /** `door`: `owner` for /admin/privacy, `self` for /me/privacy. */
  async download(
    context: TenantContext,
    principal: Principal,
    exportId: string,
    door: 'owner' | 'self',
  ): Promise<PrivacyDownload> {
    if (door === 'owner') requireOwner(principal);
    else requireInternal(principal);

    const row = await this.database.read(context, (runner) =>
      this.repository.findExport(runner, context, exportId),
    );
    // Not found, and not yours, read the same: one 404.
    if (!row || !mayDownload(row, principal, door)) {
      await this.audit?.recordDenial(context, 'privacy_export.downloaded', {
        status: 404,
        auditCode: 'privacy_export_not_available',
      });
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        'privacy_export_not_found',
      );
    }

    const now = this.now();
    const state = exportStateOf(row, now);
    if (state === 'expired') {
      throw new ApiError(
        409,
        'conflict',
        'This download link has expired. Ask for a new export.',
        [{ field: 'status', message: 'expired' }],
        'privacy_export.expired',
      );
    }
    if (state !== 'ready' || row.objectKey === null || row.sizeBytes === null) {
      throw new ApiError(
        409,
        'conflict',
        'This export is not ready yet.',
        [{ field: 'status', message: state }],
        'privacy_export.not_ready',
      );
    }
    const scanStatus = row.scanStatus ?? 'not_scanned';
    if (scanStatus === 'not_scanned') {
      if ((await this.scanPolicy(context)) === 'block') {
        throw new ApiError(
          409,
          'conflict',
          'Your company allows downloads only after the virus scan. Try again once it has been checked',
          [{ field: 'status', message: 'scan_required_by_policy' }],
          'privacy_export.blocked_by_policy',
        );
      }
    }

    let opened;
    try {
      opened = await this.store.openObject({ zone: 'private', objectKey: row.objectKey });
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        throw new ApiError(
          404,
          'not_found',
          MESSAGES.notFound,
          undefined,
          'privacy_export_missing',
        );
      }
      throw error;
    }
    if (opened.sizeBytes !== row.sizeBytes) {
      destroy(opened.stream);
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'privacy_export_size');
    }

    try {
      await this.database.transaction(context, async (tx) => {
        await this.audit?.record(tx, context, {
          action: 'privacy_export.downloaded',
          objectId: row.id,
          result: 'allowed',
          actorUserId: principal.userId,
          metadata: { kind: row.kind, size_bytes: row.sizeBytes ?? 0, scan_status: scanStatus },
        });
      });
    } catch (error) {
      destroy(opened.stream);
      throw error;
    }

    return {
      stream: opened.stream,
      sizeBytes: row.sizeBytes,
      fileName: archiveFileName(row.kind, row.completedAt ?? row.requestedAt),
      scanStatus,
    };
  }

  // ── Shared steps ───────────────────────────────────────────────────────────────────────────────

  private async requireOrganization(runner: TenantQueryRunner, context: TenantContext) {
    const org = await this.repository.organization(runner, context);
    if (!org) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return org;
  }

  private async insertExport(
    tx: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    kind: 'company' | 'member',
    subjectUserId: string | null,
  ): Promise<void> {
    // One archive in preparation per subject at a time: a second click waits for the first.
    const recent = await this.repository.listExports(tx, context, {
      kind,
      ...(subjectUserId !== null ? { subjectUserId } : {}),
      limit: 5,
    });
    if (recent.some((row) => row.status === 'preparing')) {
      throw new ApiError(
        409,
        'conflict',
        'An export is already being prepared.',
        [{ field: 'status', message: 'preparing' }],
        'privacy_export.already_preparing',
      );
    }
    const now = this.now();
    const id = await this.repository.insertExport(tx, context, {
      kind,
      subjectUserId,
      requestedByUserId: principal.userId,
      now,
    });
    await this.audit?.record(tx, context, {
      action: 'privacy_export.requested',
      objectId: id,
      result: 'allowed',
      actorUserId: principal.userId,
      metadata: { kind, ...(subjectUserId !== null ? { subject_user_id: subjectUserId } : {}) },
    });
  }

  private async insertDeletion(
    tx: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    kind: 'company' | 'account',
    subjectUserId: string | null,
  ): Promise<void> {
    const now = this.now();
    const scheduledFor = addDays(now, DELETION_GRACE_PERIOD_DAYS);
    const id = await this.repository.insertDeletion(tx, context, {
      kind,
      subjectUserId,
      requestedByUserId: principal.userId,
      now,
      scheduledFor,
    });
    await this.audit?.record(tx, context, {
      action: 'privacy_deletion.requested',
      objectId: id,
      result: 'allowed',
      actorUserId: principal.userId,
      metadata: { kind, scheduled_for: scheduledFor.toISOString() },
    });
    await this.outbox?.append(tx, context, {
      type: 'privacy_deletion.changed.v1',
      aggregateId: id,
      payload: {
        requestId: id,
        kind,
        status: 'scheduled',
        actorUserId: principal.userId,
        subjectUserId,
        scheduledFor: scheduledFor.toISOString(),
      },
    });
  }

  private async cancel(
    tx: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    row: PrivacyDeletionRequestRow,
  ): Promise<void> {
    const moved = await this.repository.cancelDeletion(
      tx,
      context,
      row,
      principal.userId,
      this.now(),
    );
    if (!moved) throw new ApiError(409, 'conflict', MESSAGES.conflict);
    await this.audit?.record(tx, context, {
      action: 'privacy_deletion.cancelled',
      objectId: row.id,
      result: 'allowed',
      actorUserId: principal.userId,
      metadata: { kind: row.kind },
    });
    await this.outbox?.append(tx, context, {
      type: 'privacy_deletion.changed.v1',
      aggregateId: row.id,
      payload: {
        requestId: row.id,
        kind: row.kind,
        status: 'cancelled',
        actorUserId: principal.userId,
        subjectUserId: row.subjectUserId,
        scheduledFor: row.scheduledFor.toISOString(),
      },
    });
  }
}

// ── Rules, pure ────────────────────────────────────────────────────────────────────────────────

/** Company-wide privacy acts are the company owner's alone. */
export function requireOwner(principal: Principal): void {
  if (principal.kind !== 'internal' || principal.role !== 'owner') {
    throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'privacy.owner_only');
  }
}

function requireInternal(principal: Principal): void {
  if (principal.kind !== 'internal') {
    throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'privacy.internal_only');
  }
}

/**
 * Who may have an archive. A company export: any owner (it is the company's). A member export through
 * the owner door: the owner who asked for it. Through the member's own door: only their own export of
 * themselves.
 */
export function mayDownload(
  row: Pick<PrivacyExportRow, 'kind' | 'requestedByUserId' | 'subjectUserId'>,
  principal: Pick<Principal, 'userId' | 'role'>,
  door: 'owner' | 'self',
): boolean {
  if (door === 'owner') {
    if (principal.role !== 'owner') return false;
    return row.kind === 'company' || row.requestedByUserId === principal.userId;
  }
  return (
    row.kind === 'member' &&
    row.subjectUserId === principal.userId &&
    row.requestedByUserId === principal.userId
  );
}

function latestPerSubject(rows: readonly PrivacyExportRow[]): readonly PrivacyExportRow[] {
  const seen = new Set<string>();
  const out: PrivacyExportRow[] = [];
  for (const row of rows) {
    const key = row.subjectUserId ?? '';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function person(userId: string, names: ReadonlyMap<string, string>): PrivacyPersonView {
  return { userId, displayName: names.get(userId) ?? '' };
}

export function toExportView(
  row: PrivacyExportRow,
  names: ReadonlyMap<string, string>,
  now: Date,
): PrivacyExportView {
  return {
    id: row.id,
    kind: row.kind,
    state: exportStateOf(row, now),
    progressPercent: row.status === 'ready' ? 100 : row.progressPercent,
    sizeBytes: row.sizeBytes ?? null,
    scanStatus: row.scanStatus ?? null,
    requestedAt: row.requestedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    requestedBy: person(row.requestedByUserId, names),
    subject: row.subjectUserId ? person(row.subjectUserId, names) : null,
  };
}

export function toDeletionView(
  row: PrivacyDeletionRequestRow,
  names: ReadonlyMap<string, string>,
  now: Date,
): PrivacyDeletionView {
  return {
    id: row.id,
    kind: row.kind,
    requestedAt: row.requestedAt.toISOString(),
    scheduledFor: row.scheduledFor.toISOString(),
    daysLeft: daysLeft(now, row.scheduledFor),
    requestedBy: person(row.requestedByUserId, names),
  };
}

function toMemberOption(row: PrivacyMemberRow): PrivacyMemberOptionView {
  return {
    membershipId: row.membershipId,
    userId: row.userId,
    displayName: row.displayName,
    jobTitle: row.jobTitle,
    role: row.role,
  };
}

function validation(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', message, [{ field, message }]);
}

function alreadyRequested(): ApiError {
  return new ApiError(
    409,
    'conflict',
    'A deletion is already scheduled.',
    [{ field: 'status', message: 'scheduled' }],
    'privacy_deletion.already_scheduled',
  );
}

function destroy(stream: unknown): void {
  const candidate = stream as { destroy?: () => void; destroyed?: boolean };
  if (typeof candidate.destroy === 'function' && !candidate.destroyed) candidate.destroy();
}
