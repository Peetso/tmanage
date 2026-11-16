import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { A11yPreferencesRepository } from './a11y.repository.js';
import { DEFAULT_A11Y_PREFERENCES, a11yViewOf, parseA11yPreferences } from './a11y-preferences.js';
import type { A11yPreferencesView } from './a11y-preferences.js';

/**
 * PORTALA11Y — a client portal user's own accessibility settings (text size, high contrast,
 * reduced motion), read and replaced. The member route's rules, for the client audience.
 *
 * The subject is always the authenticated principal's own client membership: the request carries
 * no id (the shared validation rejects any key but the three settings), so a client can never read
 * or write another person's row. Only a client principal reaches the client store; a staff member
 * previewing the portal keeps their own settings on the member route and is refused here.
 */
export class PortalA11yPreferencesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly preferences: A11yPreferencesRepository,
  ) {}

  async read(context: TenantContext, principal: Principal): Promise<A11yPreferencesView> {
    const clientMembershipId = ownClientMembership(principal);
    const row = await this.database.read(context, (runner) =>
      this.preferences.findForClientMembership(runner, context, clientMembershipId),
    );
    return row ? a11yViewOf(row.a11yJson) : DEFAULT_A11Y_PREFERENCES;
  }

  async replace(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<A11yPreferencesView> {
    const clientMembershipId = ownClientMembership(principal);
    const settings = parseA11yPreferences(body);
    return this.database.transaction(context, async (tx) => {
      await this.preferences.upsertForClientMembership(tx, context, clientMembershipId, settings);
      const row = await this.preferences.findForClientMembership(tx, context, clientMembershipId);
      return a11yViewOf(row ? row.a11yJson : settings);
    });
  }
}

/** The caller's own client membership; anyone who is not a client of this studio is refused. */
function ownClientMembership(principal: Principal): string {
  if (principal.kind !== 'client' || principal.clientOrganizationId === null) {
    throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'not_a_client');
  }
  return principal.membershipId;
}
