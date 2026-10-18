import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Optional,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiError } from '../../common/http/errors.js';
import { CurrentSession, NoTenant } from '../../common/http/decorators.js';
import { requireRequestState } from '../../common/http/request-state.js';
import {
  ORGANIZATION_DIRECTORY_REPOSITORY,
  PROVISIONING_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { AddressAvailabilityRepository } from './address-availability.repository.js';
import type { AuthenticatedSession } from '../identity/session.service.js';
import type { OrganizationDirectoryRepository } from './organization-directory.repository.js';
import { slugProblem, validateOrganizationInput } from './organization-input.js';
import { OrganizationSlugTakenError } from './organizations.repository.js';
import type {
  CreatedOrganizationView,
  OrganizationSummaryView,
  ProvisioningService,
} from './provisioning.service.js';

/**
 * The two routes `ON-01` and `ID-04` have been waiting for — TEN-001's unbuilt half.
 *
 * Both are `@NoTenant()`, and that is the whole shape of this controller. Creating an
 * organization happens before one exists; listing them spans all of them. Neither can carry
 * an `:orgSlug`, so neither runs `25-AUTHORIZATION-AND-TENANT-ISOLATION` §3's step 2, and
 * both therefore check nothing beyond a verified session.
 *
 * That is not a relaxation. A session is exactly the right authority for both:
 *
 *   * **Creating** an organization is signup. Any authenticated person may do it, and there
 *     is no organization in which to hold a capability that would say otherwise.
 *   * **Listing** them is keyed on the session's own user id and takes no identifier from the
 *     caller at all — see `OrganizationDirectoryRepository` for why that property is what
 *     makes an unscoped read acceptable.
 *
 * Every route below still passes the four-guard pipeline for what it *does* apply: the
 * session cookie is verified, and the CSRF token is required on the mutation.
 */

interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
}

interface CreateOrganizationBody {
  readonly name?: unknown;
  readonly slug?: unknown;
  readonly timezone?: unknown;
  readonly defaultLocale?: unknown;
  readonly workingWeek?: unknown;
  readonly operatingTemplate?: unknown;
}

/**
 * The wire body of `GET /v1/organizations/address-availability` — ON-02's live tick.
 *
 * `reason` says why an address is not available: `invalid` (malformed or reserved, with the
 * validator's own sentence in `message`) or `taken`. Both `null` when it is available.
 */
export interface AddressAvailabilityView {
  readonly slug: string;
  readonly available: boolean;
  readonly reason: 'invalid' | 'taken' | null;
  readonly message: string | null;
}

@Controller('v1/organizations')
export class OrganizationsController {
  constructor(
    @Inject(PROVISIONING_SERVICE) private readonly provisioning: ProvisioningService,
    @Inject(ORGANIZATION_DIRECTORY_REPOSITORY)
    private readonly directory: OrganizationDirectoryRepository,
    @Inject(TENANT_DATABASE) database: TenantDatabase,
    @Optional() @Inject(AddressAvailabilityRepository) availability?: AddressAvailabilityRepository,
  ) {
    this.availability = availability ?? new AddressAvailabilityRepository(database);
  }

  private readonly availability: AddressAvailabilityRepository;

  /**
   * ON-02. Whether a workspace address can be used, asked while the person types (debounced in
   * the browser). Session only, like creating: the answer is the same 409 the create route gives,
   * one request earlier. The address is checked against the create route's own rules first, so
   * "available" is never shown for an address the create would refuse.
   */
  @Get('address-availability')
  @NoTenant()
  async addressAvailability(
    @Query('slug') rawSlug: unknown,
    @Req() request: RequestLike,
  ): Promise<AddressAvailabilityView> {
    const state = requireRequestState(request);
    const slug = typeof rawSlug === 'string' ? rawSlug.trim() : '';
    const problem = slugProblem(slug);
    if (problem !== undefined) {
      return { slug, available: false, reason: 'invalid', message: problem };
    }
    const taken = await this.availability.isTaken({ slug, correlationId: state.correlationId });
    return taken
      ? {
          slug,
          available: false,
          reason: 'taken',
          message: 'That web link is already taken.',
        }
      : { slug, available: true, reason: null, message: null };
  }

  /**
   * `ID-04`. The organizations this session may act in.
   *
   * An empty list is a 200 with an empty array, not a 404. "You belong to nothing yet" is a
   * real and expected state — it is what every person sees between signing up and creating
   * their first organization — and `ID-04` is the screen that has to say so.
   */
  @Get()
  @NoTenant()
  async list(
    @CurrentSession() session: AuthenticatedSession,
    @Req() request: RequestLike,
  ): Promise<{ organizations: readonly OrganizationSummaryView[] }> {
    const state = requireRequestState(request);
    const rows = await this.directory.listForUser({
      userId: session.userId,
      correlationId: state.correlationId,
    });

    // A personal access token is bound to one organization (0202). This route is `@NoTenant()`,
    // so `TenantContextGuard` never runs to enforce that binding — a token would otherwise list
    // every organization its member belongs to, disclosing the member's whole org graph and
    // letting an MCP client point the token at an org it cannot actually reach. So under a PAT the
    // directory is narrowed to the token's own organization; a cookie session still sees them all.
    const binding = state.personalAccessToken;
    const visible =
      state.authScheme === 'personal_access_token' && binding !== undefined
        ? rows.filter((row) => row.organizationId === binding.organizationId)
        : rows;

    return {
      organizations: visible.map((row) => ({
        id: row.organizationId,
        slug: row.slug,
        name: row.name,
        audience: row.audience,
        role: row.role,
        clientOrganizationName: row.clientOrganizationName,
        suspended: row.suspended,
      })),
    };
  }

  /**
   * `ON-01`. Create an organization, its first workspace, and the founder's owner membership.
   *
   * 201, because this one unambiguously creates something — unlike sign-in, where the two
   * outcomes made a status code a second thing to keep in agreement with the body.
   */
  @Post()
  @NoTenant()
  @HttpCode(201)
  async create(
    @CurrentSession() session: AuthenticatedSession,
    @Body() body: CreateOrganizationBody,
    @Req() request: RequestLike,
  ): Promise<CreatedOrganizationView> {
    const state = requireRequestState(request);
    const input = validateOrganizationInput(body);

    try {
      const created = await this.provisioning.provisionOrganization({
        userId: session.userId,
        slug: input.slug,
        name: input.name,
        defaultLocale: input.defaultLocale,
        timezone: input.timezone,
        ...(input.workingWeek === undefined ? {} : { workingWeek: input.workingWeek }),
        ...(input.operatingTemplate === undefined
          ? {}
          : { operatingTemplate: input.operatingTemplate }),
        correlationId: state.correlationId,
      });

      return {
        id: created.organizationId,
        slug: created.slug,
        name: created.name,
        workspaceId: created.workspaceId,
        role: created.role,
      };
    } catch (error) {
      if (error instanceof OrganizationSlugTakenError) {
        // 409 with the field named, and this is the one place in the identity surface that
        // says a specific thing about a specific identifier. It is safe because the caller is
        // authenticated and because the fact is public anyway — anyone can visit the URL. It
        // is also necessary: a person cannot choose a different address without being told
        // that this one is gone.
        throw new ApiError(409, 'conflict', 'That web link is already taken', [
          { field: 'slug', message: 'That web link is taken. Choose a different one.' },
        ]);
      }
      throw error;
    }
  }
}
