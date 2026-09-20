import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ApiConfigModule } from './common/http/api-config.js';
import type { ApiConfig } from './common/http/api-config.js';
import { CorrelationInterceptor } from './common/http/correlation.interceptor.js';
import { NOOP_TRACER, TRACER } from './common/observability/tracer.js';
import { ClientProjectionInterceptor } from './common/http/client-projection.interceptor.js';
import { HttpExceptionFilter } from './common/http/http-exception.filter.js';
import { SessionAuthGuard } from './common/http/guards/session-auth.guard.js';
import { CsrfGuard } from './common/http/guards/csrf.guard.js';
import { TenantContextGuard } from './common/http/guards/tenant-context.guard.js';
import { CapabilityGuard } from './common/http/guards/capability.guard.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { TenancyModule } from './modules/tenancy/tenancy.module.js';
import { ProjectsModule } from './modules/projects/projects.module.js';
import { WorkModule } from './modules/work/work.module.js';
import { RequestsModule } from './modules/requests/requests.module.js';
import { InboxModule } from './modules/inbox/inbox.module.js';
import { NotificationPreferencesModule } from './modules/notifications/notification-preferences.module.js';
import { ConversationsModule } from './modules/conversations/conversations.module.js';
import { CalendarModule } from './modules/calendar/calendar.module.js';
import { ClientsModule } from './modules/clients/clients.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { MailerModule } from './common/email/mailer.module.js';
import { StorageModule } from './common/storage/storage.module.js';
import { ScannerModule } from './common/scan/scanner.module.js';
import { PlatformModule } from './modules/platform/platform.module.js';
import { RealtimeModule } from './modules/realtime/realtime.module.js';
import { FilesModule } from './modules/files/files.module.js';

/**
 * The request pipeline, assembled in the order `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md`
 * §3 specifies.
 *
 * Nest applies global guards in registration order, so this array **is** the policy sequence.
 * It is worth reading as one:
 *
 * | # | Guard                | §3 step | Refuses                                          |
 * | - | -------------------- | ------- | ------------------------------------------------ |
 * | 1 | `SessionAuthGuard`   | 1       | no/forged/revoked/expired session → 401          |
 * | 2 | `CsrfGuard`          | 04 §3   | unsafe method without a session-bound token → 403 |
 * | 3 | `TenantContextGuard` | 2–4     | no active membership for the named org → 404     |
 * | 4 | `CapabilityGuard`    | 5       | capability outside the role ceiling → 403        |
 *
 * Two properties of this ordering are load-bearing rather than aesthetic:
 *
 * - CSRF must come **after** authentication, because the token is bound to a session id and
 *   there is nothing to bind against until step 1 has run.
 * - The capability check must come **after** the tenant context, because a capability is
 *   meaningless without a principal, and a principal only exists once a membership has proved
 *   which organization this request is in.
 *
 * They are registered globally rather than per-controller so the default for a new route is
 * the whole sequence. Opting out is an explicit `@Public()` or `@NoTenant()` — a visible line
 * in a diff — rather than the silent consequence of forgetting an annotation.
 */

export interface AppModuleOptions {
  /**
   * The database wiring, already built — `DatabaseModule.forUrl()` in production,
   * `DatabaseModule.forPool()` in the database suite.
   *
   * Passed in rather than constructed here, and the reason is ADR-0001 layer 4 rather than
   * taste: the lint boundary permits a driver handle only under `src/common/database/`, and an
   * earlier draft that took a `Pool` on this interface was rejected by it. The rule was right.
   * A composition root that cannot name a connection pool is one that cannot accidentally hand
   * one to a controller.
   */
  readonly database: DynamicModule;
  readonly config: ApiConfig;
  /**
   * The mail wiring, already built — `MailerModule.forConfig()` in production,
   * `MailerModule.forMailer()` in a suite that wants to hold the messages. Absent means
   * `MailerModule.none()`: every delivery answers `'none'` and the invitation screen keeps
   * telling the issuer to send the printed link, which is the bootstrap fallback.
   */
  readonly mailer?: DynamicModule;
  /**
   * FILE-001. The object-store wiring, already built — `StorageModule.forConfig()` in
   * production (FILE-001b's filesystem driver, or the still-unavailable `s3`),
   * `StorageModule.forObjectStore()` in a suite that holds the fake. Absent means
   * `StorageModule.none()`: no driver at all, and an upload session then fails at the
   * provider call, as a `500`, rather than at boot — so every other route keeps working
   * in a deployment whose files are a later ticket.
   */
  readonly storage?: DynamicModule;
  /**
   * FILE-002 slice B. The malware-scanner wiring, already built — `ScannerModule.forConfig()`
   * in production (`none`, or `clamav` at a host), `ScannerModule.forScanner()` in a suite
   * that holds its own. Absent means `ScannerModule.none()`: the `none` driver, under
   * which the scan pass records every verified version `unscanned` once and promotes
   * nothing — the bootstrap profile's honest shape, and a suite that never runs the pass
   * notices no difference.
   */
  readonly scanner?: DynamicModule;
}

