import {
  EDITABLE_PLATFORM_PRESETS,
  isPlatformPreset,
  normalizePlatformPermissions,
  PLATFORM_PERMISSIONS,
  SUPER_ADMIN_ONLY_PERMISSIONS,
} from '@tmanage/domain';
import type { EditablePlatformPreset, PlatformPermission, PlatformPreset } from '@tmanage/domain';
import { ApiError } from '../../../common/http/errors.js';

/**
 * Input rules for the platform admin team (SPEC §3.1, §5.1): which preset a request names, what
 * list a custom admin gets, and which presets may be rewritten.
 */

export function requirePreset(raw: unknown): PlatformPreset {
  if (!isPlatformPreset(raw)) {
    throw new ApiError(400, 'validation_failed', 'Choose a preset.', [
      { field: 'preset', message: 'super_admin, support, auditor or custom' },
    ]);
  }
  return raw;
}

export function requireEditablePreset(raw: unknown): EditablePlatformPreset {
  if (raw === 'super_admin' || raw === 'custom') {
    throw new ApiError(
      409,
      'conflict',
      raw === 'super_admin'
        ? 'Super admin always has every permission.'
        : 'Custom is set per person in Team.',
    );
  }
  if (!(EDITABLE_PLATFORM_PRESETS as readonly unknown[]).includes(raw)) {
    throw new ApiError(404, 'not_found', 'The requested resource was not found');
  }
  return raw as EditablePlatformPreset;
}

/**
 * A permission list from the request: known keys only, in canonical order, without the
 * super-admin-only keys (`platform.team.manage` comes only with the super admin preset).
 * Anything but an array of strings is a 400.
 */
export function requirePermissionList(raw: unknown): PlatformPermission[] {
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
    throw new ApiError(400, 'validation_failed', 'Choose the permissions.', [
      { field: 'permissions', message: 'a list of permission keys' },
    ]);
  }
  const unknown = raw.filter(
    (entry) => !(PLATFORM_PERMISSIONS as readonly string[]).includes(entry),
  );
  if (unknown.length > 0) {
    throw new ApiError(400, 'validation_failed', 'One of those permissions does not exist.', [
      { field: 'permissions', message: 'unknown key' },
    ]);
  }
  return normalizePlatformPermissions(raw).filter(
    (key) => !SUPER_ADMIN_ONLY_PERMISSIONS.includes(key),
  );
}

/** The stored custom list for a preset: the explicit list for `custom`, `null` otherwise. */
export function customListFor(
  preset: PlatformPreset,
  rawPermissions: unknown,
): PlatformPermission[] | null {
  if (preset !== 'custom') return null;
  return requirePermissionList(rawPermissions ?? []);
}
