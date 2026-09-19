import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiError } from '../../common/http/errors.js';
import { CurrentSession, NoTenant } from '../../common/http/decorators.js';
import { requireRequestState } from '../../common/http/request-state.js';
import {
  ORGANIZATION_DIRECTORY_REPOSITORY,
  PROVISIONING_SERVICE,
} from '../../common/http/tokens.js';
import type { AuthenticatedSession } from '../identity/session.service.js';
import type { OrganizationDirectoryRepository } from './organization-directory.repository.js';
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
}

/**
 * The slug rules, restated on the server.
 *
 * `apps/web/src/lib/slug.ts` derives and checks the same shape in the browser, and that copy
 * exists to give the person immediate feedback — not to be the control. This one is the
 * control. They are two implementations of one rule and will drift; the direction that
 * matters is that a slug the browser would reject can still be posted directly, and this is
 * what refuses it.
 *
 * The width is `organizations.slug`'s own: `varchar(63)`, which is also the DNS label limit.
 */
const MAX_SLUG_LENGTH = 63;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MAX_NAME_LENGTH = 190;
const MAX_TIMEZONE_LENGTH = 64;
const MAX_LOCALE_LENGTH = 35;

/**
 * Slugs the product needs for itself.
 *
 * A person who registered `api` or `admin` would take a path this application may want later,
 * and taking it back would break every link they had shared. The list is short and additive:
 * a slug that becomes reserved later stays owned by whoever holds it, because a reservation
 * that evicted an existing customer would be worse than the collision it prevented.
 */
const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'billing',
  'blog',
  'cdn',
  'dashboard',
  'docs',
  'help',
  'legal',
  'login',
  'mail',
  'portal',
  'privacy',
  'security',
  'settings',
  'signin',
  'signup',
  'static',
  'status',
  'support',
  'system',
  'tmanage',
  'www',
]);

@Controller('v1/organizations')
export class OrganizationsController {
  constructor(
    @Inject(PROVISIONING_SERVICE) private readonly provisioning: ProvisioningService,
    @Inject(ORGANIZATION_DIRECTORY_REPOSITORY)
    private readonly directory: OrganizationDirectoryRepository,
  ) {}

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

    return {
      organizations: rows.map((row) => ({
        id: row.organizationId,
        slug: row.slug,
        name: row.name,
        audience: row.audience,
        role: row.role,
        clientOrganizationName: row.clientOrganizationName,
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
    const input = validate(body);

    try {
      const created = await this.provisioning.provisionOrganization({
        userId: session.userId,
        slug: input.slug,
        name: input.name,
        defaultLocale: input.defaultLocale,
        timezone: input.timezone,
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
        throw new ApiError(409, 'conflict', 'That workspace address is already in use', [
          { field: 'slug', message: 'Choose a different workspace address.' },
        ]);
      }
      throw error;
    }
  }
}

interface ValidatedInput {
  readonly slug: string;
  readonly name: string;
  readonly timezone: string;
  readonly defaultLocale: string;
}

/**
 * Check the body, reporting every problem rather than the first.
 *
 * Specific messages, for the same reason `POST /v1/auth/password/set` is specific: the caller
 * is authenticated and the subject is their own input. Nothing here is about whether some
 * other account or organization exists.
 */
function validate(body: CreateOrganizationBody): ValidatedInput {
  const details: { field: string; message: string }[] = [];

  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (name === '') {
    details.push({ field: 'name', message: 'An organization name is required.' });
  } else if (name.length > MAX_NAME_LENGTH) {
    details.push({ field: 'name', message: `Keep the name to ${MAX_NAME_LENGTH} characters.` });
  }

  // Trimmed but **not** lower-cased. Silently folding the case would mean the address a
  // person sees confirmed is not the one they typed, and the slug is the most visible string
  // this product has — it is in every link they will send. A refusal they can act on is
  // better than a transformation they did not ask for.
  const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
  if (slug === '') {
    details.push({ field: 'slug', message: 'A workspace address is required.' });
  } else if (slug.length > MAX_SLUG_LENGTH) {
    details.push({
      field: 'slug',
      message: `Keep the workspace address to ${MAX_SLUG_LENGTH} characters.`,
    });
  } else if (!SLUG_PATTERN.test(slug)) {
    details.push({
      field: 'slug',
      message: 'Use lowercase letters, numbers and single hyphens between them.',
    });
  } else if (RESERVED_SLUGS.has(slug)) {
    details.push({ field: 'slug', message: 'That workspace address is reserved.' });
  }

  const timezone = typeof body?.timezone === 'string' ? body.timezone.trim() : 'UTC';
  if (timezone.length > MAX_TIMEZONE_LENGTH || !isKnownTimezone(timezone)) {
    details.push({ field: 'timezone', message: 'That is not a timezone we recognise.' });
  }

  const defaultLocale =
    typeof body?.defaultLocale === 'string' && body.defaultLocale.trim() !== ''
      ? body.defaultLocale.trim()
      : 'en';
  if (defaultLocale.length > MAX_LOCALE_LENGTH || !/^[A-Za-z][A-Za-z0-9-]*$/.test(defaultLocale)) {
    details.push({ field: 'defaultLocale', message: 'That is not a language tag we recognise.' });
  }

  if (details.length > 0) {
    throw new ApiError(422, 'validation_failed', 'That organization cannot be created.', details);
  }

  return { slug, name, timezone, defaultLocale };
}

/**
 * Whether the runtime recognises this timezone.
 *
 * Asked of `Intl` rather than checked against a bundled list, because a bundled list is a copy
 * of the IANA database that goes stale — and because the value has to be one *this* process
 * can resolve, since every deadline in the product will be rendered through it. A name Node
 * cannot resolve would be accepted by a list and then throw the first time a date was
 * formatted.
 */
function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
