import { eq } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { oauthClients } from '../../common/database/schema.js';
import type { IdentityQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The one read the `/mcp` access-token check needs beyond `OauthTokensRepository`: the display
 * name of the client a grant belongs to, for the audit trail and "via <client>". Global table,
 * reached on the identity path; no secret is read or returned.
 */
export async function findOauthClientName(
  runner: IdentityQueryRunner,
  clientPk: string,
): Promise<string | null> {
  const rows = await tenantDrizzle(runner)
    .select({ name: oauthClients.name })
    .from(oauthClients)
    .where(eq(oauthClients.id, clientPk))
    .limit(1);
  return rows[0]?.name ?? null;
}
