import { uuidv7 } from '@tmanage/domain';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { serializeForLog } from '../../common/observability/logger.js';
import { PlatformAdminRepository } from './platform-admin.repository.js';

/**
 * Platform settings — the switches the TManage operator flips from `/platform/settings`.
 *
 * Today there is one: whether public self-service sign-up is open. The environment variable
 * `PUBLIC_SIGNUP` stays the default (and the only control while nobody has used the switch);
 * once the operator sets it, the stored value wins until they change it again. So the
 * variable "backs" the switch and the switch "overrides" the variable.
 */

export const PUBLIC_SIGNUP_SETTING = 'public_signup';

/** `open` / `closed` from the table, or the environment default when no row exists. */
export function publicSignupFromSetting(
  stored: string | null,
  environmentDefault: boolean,
): boolean {
  if (stored === 'open') return true;
  if (stored === 'closed') return false;
  return environmentDefault;
}

/** What the sign-up routes ask on every request. */
export interface PublicSignupSwitch {
  isOpen(correlationId: string): Promise<boolean>;
}

/**
 * The sign-up switch. Without Platform admin (no `PLATFORM_ADMIN_EMAILS`) nobody can store a
 * value, so it is the environment default and reads nothing. With it, the stored row decides;
 * a failed read falls back to the environment default (a sign-up needs the database anyway).
 */
export function createPublicSignupSwitch(
  database: TenantDatabase,
  options: { readonly environmentDefault: boolean; readonly databaseBacked: boolean },
): PublicSignupSwitch {
  if (!options.databaseBacked) {
    return { isOpen: () => Promise.resolve(options.environmentDefault) };
  }
  const repository = new PlatformAdminRepository(database);
  return {
    async isOpen(correlationId: string) {
      try {
        const stored = await repository.readSetting(
          PUBLIC_SIGNUP_SETTING,
          correlationId || uuidv7(),
        );
        return publicSignupFromSetting(stored, options.environmentDefault);
      } catch (error) {
        console.error(
          '[platform-settings] public sign-up switch read failed',
          serializeForLog(error),
        );
        return options.environmentDefault;
      }
    },
  };
}
