import { ApiError } from '../../../common/http/errors.js';
import { PLAN_IDS } from '../../billing/plan-catalog.js';
import type { CatalogPlanId } from '../../billing/plan-catalog.js';
import { MAX_NAME_LENGTH, slugProblem } from '../../tenancy/organization-input.js';
import { OrganizationSlugTakenError } from '../../tenancy/provisioning.service.js';
import type { ProvisioningService } from '../../tenancy/provisioning.service.js';
import { optionalReason } from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { RequestContext } from '../platform-admin.service.js';
import { platformAuditFor } from '../platform-audit.service.js';
import { isDuplicateSlug, PlatformOrganizationsRepository } from './organizations.repository.js';
import { slugTaken } from './organizations.service.js';
import type {
  PlatformOrganizationsService,
  PlatformOrgWriteView,
} from './organizations.service.js';

/**
 * Platform admin · New organization (A2 dialog; SPEC §6). The operator provisions an organization
 * for a customer through the same `ProvisioningService` sign-up uses — organization, first
 * workspace, the owner's membership and `organization.provisioned`, in one transaction — then sets
 * the plan with the platform audit row (`platform.organization_created`, reason optional).
 *
 * The owner must already have a TManage account: an invitation the platform issues cannot be
 * accepted today (acceptance re-checks that the inviter is still an active owner of the
 * organization, and the operator is not one). Until that rule has a platform exception, an
 * unknown address is refused with a plain sentence instead of creating an organization nobody
 * can enter.
 */

export interface CreateOrganizationInput {
  readonly name?: unknown;
  readonly slug?: unknown;
  readonly ownerEmail?: unknown;
  readonly plan?: unknown;
  readonly reason?: unknown;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class PlatformOrganizationProvisioning {
  constructor(
    private readonly organizations: PlatformOrganizationsService,
    private readonly orgs: PlatformOrganizationsRepository,
    private readonly provisioning: ProvisioningService | null,
  ) {}

  async create(
    actor: PlatformAdminActor,
    input: CreateOrganizationInput,
    context: RequestContext,
  ): Promise<PlatformOrgWriteView> {
    const reason = optionalReason(input?.reason);
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (name === '' || name.length > MAX_NAME_LENGTH) {
      throw new ApiError(400, 'validation_failed', 'Type the organization name.', [
        { field: 'name', message: 'required' },
      ]);
    }
    const slug = typeof input?.slug === 'string' ? input.slug.trim().toLowerCase() : '';
    const problem = slugProblem(slug);
    if (problem)
      throw new ApiError(400, 'validation_failed', problem, [{ field: 'slug', message: problem }]);
    const email =
      typeof input?.ownerEmail === 'string' ? input.ownerEmail.trim().toLowerCase() : '';
    if (!EMAIL.test(email) || email.length > 254) {
      throw new ApiError(400, 'validation_failed', 'Type the owner’s email address.', [
        { field: 'ownerEmail', message: 'email' },
      ]);
    }
    let plan: CatalogPlanId | null = null;
    if (input?.plan !== undefined && input.plan !== null && input.plan !== '') {
      if (!(PLAN_IDS as readonly unknown[]).includes(input.plan)) {
        throw new ApiError(400, 'validation_failed', 'Choose a listed plan.', [
          { field: 'plan', message: 'unknown' },
        ]);
      }
      plan = input.plan as CatalogPlanId;
    }
    if ((await this.orgs.slugOwner(slug, context.correlationId)) !== null) throw slugTaken();
    const owner = await this.orgs.findUserByEmail(email, context.correlationId);
    if (!owner) {
      throw new ApiError(
        404,
        'not_found',
        'No TManage account uses this address yet. Ask the owner to sign up, then create the organization.',
        [{ field: 'ownerEmail', message: 'unknown' }],
      );
    }
    if (!this.provisioning)
      throw new ApiError(500, 'internal_error', 'Organizations cannot be created right now.');
    let organizationId: string;
    try {
      const created = await this.provisioning.provisionOrganization({
        userId: owner.id,
        slug,
        name,
        defaultLocale: 'en',
        timezone: 'UTC',
        correlationId: context.correlationId,
      });
      organizationId = created.organizationId;
    } catch (error) {
      if (error instanceof OrganizationSlugTakenError || isDuplicateSlug(error)) throw slugTaken();
      throw error;
    }
    await this.orgs.write(
      organizationId,
      {
        ...platformAuditFor(actor, context, {
          action: 'platform.organization_created',
          targetType: 'organization',
          targetId: organizationId,
          targetLabel: name,
          organizationId,
          reason,
        }),
        afterJson: JSON.stringify({ name, slug, ownerUserId: owner.id, plan }),
      },
      async (tx) => {
        if (plan !== null)
          await PlatformOrganizationsRepository.setPlan(tx, organizationId, plan, null);
      },
    );
    return this.organizations.written(organizationId, context);
  }
}
