/**
 * Dependency-injection tokens.
 *
 * Every provider in this application is registered under an explicit token and every injected
 * constructor parameter carries `@Inject(TOKEN)`. That is not a style preference — see
 * ADR-0003. vitest transforms TypeScript with esbuild, which does not implement
 * `emitDecoratorMetadata`, so DI that relied on `design:paramtypes` would resolve `undefined`
 * for every parameter in the one suite that exists to prove the request pipeline works.
 *
 * `Symbol.for` rather than `Symbol`: the database suite and the application can end up holding
 * two instances of this module under vitest's transform pipeline, and two distinct `Symbol()`
 * values would then look like two different providers with the same description — a
 * "Nest can't resolve dependencies" failure with no visible cause. The global registry makes
 * the token identity survive that.
 */

export const TENANT_DATABASE = Symbol.for('tmanage.TenantDatabase');
export const API_CONFIG = Symbol.for('tmanage.ApiConfig');
export const SESSION_SERVICE = Symbol.for('tmanage.SessionService');
export const AUTHENTICATION_SERVICE = Symbol.for('tmanage.AuthenticationService');
export const MEMBERSHIP_RESOLVER = Symbol.for('tmanage.MembershipResolver');
/**
 * The seam the HTTP guards record a refused attempt through — status defect 4. Bound to
 * `DatabaseAuthenticationEventRecorder` by `IdentityModule`, which already holds the recorder's
 * dependencies; injected by `SessionAuthGuard` and `CsrfGuard`.
 */
