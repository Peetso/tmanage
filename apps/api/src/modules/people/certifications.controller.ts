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
import type { DynamicModule } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { PersonCertificationsRepository } from './certifications.repository.js';
import { PersonCertificationsService } from './certifications.service.js';
import type {
  CreatePersonCertificationBody,
  PersonCertificationView,
} from './certifications.service.js';

/**
 * Person certifications (module 14, x326). Three endpoints under a person: record a certification,
 * list a person's certifications (each marked expired read-side), and remove one. A certification is
 * a dated credential — distinct from `person_skills` (x172), which are proficiency tags.
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on each route asks the coarse `org.manage` (write) / `work.read` (read) question
 * — does this role's ceiling include the capability at all. This controller adds the authoritative
 * application decision (`25-AUTH` §3 step 2, deny-by-default) the guard cannot make: an org-scoped
 * `authorize()` (`projectId: null`) that a suspended membership or a client principal fails.
 *
 * ## The Known-trap order (resolve before authorize)
 *
 * Every route names a person by `:userId` in the path. The person is resolved to their membership in
 * this tenant **first** — `(organization_id, :userId)` — so an unknown or cross-tenant user id is a
 * 404 with no write, before any authorize or mutation. Only then does the org-scoped `authorize()`
 * run. A certification view never echoes `organizationId`.
 *
 * ## DELETE is idempotent
 *
 * Once the person resolves, removing a certification succeeds whether or not the id still exists (a
 * 204 either way): the delete is scoped to the resolved person and tenant, so it can only ever remove
 * that person's own credential, and a repeated delete is not an error.
 */
@Controller('v1/organizations/:orgSlug/people/:userId/certifications')
export class PersonCertificationsController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    private readonly service: PersonCertificationsService,
    private readonly repository: PersonCertificationsRepository,
  ) {}

  /**
   * List a person's certifications, newest issue first. `work.read`, relation-gated org-scoped
   * (`projectId: null`, so every active member may read the directory's credentials). The person is
   * resolved tenant-scoped first — an unknown/cross-tenant id is 404.
   */
  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('userId') userId: string,
  ): Promise<{ readonly certifications: readonly PersonCertificationView[] }> {
    await this.requirePerson(context, userId);
    if (!this.mayActOrg(principal, context, 'work.read')) {
      throw denied('read');
    }
    const certifications = await this.service.list(this.database, context, userId);
    return { certifications };
  }

  /**
   * Record a certification for a person. `org.manage`, relation-gated org-scoped. The person is
   * resolved tenant-scoped BEFORE authorize (Known-trap): an unknown/cross-tenant id is 404 with no
   * write. A bad body (empty name/issuer, malformed date, expiry before issue) is 400.
   */
  @Post()
  @RequireCapability('org.manage')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('userId') userId: string,
    @Body() body: CreatePersonCertificationBody,
  ): Promise<PersonCertificationView> {
    await this.requirePerson(context, userId);
    if (!this.mayActOrg(principal, context, 'org.manage')) {
      throw denied('write');
    }
    return this.service.create(this.database, context, userId, principal.userId, body);
  }

  /**
   * Remove a person's certification. `org.manage`. The person is resolved tenant-scoped first (an
   * unknown/cross-tenant user id is 404, no write); the delete itself is idempotent (204 whether or
   * not the certification id still exists), scoped to the resolved person and tenant.
   */
  @Delete(':certificationId')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('userId') userId: string,
    @Param('certificationId') certificationId: string,
  ): Promise<void> {
    await this.requirePerson(context, userId);
    if (!this.mayActOrg(principal, context, 'org.manage')) {
      throw denied('write');
    }
    await this.service.delete(this.database, context, userId, certificationId);
  }

  /**
   * Resolve the `:userId` to a membership in the acting tenant. Unknown / cross-tenant ⇒ 404 with no
   * write — the resolve-before-authorize Known-trap, run before any authorize or mutation on every
   * route.
   */
  private async requirePerson(context: TenantContext, userId: string): Promise<void> {
    if (typeof userId !== 'string' || userId === '') {
      throw notFound();
    }
    const member = await this.database.read(context, (runner) =>
      this.repository.findPersonMembership(runner, context, userId),
    );
    if (!member) {
      throw notFound();
    }
  }

  /** Org-scoped deny-by-default decision the route guard cannot make (membership status, etc.). */
  private mayActOrg(principal: Principal, context: TenantContext, capability: Capability): boolean {
    return authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }
}

function notFound(): ApiError {
  return new ApiError(
    404,
    'not_found',
    MESSAGES.notFound,
    undefined,
    'person_certification_no_person',
  );
}

function denied(kind: 'read' | 'write'): ApiError {
  return new ApiError(
    403,
    'forbidden',
    MESSAGES.forbidden,
    undefined,
    `person_certification_${kind}_denied`,
  );
}

/**
 * x326's wiring — a self-contained module registered from `app.module.ts`, kept file-disjoint from
 * the other People slices. A stateless repository and service; the controller injects them alongside
 * the `@Global` `TENANT_DATABASE`. Its controller mounts under `…/people/:userId/certifications`.
 */
@Module({})
export class PersonCertificationsModule {
  static register(): DynamicModule {
    return {
      module: PersonCertificationsModule,
      providers: [
        {
          provide: PersonCertificationsRepository,
          useFactory: () => new PersonCertificationsRepository(),
        },
        {
          provide: PersonCertificationsService,
          useFactory: (repository: PersonCertificationsRepository) =>
            new PersonCertificationsService(repository),
          inject: [PersonCertificationsRepository],
        },
      ],
      controllers: [PersonCertificationsController],
    };
  }
}
