import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { OptionalModuleFlag } from '../admin/feature-flags.service.js';

/**
 * ONEPAGE (B01). The one rule that decides whether a summary block is present.
 *
 * A block is read only when the viewer holds the block's capability (the same capability the
 * block's own full screen asks for) and, for a flagged source, the organization's flag is on. The
 * source service then applies its own relation rule again; if it refuses (403, or the 404 that
 * hides an unreadable resource), the block is **absent**, never an empty block and never an error
 * for the whole page. Any other failure is a real failure and propagates.
 */

/** Does the principal hold `capability` on the project (or org-wide when `projectId` is null)? */
export function holds(
  principal: Principal,
  context: TenantContext,
  capability: Capability,
  projectId: string | null,
): boolean {
  return authorize({
    principal,
    capability,
    resource: {
      organizationId: context.organizationId,
      projectId,
      audience: 'internal',
      lifecycle: 'active',
    },
  }).allowed;
}

/** The resolved per-organization flags, as the existing feature-flag mechanism answers them. */
export type FlagReader = (
  context: TenantContext,
) => Promise<Readonly<Record<OptionalModuleFlag, boolean>>>;

/** Read a block from its source; `undefined` (absent) when the source refuses the viewer. */
export async function readBlock<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      return undefined;
    }
    throw error;
  }
}

/** The blocks that were read: each key optional, never `undefined`-valued. */
export type Present<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/** Drop absent blocks so they are missing from the payload, not `undefined`-valued keys. */
export function presentOnly<T extends Record<string, unknown>>(blocks: T): Present<T> {
  return Object.fromEntries(
    Object.entries(blocks).filter(([, value]) => value !== undefined),
  ) as Present<T>;
}

/** The one-page views are staff screens; a client principal is answered as for a missing page. */
export function requireInternal(principal: Principal): void {
  if (principal.kind !== 'internal') {
    throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'summary_internal_only');
  }
}
