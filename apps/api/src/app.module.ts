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
import { PersonCapacityModule } from './modules/people/capacity.module.js';
import { ReportingLinesModule } from './modules/people/reporting-lines.module.js';
import { MemberAvailabilityModule } from './modules/people/availability.module.js';
import { PersonTimeOffModule } from './modules/people/time-off.controller.js';
import { CapacityHeatmapModule } from './modules/people/capacity-heatmap.module.js';
import { HomeModule } from './modules/home/home.module.js';
import { HomePulseModule } from './modules/home/home-pulse.module.js';
import { HomeWidgetPrefsModule } from './modules/home/widget-prefs.module.js';
import { HomeQuickLinksModule } from './modules/home/quick-links.module.js';
import { WorkViewsModule } from './modules/work-views/work-views.module.js';
import { RequestsModule } from './modules/requests/requests.module.js';
import { RequestAgingModule } from './modules/requests/request-aging.controller.js';
import { RequestTriageModule } from './modules/requests/request-triage.controller.js';
import { RequestTagsModule } from './modules/requests/request-tags.controller.js';
import { ApprovalsModule } from './modules/approvals/approvals.module.js';
import { InboxModule } from './modules/inbox/inbox.module.js';
import { InboxSnoozeModule } from './modules/inbox/inbox-snooze.module.js';
import { InboxFlagModule } from './modules/inbox/inbox-flag.module.js';
import { InboxSavedFiltersModule } from './modules/inbox/inbox-saved-filters.module.js';
import { NotificationPreferencesModule } from './modules/notifications/notification-preferences.module.js';
import { NotificationsFeedModule } from './modules/notifications/notifications-feed.module.js';
import { NotificationKindPrefsModule } from './modules/notifications/notification-kind-prefs.module.js';
import { A11yPreferencesModule } from './modules/preferences/a11y-preferences.module.js';
import { DisplayPreferencesModule } from './modules/preferences/display-prefs.module.js';
import { QuietHoursModule } from './modules/preferences/quiet-hours.module.js';
import { ShortcutPrefsModule } from './modules/preferences/shortcut-prefs.module.js';
import { StartupPrefsModule } from './modules/preferences/startup-prefs.module.js';
import { PreferencesModule } from './modules/preferences/preferences.module.js';
import { DigestPreferenceModule } from './modules/preferences/digest.module.js';
import { ConversationsModule } from './modules/conversations/conversations.module.js';
import { MessagePinsModule } from './modules/conversations/message-pins.module.js';
import { MessageBookmarksModule } from './modules/conversations/message-bookmarks.controller.js';
import { ThreadRepliesModule } from './modules/conversations/thread-replies.module.js';
import { ConversationReadStateModule } from './modules/conversations/read-state.module.js';
import { ConversationMuteModule } from './modules/conversations/conversation-mute.module.js';
import { ConversationSearchModule } from './modules/conversations/conversation-search.module.js';
import { MyMentionsModule } from './modules/conversations/my-mentions.controller.js';
import { MessageAttachmentsModule } from './modules/conversations/message-attachments.controller.js';
import { CalendarModule } from './modules/calendar/calendar.module.js';
import { MeetingAgendaModule } from './modules/calendar/meeting-agenda.module.js';
import { AgendaTemplatesModule } from './modules/calendar/agenda-templates.module.js';
import { CalendarGridModule } from './modules/calendar/grid.controller.js';
import { OccurrenceOverrideModule } from './modules/calendar/occurrence-override.module.js';
import { MeetingActionItemsModule } from './modules/calendar/meeting-action-items.module.js';
import { MeetingRsvpModule } from './modules/calendar/rsvp.module.js';
import { MeetingTimePollModule } from './modules/calendar/time-poll.module.js';
import { DocsModule } from './modules/docs/docs.module.js';
import { DocumentTemplateVariablesModule } from './modules/docs/document-template-variables.controller.js';
import { RevisionsModule } from './modules/docs/revisions.controller.js';
import { BookmarksModule } from './modules/docs/bookmarks.controller.js';
import { GlossaryModule } from './modules/docs/glossary.controller.js';
import { DocCollectionsModule } from './modules/docs/collections.controller.js';
import { DocTagsModule } from './modules/docs/doc-tags.controller.js';
import { SubscriptionsModule } from './modules/docs/subscriptions.controller.js';
import { AutomationSchedulesModule } from './modules/automations/schedules.controller.js';
import { DecisionsModule } from './modules/decisions/decisions.module.js';
import { DecisionWorkLinksModule } from './modules/decisions/decision-work-links.module.js';
import { ProjectObjectivesModule } from './modules/projects/project-objectives.module.js';
import { ProjectTagsModule } from './modules/projects/project-tags.module.js';
import { ProjectFavoritesModule } from './modules/projects/project-favorites.controller.js';
import { PeopleModule } from './modules/people/people.module.js';
import { ProjectRiskRegisterModule } from './modules/projects/risk-register.module.js';
import { ProjectTemplatesModule } from './modules/projects/templates.module.js';
import { ProjectStatusUpdatesModule } from './modules/projects/status-updates.module.js';
import { ProjectBudgetModule } from './modules/projects/budget.module.js';
import { ProjectPhasesModule } from './modules/projects/phases.module.js';
import { ProjectBaselineModule } from './modules/projects/baseline.module.js';
import { ProjectCustomFieldsModule } from './modules/projects/custom-fields.module.js';
import { ProjectRetroNotesModule } from './modules/projects/retro-notes.module.js';
import { OrgObjectivesModule } from './modules/projects/org-objectives.module.js';
import { ProjectPortfolioModule } from './modules/projects/portfolio.module.js';
import { ProjectHealthModule } from './modules/projects/health.module.js';
import { ObjectiveWorkLinksModule } from './modules/projects/objective-work-links.module.js';
import { MilestoneLinksModule } from './modules/projects/milestone-links.module.js';
import { ProjectDependenciesModule } from './modules/projects/dependencies.module.js';
import { KeyResultsModule } from './modules/projects/key-results.module.js';
import { ClientsModule } from './modules/clients/clients.module.js';
import { PortalPeopleModule } from './modules/clients/portal-people.module.js';
import { PortalSettingsModule } from './modules/clients/portal-settings.controller.js';
import { PortalFeedbackModule } from './modules/portal/feedback.module.js';
import { PortalBrandingModule } from './modules/portal/branding.controller.js';
import { OrgSettingsModule } from './modules/tenancy/org-settings.controller.js';
import { CustomRolesModule } from './modules/admin/roles.controller.js';
import { RoleEditModule } from './modules/admin/role-edit.controller.js';
import { MemberBulkRoleModule } from './modules/tenancy/member-bulk-role.controller.js';
import { AdminSessionsModule } from './modules/identity/admin-sessions.controller.js';
import { MemberNotesModule } from './modules/admin/member-notes.controller.js';
import { PersonalAccessTokensModule } from './modules/personal-access-tokens/personal-access-tokens.controller.js';
import { McpEndpointModule } from './modules/mcp/mcp-endpoint.controller.js';
import { AdminPoliciesModule } from './modules/admin/policies.controller.js';
import { AdminPolicySimulateModule } from './modules/admin/policy-simulate.controller.js';
import { AdminOverviewModule } from './modules/admin/overview.controller.js';
import { AdminSecurityModule } from './modules/admin/security.controller.js';
import { AdminSecurityAlertsModule } from './modules/admin/security-alerts.controller.js';
import { AdminExportRequestsModule } from './modules/admin/export-requests.controller.js';
import { OrgAnnouncementsModule } from './modules/admin/announcements.controller.js';
import { AdminIpAllowlistModule } from './modules/admin/ip-allowlist.controller.js';
import { FeatureFlagsModule } from './modules/admin/feature-flags.controller.js';
import { AdminAuditRetentionModule } from './modules/admin/audit-retention.controller.js';
import { OrgBrandingModule } from './modules/admin/org-branding.controller.js';
import { AdminInvitationManagementModule } from './modules/admin/invitation-management.controller.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuditExportModule } from './modules/audit/audit-export.controller.js';
import { MailerModule } from './common/email/mailer.module.js';
import { StorageModule } from './common/storage/storage.module.js';
import { ScannerModule } from './common/scan/scanner.module.js';
import { PlatformModule } from './modules/platform/platform.module.js';
import { RealtimeModule } from './modules/realtime/realtime.module.js';
import { FilesModule } from './modules/files/files.module.js';
import { ImportModule } from './modules/import/import.module.js';
import { InsightsModule } from './modules/insights/insights.module.js';
import { SearchModule } from './modules/search/search.module.js';
import { SavedSearchesModule } from './modules/search/saved-searches.module.js';
import { SavedSearchSharesModule } from './modules/search/saved-search-shares.module.js';
import { SearchHistoryModule } from './modules/search/search-history.module.js';
import { SearchPinsModule } from './modules/search/search-pins.module.js';
import { SearchScopesModule } from './modules/search/saved-scopes.module.js';
import { CommandsModule } from './modules/search/commands.controller.js';
import { SuggestionsModule } from './modules/search/suggestions.controller.js';
import { CopilotModule } from './modules/copilot/copilot.module.js';
import { InsightsAdoptionModule } from './modules/insights/adoption.controller.js';
import { WorkloadForecastModule } from './modules/insights/workload-forecast.module.js';
import { SavedInsightViewsModule } from './modules/insights/saved-insight-views.module.js';
import { InsightSnapshotsModule } from './modules/insights/snapshots.controller.js';
import { InsightReportSchedulesModule } from './modules/insights/report-schedules.module.js';
import { InsightComparisonModule } from './modules/insights/comparison.controller.js';
import { InsightTargetsModule } from './modules/insights/targets.controller.js';
import { InsightAnnotationsModule } from './modules/insights/insight-annotations.controller.js';
import { InsightDashboardLayoutModule } from './modules/insights/dashboard-layout.module.js';
import { InsightMetricAlertsModule } from './modules/insights/metric-alerts.controller.js';
import { InsightCustomReportsModule } from './modules/insights/custom-reports.module.js';
import { PublicSiteModule } from './modules/public-site/public-site.module.js';
import { PublicResourcesModule } from './modules/public-site/resources.controller.js';
import { TrustContentModule } from './modules/public-site/trust-content.module.js';
import { PublicChangelogModule } from './modules/public-site/changelog.module.js';
import { ContactModule } from './modules/public-site/contact.module.js';
import { FirstOwnerModule } from './modules/setup/first-owner.module.js';
import { publicSignupModules } from './modules/signup/public-signup.module.js';
import { googleAuthModules } from './modules/google-auth/google-auth.module.js';
import { AutomationsModule } from './modules/automations/automations.module.js';
import { IntegrationDirectoryModule } from './modules/automations/directory.controller.js';
import { ConnectionHealthModule } from './modules/automations/connection-health.controller.js';
import { WebhooksModule } from './modules/automations/webhooks.controller.js';
import { WebhookDeliveriesModule } from './modules/automations/webhook-deliveries.controller.js';
import { MaintenanceModule } from './modules/platform/maintenance.controller.js';
import { FaqContentModule } from './modules/public-site/faq.module.js';
import { PeopleSkillsModule } from './modules/people/people-skills.module.js';
import { SkillSearchModule } from './modules/people/skill-search.module.js';
import { BillingModule } from './modules/billing/billing.module.js';
import { BillingContactsModule } from './modules/billing/contacts.controller.js';
import { BillingUsageAlertsModule } from './modules/billing/usage-alerts.controller.js';
import { BillingCostCentersModule } from './modules/billing/cost-centers.controller.js';
import { BillingPurchaseOrdersModule } from './modules/billing/purchase-orders.controller.js';
import { CostCenterReportModule } from './modules/billing/cost-center-report.controller.js';
import { PersonProfileModule } from './modules/people/profile.controller.js';
import { PeopleTeamsModule } from './modules/people/teams.controller.js';
import { BillingSeatsModule } from './modules/billing/seats.controller.js';
import { InvoicesModule } from './modules/billing/invoices.module.js';
import { MemberProfileModule } from './modules/people/member-profile.controller.js';
import { PersonCertificationsModule } from './modules/people/certifications.controller.js';
import { InvoiceLineItemsModule } from './modules/billing/invoice-line-items.module.js';
import { BillingCreditsModule } from './modules/billing/credits.controller.js';
import { BillingDiscountsModule } from './modules/billing/discounts.controller.js';
import { BillingUsageExportModule } from './modules/billing/usage-export.controller.js';

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
        // ADM-09 filtered export (module 18, x197). A date-windowed CSV of the audit trail behind
        // `audit.export`, distinct from x118's `events/export`: a module of its own so it stays
        // file-disjoint from the audit viewer/export controller; depends only on the globally-
        // exported `AUDIT_SERVICE`, which `AuditModule` above provides.
        AuditExportModule.register(),
        // PLAT-004: the outbox writer, global for the reason the audit module is — three
        // feature modules append events from inside their own transactions.
        PlatformModule.register(),
        // Before `TenancyModule`, whose invitations service is the mail port's first
        // producer and resolves `INVITATION_MAILER` from this injector.
        options.mailer ?? MailerModule.none(),
        options.storage ?? StorageModule.none(),
        options.scanner ?? ScannerModule.none(),
        TenancyModule.register(),
        // ADM settings (module 18, x153). Organization settings / policy (read + update) behind
        // `org.manage`. A module of its own rather than another controller on `TenancyModule`, so it
        // stays file-disjoint from the organization-profile routes; depends only on the global
        // `TENANT_DATABASE`.
        OrgSettingsModule.register(),
        CustomRolesModule.register(),
        RoleEditModule.register(),
        // Admin bulk role assignment (module 18, x222). Assigns an existing custom role to many
        // memberships in one bounded batch behind `org.manage`, re-running the x173/x195 escalation
        // guard before any write. Its own module rather than a controller on `TenancyModule`, matching
        // the roles surface it extends.
        MemberBulkRoleModule.register(),
        AdminSessionsModule.register(),
        MemberNotesModule.register(),
        // Organization access policies (Administration module 18, x174) behind `org.manage`. A module of
        // its own, file-disjoint from x153's org-settings routes; depends only on the global
        // `TENANT_DATABASE`.
        AdminPoliciesModule.register(),
        // Access-policy simulation (Administration module 18, x196) behind `org.manage`. Read-only
        // "can member X do Y?" over stored roles + policies; a module of its own, file-disjoint from
        // x174's AdminPoliciesModule, depends only on the global `TENANT_DATABASE`.
        AdminPolicySimulateModule.register(),
        // x175: the admin overview roll-up. Read-only org-health aggregation over memberships,
        // usage counters and audit events behind `org.manage`; a module of its own so it stays
        // file-disjoint from the other administration slices. Depends only on `TENANT_DATABASE`.
        AdminOverviewModule.register(),
        // ADM security (module 18, x176). Organization security settings (2FA enforcement + IP
        // allowlist config) read + update behind `org.manage`. A module of its own, file-disjoint from
        // the org-settings and audit slices in the same module; depends only on the global
        // `TENANT_DATABASE`. Config surface only — enforcement in the auth path is a later slice.
        AdminSecurityModule.register(),
        AdminSecurityAlertsModule.register(),
        AdminExportRequestsModule.register(),
        // ADM org announcements (module 18, x276). Org-wide announcement banners: post + delete behind
        // `org.manage`, active-now read behind `work.read`. A module of its own, file-disjoint from the
        // other administration slices; depends only on the global `TENANT_DATABASE`. Per-member
        // dismissal is client-remembered, so there is no second table.
        OrgAnnouncementsModule.register(),
        // ADM security (module 18, x277). Organization IP allowlist — a security admin's advisory list
        // of allowed IP/CIDR ranges (list/add/remove) behind `org.security.manage`. A module of its
        // own, file-disjoint from the security-settings and audit slices in the same module; depends
        // only on the global `TENANT_DATABASE`. Advisory record only — no request-time enforcement.
        AdminIpAllowlistModule.register(),
        // ADM per-org feature flags (module 18, x278). An org admin enables/disables optional
        // modules via named flags behind `org.manage`; the resolved flag map for the caller's own
        // org is read behind `work.read`. Both org-scoped, file-disjoint from the other admin
        // slices; depends only on the global `TENANT_DATABASE`.
        FeatureFlagsModule.register(),
        // ADM audit retention (module 18, x279). An org-admin sets an audit-log retention window and
        // previews how many audit_events fall outside it, behind `org.manage`. A module of its own,
        // file-disjoint from the other administration slices; depends only on the global
        // `TENANT_DATABASE`. Preview + policy only — no destructive purge in this slice.
        AdminAuditRetentionModule.register(),
        // ADM / org identity (module 18, x327). Org-wide branding for the internal app chrome —
        // product name, accent colour, logo text — set behind `org.manage`, read by any member behind
        // `work.read`. A module of its own, file-disjoint from the other admin slices; depends only on
        // the global `TENANT_DATABASE`. Text/colour only — no file upload this slice.
        OrgBrandingModule.register(),
        // ADM invitation management (module 18, x328). Pending-invitation list + idempotent revoke
        // over the existing `invitations` table, behind `org.manage`. No migration, no new table; a
        // module of its own, file-disjoint from the tenancy invitation-issuance slices; depends only
        // on the global `TENANT_DATABASE`. Metadata only — no token or secret is ever returned.
        AdminInvitationManagementModule.register(),
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
        // Home widget preferences (x243). The caller's-own Home widget layout GET/PUT behind
        // `work.read`; a separate module so it adds nothing to HomeModule and stays file-disjoint.
        HomeWidgetPrefsModule.register(),
        HomeQuickLinksModule.register(),
        // WK-04. The Work views read layer — a read-only composition of the work + work-graph
        // reads (timeline). After `WorkModule` by subject, though it depends only on the
        // database and never on the work service, so it does not couple to that module's wiring.
        WorkViewsModule.register(),
        // After `WorkModule`: REQ-001 reads a work item to answer 422 rather than 500 when an
        // acceptance links to one that is not in this tenant.
        RequestsModule.register(),
        // module 11 requests, x154. The overdue-to-triage / long-uncommitted aging read
        // (`/client-requests/aging`). A module of its own rather than another controller on
        // `RequestsModule`, so it stays file-disjoint from the list/triage controller; read-only over
        // `client_requests`, behind the same reused `client_request.triage`.
        RequestAgingModule.register(),
        // module 11 requests, x265. Internal triage metadata for a request (category + assignee),
        // `PUT`/`GET /client-requests/:id/triage`. Its own module and table (`request_triage`) rather
        // than an edit to the list/lifecycle controller, so it stays file-disjoint; behind the same
        // reused internal-only `client_request.triage`.
        RequestTriageModule.register(),
        // module 11 requests, x316. Free-text triage labels on a client request
        // (`/client-requests/:id/tags`). A module of its own rather than another controller on
        // `RequestsModule`, so it stays file-disjoint; behind the same reused `client_request.triage`,
        // resolving the parent request tenant-scoped before it authorizes or writes.
        RequestTagsModule.register(),
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
        // INBOX snooze (IN-01/IN-02, x259). A member snoozes an inbox bundle until a chosen time so
        // it drops out of their active inbox. A module of its own beside the inbox so this slice stays
        // file-disjoint from it; it resolves the bundle's object through its own tenant-scoped read
        // and depends on nothing but the database.
        InboxSnoozeModule.register(),
        // INBOX-001 IN-01 "Important inbox" (x260). The caller's own flag (star) on an inbox bundle:
        // PUT/DELETE :bundleId/flag and GET flagged, behind `work.read`. Its own module — file-disjoint
        // from InboxModule — and it constructs no object services: the flag's ownership gate reads the
        // caller's own notification rows directly, so a flag is only ever a member's own on a bundle
        // they may see.
        InboxFlagModule.register(),
        // INBOX saved filters (IN-02, x261). A member's own named inbox filter sets (create/list/
        // delete) behind the inbox read capability. Separate from `InboxModule` because both are
        // `.register()`-based; a stateless service over the tenant database with its own repository.
        InboxSavedFiltersModule.register(),
        // NOTIF-001. The caller's own notification settings (GET/PUT). No tenant object to
        // resolve, so unlike the inbox it depends on nothing but the database.
        NotificationPreferencesModule.register(),
        // NOTIF feed (x151). The flat per-notification feed (GET list, POST :id/read) over the
        // same `notifications` rows the inbox bundles. A module of its own beside the inbox and
        // preferences modules so the notifications slices stay file-disjoint; it depends on
        // nothing but the database — the feed echoes the reference envelope and resolves no object.
        NotificationsFeedModule.register(),
        // Per-kind notification opt-out (x152) — the finer sibling of the coarse preferences above.
        // A module of its own so it stays file-disjoint from that slice; depends on nothing but the
        // `@Global` database, so its position here is by subject, not by need.
        NotificationKindPrefsModule.register(),
        // A11Y-183 (x183, module 20). The caller's own accessibility settings (GET/PUT
        // /me/accessibility). Like NOTIF-001's preferences it resolves no tenant object and depends
        // on nothing but the database; file-disjoint from the sibling preferences slice (x182).
        A11yPreferencesModule.register(),
        // PREF-DISPLAY (x285, module 20). The caller's own display-preferences hub (GET/PUT
        // /me/display-preferences: theme/density/locale/timezone/date format). Like the sibling
        // preferences slices it resolves no tenant object and depends on nothing but the database;
        // file-disjoint from x182/x183.
        DisplayPreferencesModule.register(),
        // PREF-QUIET (x215, module 20). The caller's own notification quiet-hours window (GET/PUT
        // /preferences/quiet-hours and GET .../active). Like the sibling preferences slices it
        // resolves no tenant object and depends on nothing but the database; file-disjoint from
        // x182/x183.
        QuietHoursModule.register(),
        // PRF keyboard shortcuts (x286, module 20). The caller's own command-palette shortcut
        // overrides (GET /me/shortcuts, PUT/DELETE /me/shortcuts/:actionKey). Like the sibling
        // preferences slices it resolves no tenant object and depends on nothing but the database;
        // file-disjoint from x182/x183/x215.
        ShortcutPrefsModule.register(),
        // PREF-STARTUP (x287, module 20). The caller's own default startup landing view (GET/PUT
        // /me/startup). Like the sibling preferences slices it resolves no tenant object and depends
        // on nothing but the database; file-disjoint from x183/x215.
        StartupPrefsModule.register(),
        PreferencesModule.register(),
        // PREF-DIGEST (x245, module 20). The caller's own notification digest cadence (GET/PUT
        // /preferences/digest). Like the sibling preferences slices it resolves no tenant object and
        // depends on nothing but the database; file-disjoint from x182/x183/x215. Storage only — no
        // dispatcher or email in this slice.
        DigestPreferenceModule.register(),
        // After `ProjectsModule`: `ClientsService` reads `PROJECTS_REPOSITORY` to answer 404
        // rather than 500 when a caller shares a project that is not in this tenant.
        ClientsModule.register(),
        // module 13 portal, x142. The client-visible people read (`/portal/projects/:id/people`).
        // A module of its own rather than another controller on `ClientsModule`, so it stays
        // file-disjoint from the sibling portal slices; after `ProjectsModule` and `ClientsModule`
        // for the same reason as the clients module — it resolves a project tenant-scoped to answer
        // 404 rather than 500 for a cross-tenant id.
        PortalPeopleModule.register(),
        // SEC / Client portal settings (module 13, x238). Per-project client-portal settings/branding:
        // an internal read/write (`GET`/`PUT …/projects/:id/portal-settings`, `project.manage`) and a
        // client projection (`GET …/portal/projects/:id/portal-settings`, `client_projection.read`). A
        // module of its own rather than another controller on `ClientsModule`, so it stays file-disjoint
        // from the sibling portal slices; after `ProjectsModule` and `ClientsModule` for the same reason —
        // it resolves a project tenant-scoped to answer 404 rather than 500 for a cross-tenant id. Over the
        // new `portal_settings` table; the client projection carries the presentation fields only, never
        // `updatedBy`.
        PortalSettingsModule.register(),
        // SEC / Portal deliverable feedback (module 13, x321). A client contact rates a published
        // deliverable (`POST …/portal/deliverables/:id/feedback`, `client_projection.read`) and staff
        // read the feedback (`GET …/portal/deliverables/:id/feedback`, `client_member.manage`). A
        // module of its own rather than another controller on `ClientsModule`, so it stays
        // file-disjoint from the sibling portal slices; it resolves the client-visible version
        // tenant-scoped (the x114 projection) to answer 404 rather than 500 for a cross-tenant id.
        // Over the new `portal_feedback` table.
        PortalFeedbackModule.register(),
        // SEC / Client portal branding (module 13, x323). Per-client-organization client-facing
        // branding: a staff write (`PUT …/portal/branding/:clientOrganizationId`, `client_member.manage`)
        // and a client projection (`GET …/portal/branding/client/:clientOrganizationId`,
        // `client_projection.read`). A module of its own rather than another controller on `ClientsModule`,
        // so it stays file-disjoint from the sibling portal slices; over the new `portal_branding` table.
        // The service resolves the client-org scope tenant-scoped first (404) and only then authorizes.
        PortalBrandingModule.register(),
        // CHAT-001. After `ProjectsModule` for the same reason: a channel names a project, and
        // a caller who names one that is not theirs should get 404 rather than a foreign-key
        // violation surfacing as 500.
        ConversationsModule.register(),
        // x247. Chat message pins — a small aggregate beside conversations, sharing its tables'
        // resolve path; registered after it so the conversation and message resolve tenant-scoped.
        MessagePinsModule.register(),
        // CH-07 saved messages (x248). Its own module beside `ConversationsModule` so the sibling
        // chat slices stay file-disjoint (each registers here rather than all editing
        // `conversations.module.ts`). Its `MessageBookmarksModule` is exported from the controller
        // file rather than a separate module file.
        MessageBookmarksModule.register(),
        // x249. A message's thread replies — its own append-only table, resolving the conversation
        // and root message through a read-only handle; after `ConversationsModule` for the same
        // foreign-key reason.
        ThreadRepliesModule.register(),
        // Conversation read-state (x250). A member's last-read position per channel and the unread
        // count from it. Its own module rather than folded into `ConversationsModule`, so this slice
        // touches no file another chat slice in the same pass appends to; it depends only on the
        // global tenant database and reuses the read-only conversation repository.
        ConversationReadStateModule.register(),
        ConversationMuteModule.register(),
        // CH-10 (x253). In-conversation message search — read-only, its own gate reused from the
        // conversation service, mounted at `…/messages/search`.
        ConversationSearchModule.register(),
        // CHAT my-mentions (x254). A read-only, own-principal list of the messages that mention the
        // caller across the channels they belong to. Its own module beside `ConversationsModule` so
        // the sibling chat slices stay file-disjoint; no table, and the relation filter is the
        // service's, exactly as the channel list's is.
        MyMentionsModule.register(),
        // CH-06 composer attachments (x275). Its own module beside `ConversationsModule` so the
        // sibling chat slices stay file-disjoint (each registers here rather than all editing
        // `conversations.module.ts`). Its `MessageAttachmentsModule` is exported from the controller
        // file rather than a separate module file.
        MessageAttachmentsModule.register(),
        // CAL-01 / MTG-01 (x90). After `ProjectsModule` for the same reason as conversations: a
        // meeting names a project, and the composite foreign key means a caller who names one
        // that is not theirs gets a refusal rather than a foreign-key 500.
        CalendarModule.register(),
        // CAL agenda / day view (x127). A read-only, date-bucketed agenda over the same `meetings`
        // table, in its own module beside `CalendarModule` so the sibling calendar slices stay
        // file-disjoint (each registers here rather than all editing `calendar.module.ts`).
        MeetingAgendaModule.register(),
        // CAL agenda templates (x314). Reusable meeting agenda templates (name + ordered items) and
        // an apply action that seeds a meeting's item store idempotently, in its own module beside
        // `MeetingAgendaModule` so the sibling calendar slices stay file-disjoint.
        AgendaTemplatesModule.register(),
        // CAL week/month grid (x212). A read-only grid over the same `meetings` table plus the
        // `meeting_series` recurrence rules, in its own module beside `MeetingAgendaModule` so the
        // sibling calendar slices stay file-disjoint. Its `CalendarGridModule` is exported from the
        // controller file rather than a separate module file.
        CalendarGridModule.register(),
        // CAL per-occurrence override (x213). Read/upsert/remove the exception for one occurrence of a
        // recurring series, in its own module beside `CalendarModule` so the sibling calendar slices
        // stay file-disjoint (each registers here rather than all editing `calendar.module.ts`). The
        // service resolves the series tenant-scoped before it acts, so a cross-tenant series is a 404.
        OccurrenceOverrideModule.register(),
        // CAL meeting RSVP (x240). A member's own response (accept/decline/tentative) to a meeting
        // they can see, over its own `meeting_rsvps` table. In its own module beside `CalendarModule`
        // so the sibling calendar slices stay file-disjoint (each registers here rather than all
        // editing `calendar.module.ts`); it resolves the path meeting tenant-scoped before authorize.
        MeetingRsvpModule.register(),
        // CAL / MTG-03 meeting action items (x266). Capture/list/edit/toggle/remove the actions
        // linked to a meeting, over its own `meeting_action_items` table. In its own module beside
        // `CalendarModule` so the sibling calendar slices stay file-disjoint (each registers here
        // rather than all editing `calendar.module.ts`); it resolves the path meeting tenant-scoped
        // before authorize, so a cross-tenant meeting is a 404 with no write.
        MeetingActionItemsModule.register(),
        // CAL meeting time-option poll (x298). An organiser proposes candidate time slots, invitees
        // vote yes/maybe/no on each, and the tally picks the time — over its own `meeting_time_polls`
        // and `meeting_time_poll_votes` tables. In its own module beside `CalendarModule` so the
        // sibling calendar slices stay file-disjoint (each registers here rather than all editing
        // `calendar.module.ts`); it resolves the path meeting tenant-scoped before authorize.
        MeetingTimePollModule.register(),
        // DOC-01 (x91). After `ProjectsModule` for the same reason as conversations and meetings:
        // a document names a project, and the composite foreign key means a caller who names one
        // that is not theirs gets a refusal rather than a foreign-key 500.
        DocsModule.register(),
        // DOC-04 (x130). A document template's declared variables (add/list/remove). Its own module
        // rather than folded into `DocsModule`, so this slice touches no file another docs slice in
        // the same pass appends to; it depends only on the global tenant database and reuses the
        // read-only `DocumentTemplatesRepository` to resolve the parent template tenant-scoped.
        DocumentTemplateVariablesModule.register(),
        // DOC revision history (x241). A document's snapshot trail (capture/list/restore). Its own
        // module rather than folded into `DocsModule`, so this slice touches no file another docs
        // slice in the same pass appends to; it depends only on the global tenant database and reuses
        // the read-only `DocumentsRepository` to resolve the parent document tenant-scoped.
        RevisionsModule.register(),
        // DOC bookmarks / favorites (x242). A member's private favorites over documents (bookmark/
        // unbookmark/status/list). Its own module rather than folded into `DocsModule`, so this slice
        // touches no file another docs slice in the same pass appends to; it depends only on the global
        // tenant database and reuses the read-only `DocumentsRepository` to resolve the parent document
        // tenant-scoped.
        BookmarksModule.register(),
        // Org glossary of terms (x263). A studio's shared vocabulary (add/edit/remove behind
        // `doc.write`, search/list behind `doc.read`). Its own module rather than folded into
        // `DocsModule`, so this slice touches no file another docs slice in the same pass appends to;
        // it depends only on the global tenant database.
        GlossaryModule.register(),
        DocCollectionsModule.register(),
        DocTagsModule.register(),
        // DOC subscriptions (x312): a member's explicit follow list over documents (follow/unfollow/
        // status/list) — a read-side flag only, no notification dispatch. Its own module rather than
        // folded into `DocsModule`, so this slice touches no file another docs slice in the same pass
        // appends to; it depends only on the global tenant database and reuses the read-only
        // `DocumentsRepository` to resolve the parent document tenant-scoped.
        SubscriptionsModule.register(),
        AutomationSchedulesModule.register(),
        // DEC-01 (x113). The cross-meeting decision register. After `ProjectsModule` and
        // `CalendarModule` for the same reason: a decision names a project and, optionally, a
        // meeting, and the composite foreign keys mean a caller who names one that is not theirs
        // gets a refusal rather than a foreign-key 500.
        DecisionsModule.register(),
        DecisionWorkLinksModule.register(),
        // PROJ / module 8 (x124). A project's objectives (create/list/transition). After
        // `ProjectsModule` for the same reason as the decision register: an objective names a project
        // in its path, and the composite foreign key means a caller who names one that is not theirs
        // gets a refusal rather than a foreign-key 500.
        ProjectObjectivesModule.register(),
        // PROJ / portfolio (x267). The org-defined project tag taxonomy and its per-project
        // assignments (`…/projects/tags`, `…/projects/:projectId/tags`). After `ProjectsModule` for
        // the same reason as the objectives register: an assignment names a project in its path, and
        // the composite foreign key means a caller who names one that is not theirs gets a 404 rather
        // than a foreign-key 500. A module of its own, file-disjoint from the projects/portfolio
        // controllers.
        ProjectTagsModule.register(),
        // PROJ project favorites (x268). A member stars a project for their compact switcher
        // (star/unstar/status/list). Its own module rather than folded into `ProjectsModule`, so this
        // slice touches no file another projects slice in the same pass appends to; it depends only
        // on the global tenant database and reuses the read-only `ProjectsRepository` to resolve the
        // parent project tenant-scoped before the write.
        ProjectFavoritesModule.register(),
        // PEOPLE / module 14 (x171). A project's people allocations (assign a member a share of their
        // time, list them). After `ProjectsModule` for the same reason as the objectives register: an
        // allocation names a project (and a membership) in its path/body, and the composite foreign
        // keys mean a caller who names one that is not theirs gets a 404 rather than a foreign-key 500.
        PeopleModule.register(),
        // PROJ / module 8 (x209). A project's internal risk register (log/list/update) — a formal
        // likelihood×impact matrix with a computed severity and a mitigation plan. After
        // `ProjectsModule` for the same reason as the objectives register: a risk names a project in
        // its path, and the composite foreign key means a caller who names one that is not theirs gets
        // a 404 rather than a foreign-key 500. Internal-only and distinct from x140's portal risks:
        // a different path (`…/projects/:id/risk-register`) and a different table
        // (`project_internal_risks`); never projected to a client.
        ProjectRiskRegisterModule.register(),
        // PROJ / module 8 (x234). Reusable project templates (define/list/instantiate). Org-scoped
        // (no project in the path), so like the org objectives it needs no `ProjectsRepository` to
        // resolve one; `instantiate` delegates to the shared `ProjectsService` create path. Mounted at
        // `…/projects/templates`, a static segment matched like `…/projects/portfolio` and
        // `…/projects/health`.
        ProjectTemplatesModule.register(),
        // PROJ / module 8 (x235). A project's internal status-update log (post/list newest-first,
        // keyset-paged). After `ProjectsModule` for the same reason as the risk register: an update
        // names a project in its path, and the composite foreign key means a caller who names one that
        // is not theirs gets a 404 rather than a foreign-key 500. Internal-only and distinct from
        // x125's portal updates: a different path (`…/projects/:id/status-updates`) and a different
        // table (`project_status_updates`); never projected to a client.
        ProjectStatusUpdatesModule.register(),
        // PROJ / project detail (x293). A project's budget: set effort and/or an amount, and read a
        // budget-vs-tracked summary that sums the effort logged on the project's work items
        // (`work_item_time_logs`, 0103, read-only). After `ProjectsModule` for the same reason as the
        // risk register: a budget names a project in its path, and the composite foreign key means a
        // caller who names one that is not theirs gets a 404 rather than a foreign-key 500. Both
        // routes are gated on `project.manage`; the amount is a planning number, never a payment.
        ProjectBudgetModule.register(),
        // PROJ / module 8 (x294). A project's timeline phases (define/list/delete a phase, assign a
        // milestone to a phase). After `ProjectsModule` for the same reason as the risk register: a
        // phase names a project in its path, and the composite foreign key means a caller who names
        // one that is not theirs gets a 404 rather than a foreign-key 500. The milestone-to-phase
        // assignment is recorded on `project_phases`, never on `project_milestones` — this slice
        // references milestone ids without editing the milestones table.
        ProjectPhasesModule.register(),
        // PROJ / module 8 (x295). A project's milestone-plan baseline: snapshot the current plan as a
        // named baseline, list them, and read a variance view (today's dates vs the frozen plan).
        // After `ProjectsModule` for the same reason as the risk register: a baseline names a project
        // in its path, and the composite foreign key means a caller who names one that is not theirs
        // gets a 404 rather than a foreign-key 500. Reads `project_milestones` (0048) read-only.
        ProjectBaselineModule.register(),
        // PROJ / module 8 (x310). Custom fields for projects: org-level field definitions
        // (`…/projects/custom-fields`, a static segment matched ahead of `:projectId` like
        // `…/projects/templates`, gated on `org.manage`) and per-project values
        // (`…/projects/:projectId/custom-fields`, gated on `project.manage`). After `ProjectsModule`
        // for the same reason as the status log: a value names a project, and the service resolves it
        // tenant-scoped before it writes so a caller who names one that is not theirs gets a 404.
        ProjectCustomFieldsModule.register(),
        // PROJ / module 8 (x311). A project's retrospective-notes log (capture/list-by-category/
        // delete). After `ProjectsModule` for the same reason as the status log: a note names a
        // project in its path, and the composite foreign key means a caller who names one that is not
        // theirs gets a 404 rather than a foreign-key 500. An optional milestone reference is resolved
        // tenant-scoped (unknown ⇒ 400). Mounted at `…/projects/:id/retro-notes`.
        ProjectRetroNotesModule.register(),
        // PROJ / module 8 (x136). An organization's objectives / OKRs (create/list/transition). The
        // org-level counterpart of `ProjectObjectivesModule`: org-scoped (no project in the path), so
        // it needs no `ProjectsRepository` to resolve one.
        OrgObjectivesModule.register(),
        // PROJ / module 8 (x137). The read-only portfolio roll-up across the caller's visible
        // projects. After `ProjectsModule`: it reuses `ProjectsRepository` to list the tenant's
        // projects for the relation filter, and aggregates `work_items` + `project_objectives`
        // (x124). Mounted at `…/projects/portfolio`, a static segment matched before `:projectId`.
        ProjectPortfolioModule.register(),
        // PROJ / module 8 (x208). The read-only computed health roll-up over the caller's visible
        // projects. After `ProjectsModule` for the same reason as the portfolio: it reuses
        // `ProjectsRepository` for the relation filter, and aggregates milestones (x139), risks (x140)
        // and objectives (x124) into a fixed-weight score/band. The list is mounted at the static
        // `…/projects/health`, matched before `:projectId`; the per-project read at `:projectId/health`.
        ProjectHealthModule.register(),
        // PROJ / module 8 (x138). The objective→work-item linkage (link/list/unlink). After
        // `ProjectObjectivesModule` and `WorkModule`: an edge names an objective and a work item, and
        // the composite foreign keys mean a caller who names one that is not theirs gets a refusal
        // rather than a foreign-key 500.
        ObjectiveWorkLinksModule.register(),
        // PROJ / module 8 (x236). Milestone dependency edges (link/list/unlink). After the milestone
        // table exists (x139, 0048): an edge names two milestones, and the composite foreign keys mean
        // a caller who names one that is not theirs gets a refusal rather than a foreign-key 500.
        MilestoneLinksModule.register(),
        // PROJ / cross-project dependencies (x309). The directed dependency edges between whole
        // projects (record/list/remove). After the projects table exists: an edge names two
        // projects, and the composite foreign keys mean a caller who names one that is not theirs
        // gets a refusal rather than a foreign-key 500. Distinct from `MilestoneLinksModule`
        // (milestone-level) and the work-item blockers (item-level).
        ProjectDependenciesModule.register(),
        // People / module 14 (x170). Per-member weekly capacity (set/read). After `TenancyModule`:
        // the controller resolves `:membershipId` tenant-scoped via a `MembershipsRepository` (provided
        // in the module's own scope) before any write, so a cross-tenant member is a 404, not a 500.
        PersonCapacityModule.register(),
        // PEOPLE reporting lines / org chart (module 14, x217). Wires the reporting-lines repository and
        // the memberships repository the controller uses to resolve the member and manager tenant-scoped
        // before any write, so a cross-tenant id is a 404, not a 500.
        ReportingLinesModule.register(),
        // People / module 14 (x218). Member availability / out-of-office windows: a member manages
        // their own dated OOO windows (POST/GET/DELETE), and the team reads a member's windows
        // (GET .../people/:membershipId/availability). Behind `work.read`, tenant-scoped; the write
        // surface is owner-scoped (the subject is the acting principal's membership), and the team
        // read resolves `:membershipId` tenant-scoped before any read. New table member_availability.
        MemberAvailabilityModule.register(),
        // People / module 14 (x325). Person time-off: a manager files dated absences against a person
        // (POST/DELETE behind `org.manage`) and anyone internal reads a person's entries with an
        // optional ?from&to overlap window (GET behind `work.read`). Resolves `:userId` to a
        // membership of this tenant before authorize (cross-tenant 404). New table person_time_off.
        PersonTimeOffModule.register(),
        // People / module 14 (x193). Team capacity heatmap: a read-only org-level roll-up that folds
        // the x170 capacity and x171 allocation facts into a member × week utilisation grid. Behind
        // `work.read`, tenant-scoped, with the window bounded before any read; adds no table.
        CapacityHeatmapModule.register(),
        // PROJ / module 8 (x207). An objective's key results (create/list/update). After
        // `ProjectObjectivesModule`: a key result names an objective, and the composite foreign key
        // means a caller who names one that is not theirs gets a refusal rather than a foreign-key 500.
        // It reuses `ProjectObjectivesRepository` to resolve the objective (and its project for the
        // relation gate) before any write.
        KeyResultsModule.register(),
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
        // SRCH saved/recent searches (x214). A member's own named saved searches (create/list/delete)
        // and their recent queries (read), private per user, behind the reused `search.use`. A
        // separate module from `SearchModule` so the search slices stay file-disjoint.
        SavedSearchesModule.register(),
        // SRCH saved-search sharing (x272). Share one of your own saved searches with the studio,
        // unshare it, and list what the studio has shared — behind the reused `search.use`. A
        // separate module from `SavedSearchesModule` so the sharing half never edits x214's files.
        SavedSearchSharesModule.register(),
        // Search recent history (x288). A member's own recently-run queries — record/list/clear,
        // private per membership, behind the reused `search.use`. A separate module from
        // `SearchModule` and `SavedSearchesModule` so the search slices stay file-disjoint.
        SearchHistoryModule.register(),
        // SRCH quick-access pins (x290). A member's own pinned entities (pin/list/unpin) for quick
        // access, private per member, behind the reused `search.use`. A separate module from
        // `SearchModule`/`SavedSearchesModule` so the search slices stay file-disjoint.
        SearchPinsModule.register(),
        // SRCH saved scopes (x334). A member's own named search filter scopes (create/list/replace/
        // delete), private per member, behind the reused `search.use`. A scope is a label plus a
        // filter set that pre-filters a search; applying one returns its filters to the search read.
        // A separate module from `SavedSearchesModule` so the search slices stay file-disjoint.
        SearchScopesModule.register(),
        // SRCH command palette (x181). The palette's contents — `GET …/search/commands?q=`, a
        // bounded, relevance-ordered list drawn from a static command registry by a pure matcher.
        // A module of its own beside `SearchModule` so the search slices stay file-disjoint; it
        // depends on nothing (the registry is a constant, the matcher is pure), and shares the
        // `search.use` gate global search reads under — no new capability, no database, no migration.
        CommandsModule.register(),
        // AI copilot shell (Module 16). `POST …/copilot/ask` returns an answer view (answer,
        // evidence, permission boundary, next safe action) from a provider-agnostic seam whose only
        // provider today is a deterministic offline stub — no network, no key. Gated by the new
        // `copilot` per-org feature flag (off → 404) and the reused `search.use` capability. A module
        // of its own beside `SearchModule` so the search slices stay file-disjoint.
        CopilotModule.register(),
        // SRCH typeahead / suggestions (x289). `GET …/search/suggest?q=<prefix>&limit=` — a bounded,
        // recency-ordered list of indexed entity titles predicted from the prefix, powering typeahead.
        // A module of its own beside `SearchModule` so the search slices stay file-disjoint; read-only
        // over `search_index` (0054), behind the reused `search.use`, every candidate relation-gated
        // with `work.read` so a suggestion never surfaces a title the caller's own read would deny.
        // No new capability, no table, no migration.
        SuggestionsModule.register(),
        // INS-06. The org-wide adoption roll-up (active members, members who created work, meetings
        // held) in a clamped window. A separate module from `InsightsModule` so the insights slices
        // stay file-disjoint; read-only, behind the same reused `work.read`.
        InsightsAdoptionModule.register(),
        // x134. After `InsightsModule` by subject: the forward-looking workload forecast, a second
        // read on the insights base path. Read-only over `work_items`, behind `work.read`; it
        // constructs its own repository handle (see its doc), so its position here is by subject.
        WorkloadForecastModule.register(),
        // x210. The write half of module 15: a member's own named, saved insights views
        // (create/list/delete). A separate module from `InsightsModule` so the insights slices stay
        // file-disjoint; behind the same reused `work.read`, owner- and tenant-scoped.
        SavedInsightViewsModule.register(),
        // x211. Insight snapshots — capture a point-in-time org-level metric roll-up and list the
        // stored history to compare over time (audit: insights are live-only). A separate module from
        // `InsightsModule` so the insights slices stay file-disjoint; behind the reused `work.read`,
        // it reuses `InsightsService` to compute what it stores in the tenant-scoped `insight_snapshots`.
        InsightSnapshotsModule.register(),
        // x228. The recurring half of module 15: a member's own scheduled insights-report definitions
        // (create/list/delete). A separate module from `InsightsModule` so the insights slices stay
        // file-disjoint; behind the reused `work.read`. Definition and next-run compute only — no
        // dispatcher and no egress in this slice.
        InsightReportSchedulesModule.register(),
        // x229. Insight period-over-period comparison — a live two-window compute over the insights
        // source data (audit: insights are single-period, no comparison). A separate module from
        // `InsightsModule` so the insights slices stay file-disjoint; behind the reused `work.read`,
        // it owns no table (distinct from x211's stored snapshots) and counts each metric over a
        // caller-bound window, never the DB clock.
        InsightComparisonModule.register(),
        // x230. Insight metric targets — set an org-wide goal line per metric (`org.manage`) and read
        // each live figure against it on-track/behind (`work.read`). A separate module from
        // `InsightsModule` so the insights slices stay file-disjoint; it reuses `InsightsService` to
        // compute the live figures it judges and writes to the tenant-scoped `insight_targets`.
        InsightTargetsModule.register(),
        // x271. Insight annotations — attach an explanatory note to a snapshot so a frozen figure
        // carries context (INS-01 "every score is explainable"). A separate module from
        // `InsightSnapshotsModule` so the insights slices stay file-disjoint; behind the reused
        // `work.read`, it soft-reads x211's `insight_snapshots` (resolve tenant-scoped before authorize
        // → 404 on an unknown snapshot) and owns its own tenant-scoped `insight_annotations` table.
        InsightAnnotationsModule.register(),
        // x302. Per-user insight dashboard layout — a member arranges which insights metric tiles are
        // shown and in what order, read back as their own. A separate module from `InsightsModule` so
        // the insights slices stay file-disjoint; behind the reused `work.read`, self-scoped by the
        // caller's membership in the tenant-scoped `insight_dashboard_layouts`.
        InsightDashboardLayoutModule.register(),
        // x319. Insight metric alerts — a member's own threshold alert per metric (set/list/delete over
        // `/insights/metric-alerts`, `work.read` + self scope). A separate module from `InsightsModule`
        // so the insights slices stay file-disjoint; the read marks each alert breached/ok against the
        // latest workload snapshot (0090, read-only) and writes to the tenant-scoped
        // `insight_metric_alerts`. Config + read-side evaluation only — no dispatch this slice.
        InsightMetricAlertsModule.register(),
        // x320. Insight custom reports — a member composes an arbitrary ordered selection of existing
        // metric keys into a named report and reads it back rendered against current metrics
        // (`work.read`, self-scoped). A separate module from `InsightsModule` so the insights slices
        // stay file-disjoint; it reuses `InsightsService` to render and writes to the tenant-scoped
        // `insight_custom_reports`.
        InsightCustomReportsModule.register(),
        // Public & trust site (module 1, x156). The unauthenticated marketing home — a single
        // `@Public()` read serving deterministic, code-defined content. Depends on nothing (no
        // database, no tenant, no mailer), so its position here is free; registered last, beside
        // the other feature modules, for discoverability only.
        // FEAT · module 1 Public site (x157). The public pricing endpoint — `@Public()`, so it sits
        // outside the whole guard pipeline. It depends on nothing (a static catalog), so its position
        // here is by subject alone; it adds no table and no shared capability.
        // Public & trust site (x159). Also serves `GET /v1/public/site/status`, `@Public()`, over the
        // GLOBAL `incidents` table (0060) — resolves no tenant and asks for no capability; folded into
        // the same PublicSiteModule.
        // x188. Also serves `GET /v1/public/site/legal/:doc` (terms/privacy), `@Public()`, deterministic
        // code-defined copy from the same PublicContentService — no table, no tenant, no capability;
        // `:doc` is a two-value allowlist so an arbitrary segment is a 404.
        PublicSiteModule.register(),
        // x187. Module 1, the public resources/guides surface — `GET /v1/public/site/resources` and
        // `…/resources/:slug`, both `@Public()`: no session, no tenant, no capability. Deterministic,
        // code-defined content reused from the public-content service; no table, no shared capability,
        // so its position here is free.
        PublicResourcesModule.register(),
        // x158. Module 1, the public security-and-trust page. Public and tenant-less: it reads no
        // organization and requires no capability, and serves deterministic code-defined copy.
        TrustContentModule.register(),
        // x160. The public product changelog — `GET /v1/public/site/changelog`, `@Public()`: no
        // session, no tenant, no capability. It reads the GLOBAL `changelog_entries` (0061) on the
        // identity path, so it depends only on the (global) tenant database and couples to nothing.
        PublicChangelogModule.register(),
        // x161. The public site's contact / lead intake — `POST /public/site/contact`. `@Public()`:
        // the module's only unauthenticated write, establishing no authority and exercising none, so
        // it carries no session, CSRF, tenant or capability. It depends only on `TENANT_DATABASE`
        // (the repository writes on the identity/no-tenant path over the global `marketing_leads`),
        // so it couples to no feature module; position here is by subject (public surface, last).
        ContactModule.register({
          ...(options.config.contactWindowMs === undefined
            ? {}
            : { windowMs: options.config.contactWindowMs }),
          ...(options.config.contactMaxPerWindow === undefined
            ? {}
            : { max: options.config.contactMaxPerWindow }),
        }),
        // First-owner setup (`GET/POST /public/setup`) for a fresh production install, which has no
        // public sign-up. Registered ONLY when `SETUP_TOKEN` is set, so with no token the routes do
        // not exist and return the router's ordinary 404 (same reasoning as
        // `IdentityModule.registerWithDevelopmentSignIn`); the controller additionally 404s once any
        // organization exists. Depends only on the global `TENANT_DATABASE` / `AUDIT_SERVICE` /
        // `API_CONFIG`, so it couples to no feature module.
        ...(options.config.setupToken ? [FirstOwnerModule.register()] : []),
        // Public self-service sign-up (`GET/POST /v1/public/sign-up`). Registered only while
        // `PUBLIC_SIGNUP` is on (the default); off means the routes do not exist and 404.
        ...publicSignupModules(options.config),
        // "Continue with Google" (`/v1/auth/google/*`). Registered only when GOOGLE_CLIENT_ID and
        // GOOGLE_CLIENT_SECRET are both set; otherwise the routes 404 and the web hides the button.
        ...googleAuthModules(options.config),
        // AUTO-01 / module 17 (x162). Org-scoped automation workflow templates (define/list), behind
        // `org.manage`. Depends only on the global tenant database — an org-admin definition with no
        // project to resolve — so its position here is by subject, not by need. Execution/runs are x163.
        AutomationsModule.register(),
        // x165. Automations app directory: the static integration catalog merged with the org's
        // recorded connections, and a create that records a non-secret connection against a catalog
        // app. Behind `org.manage`; a self-contained module so the Automations slices stay
        // file-disjoint. No secrets are stored (secret exchange is Needs-Peter).
        IntegrationDirectoryModule.register(),
        // x220. Automations connection health: a read-only, in-app validity verdict over the org's
        // recorded connections (catalog app still known, required non-secret config keys present,
        // connection live rather than pending) plus a roll-up. Behind `org.manage`; no new table and
        // no outbound network call — a live third-party probe is external and paid (Needs-Peter).
        ConnectionHealthModule.register(),
        // Automations module 17 (x166). Outbound webhook endpoints (register/list/disable) behind
        // `org.manage`, over the new `webhook_endpoints` table. Self-contained and file-disjoint;
        // delivery/dispatch to third parties is a later slice (external egress, Needs-Peter).
        WebhooksModule.register(),
        // Automations module 17 (x221). Webhook delivery log: a read/history route
        // (`GET …/automations/webhooks/:endpointId/deliveries`) over the new `webhook_deliveries`
        // table, behind `org.manage`, plus a guarded internal record helper for the (later) dispatch
        // path. Self-contained and file-disjoint; no external egress in this slice.
        WebhookDeliveriesModule.register(),
        // Platform states (x185). The platform maintenance / degraded-mode window: a `@Public()`
        // read (`GET /public/site/maintenance`) over the GLOBAL `maintenance_windows` table (0080),
        // and an `org.manage` write (`POST …/admin/maintenance`) that persists globally. Its
        // position here is by subject, at the end of the feature modules.
        MaintenanceModule.register(),
        // x186. Module 1, the public FAQ page — `GET /v1/public/site/faq`, `@Public()`: no session,
        // no tenant, no capability. Deterministic code-defined grouped Q&A copy; depends on nothing
        // (no database, no mailer), so its position here is free.
        FaqContentModule.register(),
        // x172. People module 14: a member's declared skills / tags, mounted under
        // `…/people/:membershipId/skills`. Write behind `project.manage`, read behind `work.read`;
        // it constructs its own repository handle. Position by subject, beside the other People work.
        PeopleSkillsModule.register(),
        // x194. People module 14: the skill directory search — find members by one or more skill
        // tags (+ optional minimum level), mounted at `…/people/skills/search`. Read-only behind the
        // reused `work.read`; it constructs its own repository handle. A distinct literal path from
        // x172's `…/people/:membershipId/skills`, so no route collision. Position by subject.
        SkillSearchModule.register(),
        // Billing / module 19 (x177/x180/x198). The organization's subscription (view / request a plan
        // change) and plan-change preview, plus the org-scoped billing profile (read/update the billing
        // contact, tax id and address) — all behind `org.manage`, the same owners-only population the
        // storage/usage read sits behind. One module depending only on the tenant database; it records a
        // plan-change intent (`pending_change`) and stores non-secret metadata only — no charge and no
        // payment instruments (real payment is Needs-Peter; instruments are the provider's).
        BillingModule.register(),
        // Billing / module 19 (x199). The org's nominated billing/notification contacts (add/list/
        // remove) behind `org.manage`. File-disjoint from the billing profile; depends only on the
        // tenant database, so its position here is by subject. No email is sent and no payment
        // instrument is stored — contacts only.
        BillingContactsModule.register(),
        // Billing & entitlements module 19 (x200). Configurable usage-alert threshold rules
        // (create/list/update) and a read that flags which are currently breached, behind `org.manage`,
        // over the new `billing_usage_alerts` table (0083). Self-contained and file-disjoint; alert
        // delivery (email/notification) is a later slice (external egress, Needs-Peter).
        BillingUsageAlertsModule.register(),
        // Billing & entitlements module 19 (x281). Named cost centers a billing admin defines and the
        // projects assigned to them (create/list/delete a definition, assign/unassign a project),
        // behind `org.manage`, over the new `billing_cost_centers` table (0150). Definitions and
        // assignments only — nothing here stores an amount or charges. Self-contained and file-disjoint.
        BillingCostCentersModule.register(),
        // Billing & entitlements module 19 (x282). Purchase-order references (record/list/close/remove)
        // behind `org.manage`, over the new `billing_purchase_orders` table (0151). Self-contained and
        // file-disjoint; record only — nothing here charges, transfers, or stores a payment instrument.
        BillingPurchaseOrdersModule.register(),
        // Billing & entitlements module 19 (x331). The read-only spend-by-cost-centre report: for each
        // cost centre (x281) the count of assigned projects and their summed budget (x293), behind
        // `org.manage`. Pure aggregate read over the two existing tables — no new table, no write.
        CostCenterReportModule.register(),
        // x169. People & capacity module 14: one member's profile (role, projects, open-work count),
        // the per-member detail behind x168's directory. A separate module so the people slices stay
        // file-disjoint; read-only over existing rows, behind the same reused `work.read`.
        PersonProfileModule.register(),
        // x262. People module 14: named teams and their members — define a team (`org.manage`),
        // assign/unassign members (`org.manage`), and read the team list / a team's detail
        // (`work.read`). One `member_teams` table (the x233 labels one-table pattern). A separate
        // module so the people slices stay file-disjoint.
        PeopleTeamsModule.register(),
        // Billing module 19 (x178). Seat management (assign/list/reclaim) behind `org.manage`. A
        // self-contained module — no billing API module existed at this base — that depends only on
        // the tenant database: it resolves the target membership/seat tenant-scoped to answer 404
        // rather than a foreign-key 500, so it couples to no other module and its position is by
        // subject.
        BillingSeatsModule.register(),
        // FEAT: Billing invoice history (x179). Read-only invoice list + by-id detail behind
        // `org.manage`. A module of its own so it stays file-disjoint from the sibling billing
        // slices; the detail resolves the id tenant-scoped before authorizing, so a cross-tenant id
        // is a 404.
        InvoicesModule.register(),
        // x216: the tenant-local member profile edit (member_profiles, 0094) behind `org.manage`.
        // File-disjoint from x169's read-only profile; writes only member_profiles, never the
        // GLOBAL users.display_name (the leak that blocked x192).
        MemberProfileModule.register(),
        // People & capacity module 14 (x326). A person's dated credentials/qualifications: record,
        // list (with an expired badge computed read-side), and idempotent delete, under
        // `…/people/:userId/certifications` behind org.manage (write) / work.read (read).
        PersonCertificationsModule.register(),
        InvoiceLineItemsModule.register(),
        // Billing & entitlements module 19 (x226). A manual credit / adjustment ledger (post/list with a
        // running balance) behind `org.manage`, over the new `billing_credits` table (0100). Append-only
        // and self-contained; no money moves and no gateway is called — real settlement is Needs-Peter.
        BillingCreditsModule.register(),
        // Billing & plan management module 19 (x330). An org discount / adjustment register (record/
        // list/remove) behind `org.manage`, over the new `billing_discounts` table (0197). Records only:
        // each read marks active or expired against the process clock; no money moves and no gateway is
        // called — applying a discount to a real charge is Needs-Peter / Stripe.
        BillingDiscountsModule.register(),
        // Billing & entitlements module 19 (x227). A date-windowed CSV export of the org's usage
        // counters behind `org.manage`: window-validated (400 on bad/oversized range), tenant-scoped,
        // row-capped (413), and formula-injection-guarded through the shared `toCsv`. File-disjoint
        // from the usage-alerts slice; reads `usage_counters` and adds no table.
        BillingUsageExportModule.register(),
        // 0202. Personal access tokens — the Preferences → Security screen's backend: a member
        // lists, creates (plaintext shown once) and revokes their own API tokens for the MCP
        // server, behind `work.read`, scoped to their own membership. The Bearer authentication
        // path is wired separately in `IdentityModule` + `SessionAuthGuard`. Self-contained and
        // file-disjoint.
        PersonalAccessTokensModule.register(),
        // Hosted MCP endpoint (`POST /mcp`): the `@tmanage/mcp-server` tools over Streamable HTTP,
        // signed in with a personal access token. Every tool call is an in-process request
        // through this same guard chain, so it is tenant- and permission-scoped like REST.
        McpEndpointModule.register(),
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
