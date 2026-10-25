import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
} from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { MemberNotesService } from './member-notes.service.js';
import type { MemberAdminNoteView } from './member-notes.service.js';
import { MemberNotesRepository } from './member-notes.repository.js';
import type { AuditService } from '../audit/audit.service.js';

/**
 * Admin private member notes (Administration module 18, x280). An org admin's private, internal notes
 * about a member: add a note, list a member's notes, delete one — all keyed by the member's membership
 * id in the path, all behind `org.manage`. A note is an HR-style annotation, never shown to the member
 * it is about: this `org.manage`-gated surface is its only reader, and (wave 9 S8, F56) a caller's
 * own membership is a 404 on every route. Adding and deleting a note are audited.
 *
 * Like every tenant-scoped controller here it never reads `organizationId` (or the acting membership)
 * from the body, a header, or its `:orgSlug` segment: it receives the `TenantContext` that
 * `TenantContextGuard` built from a membership row and passes it on. The `:membershipId` in the path is
 * resolved tenant-scoped **before** the write in the service (the Known trap): a cross-tenant or
 * unknown membership id is a 404 with nothing written, decided before the `org.manage` authorize.
 *
 * Its own module (registered in `app.module.ts`) so the slice touches no file another admin slice in
 * the same pass appends to.
 */

const MEMBER_NOTES_SERVICE = Symbol.for('tmanage.MemberNotesService');

/** Add-a-note request body. */
interface AddNoteBody {
  readonly body?: unknown;
}

@Controller('v1/organizations/:orgSlug/admin/members/:membershipId/notes')
export class MemberNotesController {
  constructor(@Inject(MEMBER_NOTES_SERVICE) private readonly notes: MemberNotesService) {}

  /** List a member's private notes, newest first, for an `org.manage` holder. */
  @Get()
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
  ): Promise<{ readonly notes: readonly MemberAdminNoteView[] }> {
    requireMembershipId(membershipId);
    return { notes: await this.notes.list(context, principal, membershipId) };
  }

  /** Add a private note to a member (`org.manage`). An empty body is a 400 with no insert. */
  @Post()
  @RequireCapability('org.manage')
  @HttpCode(201)
  async add(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
    @Body() body: AddNoteBody,
  ): Promise<MemberAdminNoteView> {
    requireMembershipId(membershipId);

    const noteBody = typeof body?.body === 'string' ? body.body.trim() : undefined;
    if (noteBody === undefined || noteBody === '') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'body', message: 'must be a non-empty string' },
      ]);
    }
    if (noteBody.length > MemberNotesService.maxBodyLength) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        {
          field: 'body',
          message: `must be ${MemberNotesService.maxBodyLength} characters or fewer`,
        },
      ]);
    }

    return this.notes.add(context, principal, membershipId, noteBody);
  }

  /** Delete a private note from a member (`org.manage`). An unknown or foreign note id is a 404. */
  @Delete(':noteId')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
    @Param('noteId') noteId: string,
  ): Promise<void> {
    requireMembershipId(membershipId);
    if (typeof noteId !== 'string' || noteId === '') {
      throw new ApiError(400, 'validation_failed', 'noteId is required', [
        { field: 'noteId', message: 'must be a non-empty string' },
      ]);
    }
    await this.notes.remove(context, principal, membershipId, noteId);
  }
}

/** A path `membershipId` is always required and always a non-empty string. */
function requireMembershipId(membershipId: unknown): asserts membershipId is string {
  if (typeof membershipId !== 'string' || membershipId === '') {
    throw new ApiError(400, 'validation_failed', 'membershipId is required', [
      { field: 'membershipId', message: 'must be a non-empty string' },
    ]);
  }
}

/**
 * x280's wiring — a self-contained module registered from `app.module.ts` (the shared append point),
 * file-disjoint from the other admin surfaces. The service resolves the subject membership
 * tenant-scoped through its `MemberNotesRepository` (the Known-trap order) and appends/lists/deletes
 * through the same repository, so it needs only the tenant database injected.
 */
@Module({})
export class MemberNotesModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: MEMBER_NOTES_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE],
      useFactory: (database: TenantDatabase, audit: AuditService) =>
        new MemberNotesService(database, new MemberNotesRepository(), audit),
    };

    return {
      module: MemberNotesModule,
      providers: [service],
      controllers: [MemberNotesController],
    };
  }
}
