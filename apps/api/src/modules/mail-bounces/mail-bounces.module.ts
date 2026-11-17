import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { deriveBounceKey } from '@tmanage/mail';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { AuditService } from '../audit/audit.service.js';
import { BounceIntakeController } from './bounce-intake.controller.js';
import { MAIL_BOUNCES_SERVICE, MailBouncesController } from './mail-bounces.controller.js';
import { MailBouncesService } from './mail-bounces.service.js';

/**
 * 56-26 wiring: the signed bounce intake and the admin status/clear routes. The bounce key is
 * derived from `SESSION_SECRET` (required by the one config schema) under its own label, the same
 * key the SMTP drivers sign with. Registered beside `InboundEmailModule`, whose boot hook keeps the
 * intake's raw body.
 */
@Module({})
export class MailBouncesModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: MAIL_BOUNCES_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE],
      useFactory: (database: TenantDatabase, audit: AuditService) => {
        const secret = process.env['SESSION_SECRET'];
        return new MailBouncesService(
          database,
          secret === undefined || secret.trim() === '' ? null : deriveBounceKey(secret),
          audit,
        );
      },
    };
    return {
      module: MailBouncesModule,
      providers: [service],
      controllers: [BounceIntakeController, MailBouncesController],
    };
  }
}
