import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { authorize, isClientRole } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { ContactSuggestionsService } from './contact-suggestions.service.js';
import type {
  ContactImportPreviewView,
  ContactImportView,
  ContactSuggestionView,
  ImportContactsBody,
} from './contact-suggestions.service.js';

/** Either of these lets an internal member keep invite suggestions (54-11 §Permissions). */
export const CONTACT_SUGGESTION_CAPABILITIES: readonly Capability[] = [
  'people.invite',
  'client_member.manage',
];

/**
 * 54-11 Phase 0 (R16-f) — the caller's own invite suggestions.
 *
 * Three routes, all on the caller's rows only (the repository predicates on the context's
 * `user_id`; no route takes a user id, and there is no organization-wide listing — the abuse rule
 * against harvesting addresses):
 *
 * - `POST …/contacts/import-file` `{format: 'csv' | 'vcard', text, mapping?, createClients?}` →
 *   counts, never addresses. `createClients` also needs `org.manage` (r46).
 * - `POST …/contacts/import-preview` (r46) → the caller's own file, row by row, before import.
 * - `GET  …/contacts/suggest?q=` → at most 20 of the caller's unexpired suggestions.
 * - `DELETE …/contacts/suggestions` → clear mine.
 *
 * ## The two authorization layers
 *
 * The route guard holds the floor `people.view` (every internal role has it). The decision the
 * guard cannot express — an internal principal holding `people.invite` OR `client_member.manage`,
 * with an active membership — is made here by the real `authorize()`, deny-by-default. A client
 * principal never passes, even though `client_admin` holds `client_member.manage`.
 */
@Controller('v1/organizations/:orgSlug/contacts')
export class ContactSuggestionsController {
  constructor(
    @Inject(ContactSuggestionsService) private readonly service: ContactSuggestionsService,
  ) {}

  @Post('import-file')
  @RequireCapability('people.view')
  @HttpCode(200)
  async importFile(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: ImportContactsBody,
  ): Promise<ContactImportView> {
    requireInviter(principal, context);
    return this.service.importFile(context, body, principal);
  }

  /** r46: what an import of this file would do (rows, duplicates by e-mail, errors). No write. */
  @Post('import-preview')
  @RequireCapability('people.view')
  @HttpCode(200)
  async preview(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: ImportContactsBody,
  ): Promise<ContactImportPreviewView> {
    requireInviter(principal, context);
    return this.service.preview(context, body);
  }

  @Get('suggest')
  @RequireCapability('people.view')
  async suggest(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('q') q: unknown,
  ): Promise<{ readonly suggestions: readonly ContactSuggestionView[] }> {
    requireInviter(principal, context);
    return { suggestions: await this.service.suggest(context, q) };
  }

  @Delete('suggestions')
  @RequireCapability('people.view')
  @HttpCode(204)
  async clear(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    requireInviter(principal, context);
    await this.service.clear(context);
  }
}

/** Internal, active, and allowed to invite people or client contacts — else 403. */
export function requireInviter(principal: Principal, context: TenantContext): void {
  const internal = principal.kind === 'internal' && !isClientRole(principal.role);
  const allowed =
    internal &&
    CONTACT_SUGGESTION_CAPABILITIES.some(
      (capability) =>
        authorize({
          principal,
          capability,
          resource: {
            organizationId: context.organizationId,
            projectId: null,
            audience: 'internal',
            lifecycle: 'active',
          },
        }).allowed,
    );
  if (!allowed) {
    throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'contacts_not_inviter');
  }
}
