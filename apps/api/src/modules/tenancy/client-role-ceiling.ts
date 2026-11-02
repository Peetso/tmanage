import { capabilitiesFor, isClientRole } from '@tmanage/domain';
import type { Capability, ClientRole } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { requireClientCeiling } from './role-grant-ceiling.js';

/**
 * 56-28 client ceiling, wired (R23-b). Every path that hands a **client** a role — a client
 * membership invite or role change, a client invitation issued or re-issued — asks this one line,
 * so the paths share the rule instead of each carrying `isClientRole` plus a hand-rolled check.
 *
 * - Not a client role: 400 `validation_failed` (the message those callers already used).
 * - A client role whose ceiling holds anything outside `CLIENT_CAPABILITY_ALLOWLIST`: 422
 *   `client_ceiling` naming each internal capability, before any write.
 *
 * `ceilingOf` is injectable only so a unit test can widen a built-in ceiling; every real client
 * ceiling passes today (the domain test proves it). The wiring is what this guard adds.
 */
export type ClientCeilingOf = (role: ClientRole) => Iterable<Capability>;

export const CLIENT_ROLE_INVALID_MESSAGE = 'role must be a client role';

export function assertClientRoleWithinCeiling(
  role: string,
  action: string,
  ceilingOf: ClientCeilingOf = capabilitiesFor,
): asserts role is ClientRole {
  if (!isClientRole(role)) {
    throw new ApiError(400, 'validation_failed', 'The request is invalid.', [
      { field: 'role', message: CLIENT_ROLE_INVALID_MESSAGE },
    ]);
  }
  requireClientCeiling(role, ceilingOf(role), action);
}

/**
 * R23-b: the member-role and custom-role write paths are internal-only. A body whose `role` or
 * `customRoleId` names a built-in **client** role is refused with the ceiling's own code (422
 * `client_ceiling`) before the paths' existing 400, so the error matches every other ceiling
 * refusal and the audit code (`${action}`) names the path.
 */
export function refuseClientRoleName(value: unknown, action: string): void {
  if (typeof value !== 'string' || !isClientRole(value.trim())) return;
  throw new ApiError(
    422,
    'client_ceiling',
    'A client role cannot be given on this path.',
    [{ field: 'role', message: value.trim() }],
    action,
  );
}

/**
 * R23-b hook for the later custom-client-role work (56-28 story): a custom role's body may say
 * `audience: 'client'` (default `'internal'`). Only then is its capability subset held to the
 * client ceiling — 422 `client_ceiling` naming each internal capability. Any other value is a 400.
 */
export function requireCustomRoleAudienceCeiling(
  audience: unknown,
  capabilities: Iterable<Capability>,
  action: string,
): void {
  if (audience === undefined || audience === null || audience === 'internal') return;
  if (audience !== 'client') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'audience', message: 'must be internal or client' },
    ]);
  }
  requireClientCeiling('client_viewer', capabilities, action);
}
