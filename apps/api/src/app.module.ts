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
import { HomeModule } from './modules/home/home.module.js';
import { HomePulseModule } from './modules/home/home-pulse.module.js';
import { WorkViewsModule } from './modules/work-views/work-views.module.js';
import { RequestsModule } from './modules/requests/requests.module.js';
import { ApprovalsModule } from './modules/approvals/approvals.module.js';
import { InboxModule } from './modules/inbox/inbox.module.js';
import { NotificationPreferencesModule } from './modules/notifications/notification-preferences.module.js';
import { NotificationsFeedModule } from './modules/notifications/notifications-feed.module.js';
import { ConversationsModule } from './modules/conversations/conversations.module.js';
import { CalendarModule } from './modules/calendar/calendar.module.js';
import { MeetingAgendaModule } from './modules/calendar/meeting-agenda.module.js';
import { DocsModule } from './modules/docs/docs.module.js';
import { DocumentTemplateVariablesModule } from './modules/docs/document-template-variables.controller.js';
import { DecisionsModule } from './modules/decisions/decisions.module.js';
import { ProjectObjectivesModule } from './modules/projects/project-objectives.module.js';
import { OrgObjectivesModule } from './modules/projects/org-objectives.module.js';
import { ProjectPortfolioModule } from './modules/projects/portfolio.module.js';
import { ObjectiveWorkLinksModule } from './modules/projects/objective-work-links.module.js';
import { ClientsModule } from './modules/clients/clients.module.js';
import { PortalPeopleModule } from './modules/clients/portal-people.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { MailerModule } from './common/email/mailer.module.js';
import { StorageModule } from './common/storage/storage.module.js';
import { ScannerModule } from './common/scan/scanner.module.js';
import { PlatformModule } from './modules/platform/platform.module.js';
import { RealtimeModule } from './modules/realtime/realtime.module.js';
import { FilesModule } from './modules/files/files.module.js';
import { ImportModule } from './modules/import/import.module.js';
import { InsightsModule } from './modules/insights/insights.module.js';
import { SearchModule } from './modules/search/search.module.js';
import { InsightsAdoptionModule } from './modules/insights/adoption.controller.js';
import { WorkloadForecastModule } from './modules/insights/workload-forecast.module.js';

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
        // HOME-03: the My Day personal-work read. Read-only over `work_items` by owner; reuses
        // `work.read` and the work module's `WorkItemView`, adds nothing to the work module.
        HomeModule.register(),
        // HOME-01: the Pulse/Focus summary read. Read-only over `work_items` + `meetings`, reuses
        // `work.read` and the Home Waiting reads; a separate module so it adds nothing to HomeModule.
        HomePulseModule.register(),
        // WK-04. The Work views read layer — a read-only composition of the work + work-graph
        // reads (timeline). After `WorkModule` by subject, though it depends only on the
        // database and never on the work service, so it does not couple to that module's wiring.
        WorkViewsModule.register(),
        // After `WorkModule`: REQ-001 reads a work item to answer 422 rather than 500 when an
        // acceptance links to one that is not in this tenant.
        RequestsModule.register(),
        // FR-05 (x92). After `ProjectsModule`: an approval binds a deliverable version to a
        // project, and a caller naming one that is not theirs should get 404 rather than a
        // foreign-key 500. Authorization is object-layer only (the reviewer relation), so this
        // module adds no route guard to the shared capability files.
        ApprovalsModule.register(),
        // INBOX-001. Every notification's object is resolved through `WorkItemsService.get`
        // and `ClientRequestsService.get` — the same authorized reads those modules serve —
        // never through a read path of the inbox's own. The module constructs its own
        // instances of both (see its doc), so its position here is by subject, not by need.
        InboxModule.register(),
        // NOTIF-001. The caller's own notification settings (GET/PUT). No tenant object to
        // resolve, so unlike the inbox it depends on nothing but the database.
        NotificationPreferencesModule.register(),
        // NOTIF feed (x151). The flat per-notification feed (GET list, POST :id/read) over the
        // same `notifications` rows the inbox bundles. A module of its own beside the inbox and
        // preferences modules so the notifications slices stay file-disjoint; it depends on
        // nothing but the database — the feed echoes the reference envelope and resolves no object.
        NotificationsFeedModule.register(),
        // After `ProjectsModule`: `ClientsService` reads `PROJECTS_REPOSITORY` to answer 404
        // rather than 500 when a caller shares a project that is not in this tenant.
        ClientsModule.register(),
        // module 13 portal, x142. The client-visible people read (`/portal/projects/:id/people`).
        // A module of its own rather than another controller on `ClientsModule`, so it stays
        // file-disjoint from the sibling portal slices; after `ProjectsModule` and `ClientsModule`
        // for the same reason as the clients module — it resolves a project tenant-scoped to answer
        // 404 rather than 500 for a cross-tenant id.
        PortalPeopleModule.register(),
        // CHAT-001. After `ProjectsModule` for the same reason: a channel names a project, and
        // a caller who names one that is not theirs should get 404 rather than a foreign-key
        // violation surfacing as 500.
        ConversationsModule.register(),
        // CAL-01 / MTG-01 (x90). After `ProjectsModule` for the same reason as conversations: a
        // meeting names a project, and the composite foreign key means a caller who names one
        // that is not theirs gets a refusal rather than a foreign-key 500.
        CalendarModule.register(),
        // CAL agenda / day view (x127). A read-only, date-bucketed agenda over the same `meetings`
        // table, in its own module beside `CalendarModule` so the sibling calendar slices stay
        // file-disjoint (each registers here rather than all editing `calendar.module.ts`).
        MeetingAgendaModule.register(),
        // DOC-01 (x91). After `ProjectsModule` for the same reason as conversations and meetings:
        // a document names a project, and the composite foreign key means a caller who names one
        // that is not theirs gets a refusal rather than a foreign-key 500.
        DocsModule.register(),
        // DOC-04 (x130). A document template's declared variables (add/list/remove). Its own module
        // rather than folded into `DocsModule`, so this slice touches no file another docs slice in
        // the same pass appends to; it depends only on the global tenant database and reuses the
        // read-only `DocumentTemplatesRepository` to resolve the parent template tenant-scoped.
        DocumentTemplateVariablesModule.register(),
        // DEC-01 (x113). The cross-meeting decision register. After `ProjectsModule` and
        // `CalendarModule` for the same reason: a decision names a project and, optionally, a
        // meeting, and the composite foreign keys mean a caller who names one that is not theirs
        // gets a refusal rather than a foreign-key 500.
        DecisionsModule.register(),
        // PROJ / module 8 (x124). A project's objectives (create/list/transition). After
        // `ProjectsModule` for the same reason as the decision register: an objective names a project
        // in its path, and the composite foreign key means a caller who names one that is not theirs
        // gets a refusal rather than a foreign-key 500.
        ProjectObjectivesModule.register(),
        // PROJ / module 8 (x136). An organization's objectives / OKRs (create/list/transition). The
        // org-level counterpart of `ProjectObjectivesModule`: org-scoped (no project in the path), so
        // it needs no `ProjectsRepository` to resolve one.
        OrgObjectivesModule.register(),
        // PROJ / module 8 (x137). The read-only portfolio roll-up across the caller's visible
        // projects. After `ProjectsModule`: it reuses `ProjectsRepository` to list the tenant's
        // projects for the relation filter, and aggregates `work_items` + `project_objectives`
        // (x124). Mounted at `…/projects/portfolio`, a static segment matched before `:projectId`.
        ProjectPortfolioModule.register(),
        // PROJ / module 8 (x138). The objective→work-item linkage (link/list/unlink). After
        // `ProjectObjectivesModule` and `WorkModule`: an edge names an objective and a work item, and
        // the composite foreign keys mean a caller who names one that is not theirs gets a refusal
        // rather than a foreign-key 500.
        ObjectiveWorkLinksModule.register(),
        // RT-001: the ticket mint. The socket itself lives in the worker.
        RealtimeModule.register(),
        // FILE-001. After `ProjectsModule` and `RequestsModule` for the same reason as the
        // requests module: a session names a project and, for a client, a request, and a
        // caller who names one that is not theirs gets 404 rather than a foreign-key 500.
        FilesModule.register(),
        // ON-09. Onboarding import (validate / dry-run). An org-level admin action reusing
        // `org.manage` (ADM-10); it persists an `import_jobs` row and commits no target entity.
        ImportModule.register(),
        // INS-01. After `WorkModule`: the insights read reuses `WorkItemsRepository` read-only to
        // roll a project's work items up by workflow status. Read-only, behind `work.read`; it
        // constructs its own repository handle (see its doc) so its position here is by subject.
        InsightsModule.register(),
        // SRCH-01 (x111). Global tenant-scoped search over work items, documents and meetings.
        // After the modules whose tables it reads, by subject; it depends only on the database and
        // a read-only `ProjectsRepository` (to resolve an optional projectId filter), never on
        // those modules' wiring, so it couples to none of them. Read-only, behind `search.use`;
        // every hit is relation-gated with `work.read` so a search never surfaces an item the
        // item's own direct read would deny.
        SearchModule.register(),
        // INS-06. The org-wide adoption roll-up (active members, members who created work, meetings
        // held) in a clamped window. A separate module from `InsightsModule` so the insights slices
        // stay file-disjoint; read-only, behind the same reused `work.read`.
        InsightsAdoptionModule.register(),
        // x134. After `InsightsModule` by subject: the forward-looking workload forecast, a second
        // read on the insights base path. Read-only over `work_items`, behind `work.read`; it
        // constructs its own repository handle (see its doc), so its position here is by subject.
        WorkloadForecastModule.register(),
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
