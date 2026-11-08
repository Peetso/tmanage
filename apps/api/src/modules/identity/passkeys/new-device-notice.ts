import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { serializeForLog } from '../../../common/observability/logger.js';
import {
  listEarlierUserAgents,
  PASSKEY_TABLES,
  queueSecurityNotice,
} from './passkeys.repository.js';
import { isNewDevice } from './security-score.js';

/** `credential_change_notices.action` for "a new device signed in" (mailed by the worker). */
export const NEW_DEVICE_SIGN_IN_ACTION = 'new_device_sign_in';

/**
 * 56-22. After a session starts: when this person has signed in before and no earlier session was
 * the same browser/OS, queue a "new device signed in" notice on the credential-notice outbox the
 * worker already drains. Best effort — a failure is logged and never undoes the sign-in.
 */
export async function notifyIfNewDevice(
  database: Pick<TenantDatabase, 'identityTransaction'>,
  input: { userId: string; sessionId: string; userAgent: string | null; correlationId: string },
): Promise<boolean> {
  try {
    return await database.identityTransaction(
      { correlationId: input.correlationId, tables: [...PASSKEY_TABLES] },
      async (tx) => {
        const earlier = await listEarlierUserAgents(tx, input.userId, input.sessionId);
        if (!isNewDevice(input.userAgent, earlier)) return false;
        await queueSecurityNotice(tx, {
          userId: input.userId,
          action: NEW_DEVICE_SIGN_IN_ACTION,
          correlationId: input.correlationId,
        });
        return true;
      },
    );
  } catch (error) {
    console.error(
      '[identity] new-device notice failed; the sign-in stands',
      serializeForLog(error),
    );
    return false;
  }
}
