import { SetMetadata } from '@nestjs/common';
import type { PlatformPermission } from '@tmanage/domain';

/**
 * `@RequirePlatformPermission('platform.orgs.view')` — the one platform permission a route needs
 * (SPEC §3.1). `PlatformAdminGuard` reads it after it has proved who the admin is; an admin whose
 * preset (or custom list) lacks the key gets a 403 `platform_permission_missing` naming the key,
 * so the screen can say exactly what is missing.
 *
 * A route without the decorator needs no permission beyond being a platform admin — that is only
 * `me` and `step-up`. Every other route carries one.
 */
export const PLATFORM_PERMISSION_METADATA = Symbol.for('tmanage.route.platformPermission');

export const RequirePlatformPermission = (
  permission: PlatformPermission,
): MethodDecorator & ClassDecorator => SetMetadata(PLATFORM_PERMISSION_METADATA, permission);
