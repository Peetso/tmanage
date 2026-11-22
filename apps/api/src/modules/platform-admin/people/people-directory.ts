import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import type { ApiConfig } from '../../../common/http/api-config.js';
import { CredentialsRepository } from '../../identity/credentials.repository.js';
import { createSeedCipher } from '../../identity/seed-cipher.js';
import { PlatformPeopleRepository } from './people.repository.js';

/**
 * SEC-TRACKER (Fable ruling, gaps 5 and 9) — the published read other platform areas use to name
 * accounts: display name, e-mail and the organizations the person belongs to. The attack tracker
 * shows "who was targeted" with it, inside its own audited detail read, so no context reads
 * `users` or `memberships` through a foreign repository (AR-5): it calls this service.
 *
 * Who may see the names is the caller's decision (the tracker asks for `platform.people.view`);
 * this service only answers. It never returns a session, factor or any credential fact.
 */

export const PEOPLE_DIRECTORY_MAX = 20;

export interface PlatformAccountName {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  /** Internal and client memberships, by organization, each organization once. */
  readonly organizations: readonly { readonly name: string; readonly slug: string }[];
}

type DirectoryReads = Pick<PlatformPeopleRepository, 'names' | 'userIdByEmail'>;

export class PlatformPeopleDirectory {
  constructor(private readonly reads: DirectoryReads) {}

  /** At most {@link PEOPLE_DIRECTORY_MAX} accounts, in the order of `userIds`; unknown ids skipped. */
  async accounts(
    userIds: readonly string[],
    correlationId: string,
  ): Promise<readonly PlatformAccountName[]> {
    const ids = [...new Set(userIds)].slice(0, PEOPLE_DIRECTORY_MAX);
    const { people, memberships } = await this.reads.names(ids, correlationId);
    const byId = new Map(people.map((person) => [person.userId, person]));
    return ids.flatMap((id) => {
      const person = byId.get(id);
      if (person === undefined) return [];
      const organizations = new Map<string, { name: string; slug: string }>();
      for (const m of memberships) {
        if (m.userId === id && !organizations.has(m.organizationSlug)) {
          organizations.set(m.organizationSlug, {
            name: m.organizationName,
            slug: m.organizationSlug,
          });
        }
      }
      return [{ ...person, organizations: [...organizations.values()] }];
    });
  }

  /** The account id of an exact e-mail, or null. */
  userIdByEmail(email: string, correlationId: string): Promise<string | null> {
    if (!email.includes('@') || email.length > 254) return Promise.resolve(null);
    return this.reads.userIdByEmail(email, correlationId);
  }
}

/** The directory over the people repository, wired the way `PlatformPeopleModule` wires it. */
export function platformPeopleDirectory(
  database: TenantDatabase,
  config: Pick<ApiConfig, 'mfaSeedKeys'>,
): PlatformPeopleDirectory {
  return new PlatformPeopleDirectory(
    new PlatformPeopleRepository(
      database,
      new CredentialsRepository(createSeedCipher(config.mfaSeedKeys)),
    ),
  );
}
