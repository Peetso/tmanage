import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { AUDIT_SERVICE, MALWARE_SCANNER, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { MalwareScanner } from '../../common/scan/malware-scanner.js';
import type { AuditService } from '../audit/audit.service.js';
import { PROFILE_PHOTO_SERVICE, ProfilePhotoController } from './profile-photo.controller.js';
import { ProfilePhotoRepository } from './profile-photo.repository.js';
import { ProfilePhotoService } from './profile-photo.service.js';

/**
 * Profile photo (0411). The service over the `@Global` tenant database, audit service and malware
 * scanner (optional: without one the re-encode is the defence). Registered in `app.module.ts` directly (one line), so no shared module file is touched. */
@Module({})
export class ProfilePhotoModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: PROFILE_PHOTO_SERVICE,
      useFactory: (database: TenantDatabase, audit: AuditService, scanner?: MalwareScanner) =>
        new ProfilePhotoService(database, new ProfilePhotoRepository(), audit, scanner),
      inject: [TENANT_DATABASE, AUDIT_SERVICE, { token: MALWARE_SCANNER, optional: true }],
    };
    return {
      module: ProfilePhotoModule,
      providers: [service],
      controllers: [ProfilePhotoController],
    };
  }
}