export const AUTHENTICATION_EVENT_RECORDER = Symbol.for('tmanage.AuthenticationEventRecorder');
export const PRINCIPAL_REPOSITORY = Symbol.for('tmanage.PrincipalRepository');
export const PROVISIONING_SERVICE = Symbol.for('tmanage.ProvisioningService');
export const WORKSPACES_REPOSITORY = Symbol.for('tmanage.WorkspacesRepository');
export const MEMBERSHIPS_REPOSITORY = Symbol.for('tmanage.MembershipsRepository');
export const ORGANIZATION_DIRECTORY_REPOSITORY = Symbol.for(
  'tmanage.OrganizationDirectoryRepository',
);
export const PROJECTS_REPOSITORY = Symbol.for('tmanage.ProjectsRepository');
export const CLIENT_ORGANIZATIONS_REPOSITORY = Symbol.for('tmanage.ClientOrganizationsRepository');
export const CLIENT_MEMBERSHIPS_REPOSITORY = Symbol.for('tmanage.ClientMembershipsRepository');
export const PROJECT_CLIENTS_REPOSITORY = Symbol.for('tmanage.ProjectClientsRepository');
export const CLIENTS_SERVICE = Symbol.for('tmanage.ClientsService');
export const PORTAL_SERVICE = Symbol.for('tmanage.PortalService');
export const PROJECT_MILESTONES_SERVICE = Symbol.for('tmanage.ProjectMilestonesService');
export const PROJECT_RISKS_SERVICE = Symbol.for('tmanage.ProjectRisksService');
export const INVITATIONS_REPOSITORY = Symbol.for('tmanage.InvitationsRepository');
export const INVITATIONS_SERVICE = Symbol.for('tmanage.InvitationsService');
/** ADM-12/13 (x121). Member offboarding — the access-impact preview and the offboard execution. */
export const OFFBOARDING_SERVICE = Symbol.for('tmanage.OffboardingService');
export const PROJECTS_SERVICE = Symbol.for('tmanage.ProjectsService');
export const AUDIT_EVENTS_REPOSITORY = Symbol.for('tmanage.AuditEventsRepository');
export const AUDIT_SERVICE = Symbol.for('tmanage.AuditService');
export const PROJECT_MEMBERSHIPS_REPOSITORY = Symbol.for('tmanage.ProjectMembershipsRepository');
export const PROJECT_MEMBERSHIPS_SERVICE = Symbol.for('tmanage.ProjectMembershipsService');
export const WORK_ITEMS_REPOSITORY = Symbol.for('tmanage.WorkItemsRepository');
export const WORK_ITEMS_SERVICE = Symbol.for('tmanage.WorkItemsService');
export const WORK_CHECKLIST_SERVICE = Symbol.for('tmanage.WorkChecklistService');
/** WORK intake forms (x146). The org-scoped work-form definition repository. */
export const WORK_FORMS_REPOSITORY = Symbol.for('tmanage.WorkFormsRepository');
/** x147. A work item's comments / activity, behind `work.read`/`work.update`. */
export const WORK_COMMENTS_SERVICE = Symbol.for('tmanage.WorkCommentsService');
/** x206. Bulk status transition over the single-item path, behind `work.transition`. */
export const BULK_TRANSITION_SERVICE = Symbol.for('tmanage.BulkTransitionService');
export const WORKFLOW_TEMPLATES_REPOSITORY = Symbol.for('tmanage.WorkflowTemplatesRepository');
export const WORKFLOW_RUNS_REPOSITORY = Symbol.for('tmanage.WorkflowRunsRepository');
export const WORKFLOW_RUN_SERVICE = Symbol.for('tmanage.WorkflowRunService');
export const HOME_SERVICE = Symbol.for('tmanage.HomeService');
export const WORK_VIEWS_SERVICE = Symbol.for('tmanage.WorkViewsService');
/** CAL-01 / MTG-01 (x90). The calendar module's meeting read/write. */
export const MEETINGS_REPOSITORY = Symbol.for('tmanage.MeetingsRepository');
export const MEETINGS_SERVICE = Symbol.for('tmanage.MeetingsService');
/** CAL-01 / MTG-01 attendees + RSVP (x126). The calendar module's attendee read/write. */
export const MEETING_ATTENDEES_REPOSITORY = Symbol.for('tmanage.MeetingAttendeesRepository');
export const MEETING_ATTENDEES_SERVICE = Symbol.for('tmanage.MeetingAttendeesService');
export const MEETING_SERIES_REPOSITORY = Symbol.for('tmanage.MeetingSeriesRepository');
export const MEETING_SERIES_SERVICE = Symbol.for('tmanage.MeetingSeriesService');
/** DOC-01 (x91). The docs module's document read/write. */
export const DOCUMENTS_REPOSITORY = Symbol.for('tmanage.DocumentsRepository');
export const DOCUMENTS_SERVICE = Symbol.for('tmanage.DocumentsService');
/** Docs "collaboration later" (x132). The docs module's document-comments read/add. */
export const DOCUMENT_COMMENTS_SERVICE = Symbol.for('tmanage.DocumentCommentsService');
/** DEC-01 (x113). The decisions module's decision register author/list. */
export const DECISIONS_REPOSITORY = Symbol.for('tmanage.DecisionsRepository');
export const DECISIONS_SERVICE = Symbol.for('tmanage.DecisionsService');
/** DEC / module 12 (x149). The decision→work-item linkage (link/list/unlink). */
export const DECISION_WORK_LINKS_REPOSITORY = Symbol.for('tmanage.DecisionWorkLinksRepository');
export const DECISION_WORK_LINKS_SERVICE = Symbol.for('tmanage.DecisionWorkLinksService');
/** PROJ / module 8 (x124). A project's objectives — create/list/transition. */
export const PROJECT_OBJECTIVES_REPOSITORY = Symbol.for('tmanage.ProjectObjectivesRepository');
export const PROJECT_OBJECTIVES_SERVICE = Symbol.for('tmanage.ProjectObjectivesService');
/** PROJ / module 8 (x136). An organization's objectives / OKRs — create/list/transition. */
export const ORG_OBJECTIVES_REPOSITORY = Symbol.for('tmanage.OrgObjectivesRepository');
export const ORG_OBJECTIVES_SERVICE = Symbol.for('tmanage.OrgObjectivesService');
/** PROJ / module 8 (x137). The read-only portfolio roll-up across the caller's visible projects. */
export const PROJECT_PORTFOLIO_REPOSITORY = Symbol.for('tmanage.ProjectPortfolioRepository');
export const PROJECT_PORTFOLIO_SERVICE = Symbol.for('tmanage.ProjectPortfolioService');
export const OBJECTIVE_WORK_LINKS_REPOSITORY = Symbol.for('tmanage.ObjectiveWorkLinksRepository');
export const OBJECTIVE_WORK_LINKS_SERVICE = Symbol.for('tmanage.ObjectiveWorkLinksService');
export const CLIENT_REQUESTS_REPOSITORY = Symbol.for('tmanage.ClientRequestsRepository');
export const CLIENT_REQUESTS_SERVICE = Symbol.for('tmanage.ClientRequestsService');
/** FR-05 (x92). The approvals aggregate — deliverable versions and the decide path. */
export const APPROVALS_SERVICE = Symbol.for('tmanage.ApprovalsService');
export const CONVERSATIONS_REPOSITORY = Symbol.for('tmanage.ConversationsRepository');
export const CONVERSATIONS_SERVICE = Symbol.for('tmanage.ConversationsService');
export const OUTBOX_EVENTS_REPOSITORY = Symbol.for('tmanage.OutboxEventsRepository');
export const NOTIFICATIONS_REPOSITORY = Symbol.for('tmanage.NotificationsRepository');
export const NOTIFICATION_PREFERENCES_REPOSITORY = Symbol.for(
  'tmanage.NotificationPreferencesRepository',
);
export const NOTIFICATION_PREFERENCES_SERVICE = Symbol.for(
  'tmanage.NotificationPreferencesService',
);
export const INBOX_SERVICE = Symbol.for('tmanage.InboxService');
export const PORTAL_INBOX_SERVICE = Symbol.for('tmanage.PortalInboxService');
export const MAILER = Symbol.for('tmanage.Mailer');
export const INVITATION_MAILER = Symbol.for('tmanage.InvitationMailer');
export const OBJECT_STORE = Symbol.for('tmanage.ObjectStore');
/**
 * FILE-001b. The half of the filesystem driver the public PUT route talks to. Provided by
 * `StorageModule.forConfig` alone — a suite holding a fake, or a deployment with no
 * driver, leaves it unbound and the route answers 404 to everything, which is honest.
 */
