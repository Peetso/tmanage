import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { AuditService } from '../audit/audit.service.js';
import { createDriveTransport, type DriveTransport } from '../google-drive/google-drive.google.js';
import { googleDriveServiceFor } from '../google-drive/google-drive.controller.js';
import { createOneDriveTransport, type OneDriveTransport } from '../onedrive/onedrive.graph.js';
import { oneDriveServiceFor } from '../onedrive/onedrive.controller.js';
import type { ProviderObjectSources } from './provider-objects.js';

/**
 * 57-13a/b. The company's Drive and OneDrive as storage for versions held there, for every module
 * that reads file versions (`VersionStore`). One place, so no reader is wired differently.
 */
export function providerObjectSources(
  database: TenantDatabase,
  audit: AuditService,
  config: ApiConfig,
  drives: { readonly drive?: DriveTransport; readonly oneDrive?: OneDriveTransport } = {},
): ProviderObjectSources {
  return {
    google_drive: googleDriveServiceFor(
      database,
      audit,
      config,
      drives.drive ?? createDriveTransport(),
    ).objectSource(),
    onedrive: oneDriveServiceFor(
      database,
      audit,
      config,
      drives.oneDrive ?? createOneDriveTransport(),
    ).objectSource(),
  };
}