@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ApiConfigModule.forConfig(options.config),
        options.database,
        // Before the modules whose commands write audit events, and before the global
        // `CapabilityGuard` below resolves `AUDIT_SERVICE` from this injector.
        AuditModule.register(),
        // PLAT-004: the outbox writer, global for the reason the audit module is — three
        // feature modules append events from inside their own transactions.
        PlatformModule.register(),
        // Before `TenancyModule`, whose invitations service is the mail port's first
        // producer and resolves `INVITATION_MAILER` from this injector.
        options.mailer ?? MailerModule.none(),
        options.storage ?? StorageModule.none(),
        options.scanner ?? ScannerModule.none(),
        TenancyModule.register(),
        options.config.allowDevelopmentSignIn
          ? IdentityModule.registerWithDevelopmentSignIn()
          : IdentityModule.register(),
        ProjectsModule.register(),
        WorkModule.register(),
        // After `WorkModule`: REQ-001 reads a work item to answer 422 rather than 500 when an
        // acceptance links to one that is not in this tenant.
        RequestsModule.register(),
        // INBOX-001. Every notification's object is resolved through `WorkItemsService.get`
        // and `ClientRequestsService.get` — the same authorized reads those modules serve —
        // never through a read path of the inbox's own. The module constructs its own
        // instances of both (see its doc), so its position here is by subject, not by need.
        InboxModule.register(),
        // NOTIF-001. The caller's own notification settings (GET/PUT). No tenant object to
        // resolve, so unlike the inbox it depends on nothing but the database.
        NotificationPreferencesModule.register(),
        // After `ProjectsModule`: `ClientsService` reads `PROJECTS_REPOSITORY` to answer 404
        // rather than 500 when a caller shares a project that is not in this tenant.
        ClientsModule.register(),
        // CHAT-001. After `ProjectsModule` for the same reason: a channel names a project, and
        // a caller who names one that is not theirs should get 404 rather than a foreign-key
        // violation surfacing as 500.
        ConversationsModule.register(),
        // CAL-01 / MTG-01 (x90). After `ProjectsModule` for the same reason as conversations: a
        // meeting names a project, and the composite foreign key means a caller who names one
        // that is not theirs gets a refusal rather than a foreign-key 500.
        CalendarModule.register(),
        // RT-001: the ticket mint. The socket itself lives in the worker.
        RealtimeModule.register(),
        // FILE-001. After `ProjectsModule` and `RequestsModule` for the same reason as the
        // requests module: a session names a project and, for a client, a request, and a
        // caller who names one that is not theirs gets 404 rather than a foreign-key 500.
        FilesModule.register(),
      ],
      providers: [
        // OBS-001. The tracing seam. No-op until the OpenTelemetry SDK (a follow-up needing a
        // lockfile change) is added, at which point an exporter-backed tracer replaces this
        // value and every request span already carries the correlation id.
        { provide: TRACER, useValue: NOOP_TRACER },
        { provide: APP_INTERCEPTOR, useClass: CorrelationInterceptor },
        // SEC-001. After the correlation interceptor, so a refusal it raises still carries the
        // id a log line is findable by. It only inspects responses on the client's side of the
        // boundary — see `ClientProjectionInterceptor`.
        { provide: APP_INTERCEPTOR, useClass: ClientProjectionInterceptor },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
        { provide: APP_GUARD, useClass: SessionAuthGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
        { provide: APP_GUARD, useClass: TenantContextGuard },
        { provide: APP_GUARD, useClass: CapabilityGuard },
      ],
    };
  }
}