export const LOCAL_PART_SINK = Symbol.for('tmanage.LocalPartSink');
export const UPLOAD_SESSIONS_REPOSITORY = Symbol.for('tmanage.UploadSessionsRepository');
export const FILE_ASSETS_REPOSITORY = Symbol.for('tmanage.FileAssetsRepository');
export const USAGE_COUNTERS_REPOSITORY = Symbol.for('tmanage.UsageCountersRepository');
/** USAGE-001 slice 2. The append-only ledger writer. */
export const USAGE_LEDGER_REPOSITORY = Symbol.for('tmanage.UsageLedgerRepository');
export const FILES_SERVICE = Symbol.for('tmanage.FilesService');
/** USAGE-001 slice 5. The read side of the quota counter — the billing screen's `used/reserved/quota`. */
export const USAGE_SERVICE = Symbol.for('tmanage.UsageService');
/** USAGE-001. The expiry sweeper — resolved by `sweep.ts`, never by a controller. */
export const UPLOAD_SESSION_SWEEPER = Symbol.for('tmanage.UploadSessionSweeper');
/** USAGE-001 slice 3. The counter reconciler — resolved by `reconcile.ts`, never by a controller. */
export const USAGE_RECONCILER = Symbol.for('tmanage.UsageReconciler');
/** FILE-003. The quarantine/rejected retention job — resolved by `cleanup.ts`, never by a controller. */
export const QUARANTINE_CLEANUP_JOB = Symbol.for('tmanage.QuarantineCleanupJob');
/** FILE-002. The verification pass — resolved by `verify.ts`, never by a controller. */
export const FILE_VERIFIER = Symbol.for('tmanage.FileVerifier');
/** FILE-002 slice B. The scan pass — resolved by `verify.ts` after the verifier, on the same tick. */
export const FILE_SCANNER = Symbol.for('tmanage.FileScanner');
export const FILE_DOWNLOAD_SERVICE = Symbol.for('tmanage.FileDownloadService');
/** FILE-003 · WEB-006. The client portal's file-list read (`GET /portal/projects/:projectId/files`). */
export const PORTAL_FILE_LIST_SERVICE = Symbol.for('tmanage.PortalFileListService');
/** FILE-002 slice B. The malware scanner port, provided by `ScannerModule`. */
export const MALWARE_SCANNER = Symbol.for('tmanage.MalwareScanner');
/** ON-09. The onboarding-import validate/dry-run service. */
export const IMPORT_SERVICE = Symbol.for('tmanage.ImportService');
/** ON-09. The `import_jobs` repository — the durable anchor for a validation attempt. */
export const IMPORT_JOBS_REPOSITORY = Symbol.for('tmanage.ImportJobsRepository');
/** INS-01. The insights read service — a read-only reporting surface over the `work` data. */
export const INSIGHTS_SERVICE = Symbol.for('tmanage.InsightsService');
/** SRCH-01 (x111). Global tenant-scoped search over work items, documents and meetings. */
export const SEARCH_REPOSITORY = Symbol.for('tmanage.SearchRepository');
export const SEARCH_SERVICE = Symbol.for('tmanage.SearchService');

/** Public & trust site (x159). The public status page's published-only incidents read. */
export const PUBLIC_SITE_STATUS_REPOSITORY = Symbol.for('tmanage.PublicSiteStatusRepository');
/** x161. The public site's contact / lead intake — the INSERT-only writer over `marketing_leads`. */
export const MARKETING_LEADS_REPOSITORY = Symbol.for('tmanage.MarketingLeadsRepository');
