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
/** SEC / Portal milestone lifecycle (x202) — edit and complete an existing milestone. */
export const MILESTONE_LIFECYCLE_SERVICE = Symbol.for('tmanage.MilestoneLifecycleService');
export const PROJECT_RISKS_SERVICE = Symbol.for('tmanage.ProjectRisksService');
/** SEC / Client portal access log (x237) — record client access + the internal audit read. */
export const PORTAL_ACCESS_LOG_SERVICE = Symbol.for('tmanage.PortalAccessLogService');
/** SEC / Portal update comments (x203). Internal post + read and the client projection. */
export const UPDATE_COMMENTS_SERVICE = Symbol.for('tmanage.UpdateCommentsService');
/** POR client portal (x304). Portal announcement banners: internal create/delete + client read. */
export const PORTAL_ANNOUNCEMENTS_SERVICE = Symbol.for('tmanage.PortalAnnouncementsService');
/** SEC / Client portal messages (x322). Client post + own-thread read and the staff inbound read. */
export const CLIENT_MESSAGES_SERVICE = Symbol.for('tmanage.ClientMessagesService');
/** FEAT: Billing invoices (x179). The invoice-history read surface and its repository. */
export const INVOICES_REPOSITORY = Symbol.for('tmanage.InvoicesRepository');
export const INVOICES_SERVICE = Symbol.for('tmanage.InvoicesService');
/** FEAT: Billing invoice line items (x225). The per-invoice line read surface and its repository. */
export const INVOICE_LINE_ITEMS_REPOSITORY = Symbol.for('tmanage.InvoiceLineItemsRepository');
export const INVOICE_LINE_ITEMS_SERVICE = Symbol.for('tmanage.InvoiceLineItemsService');
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
/** x307. A work item's ordered subtasks / breakdown, behind `work.read`/`work.update`. */
export const WORK_SUBTASKS_SERVICE = Symbol.for('tmanage.WorkSubtasksService');
/** WORK intake forms (x146). The org-scoped work-form definition repository. */
export const WORK_FORMS_REPOSITORY = Symbol.for('tmanage.WorkFormsRepository');
/** x147. A work item's comments / activity, behind `work.read`/`work.update`. */
export const WORK_COMMENTS_SERVICE = Symbol.for('tmanage.WorkCommentsService');
/** x299. A client request's internal comment thread, behind `client_request.triage`. */
export const REQUEST_COMMENTS_SERVICE = Symbol.for('tmanage.RequestCommentsService');
/** x204. Typed links between work items, behind `work.read`/`work.update`. */
export const WORK_ITEM_LINKS_SERVICE = Symbol.for('tmanage.WorkItemLinksService');
export const WORK_ITEM_FILES_SERVICE = Symbol.for('tmanage.WorkItemFilesService');
/** x206. Bulk status transition over the single-item path, behind `work.transition`. */
export const BULK_TRANSITION_SERVICE = Symbol.for('tmanage.BulkTransitionService');
/** x231. A work item's logged effort / time entries, behind `work.read`/`work.update`. */
export const WORK_TIME_LOGS_SERVICE = Symbol.for('tmanage.WorkTimeLogsService');
/** x258. A work item's effort estimate (plan vs actual), behind `work.read`/`work.update`. */
export const WORK_ITEM_ESTIMATE_SERVICE = Symbol.for('tmanage.WorkItemEstimateService');
export const WORK_WATCHERS_SERVICE = Symbol.for('tmanage.WorkWatchersService');
/** x256. A work item's personal reminders (set/clear own + own due list), behind `work.read`. */
export const WORK_ITEM_REMINDERS_SERVICE = Symbol.for('tmanage.WorkItemRemindersService');
export const WORK_LABELS_SERVICE = Symbol.for('tmanage.WorkLabelsService');
/**
 * x306. Org-defined work item custom fields — definitions behind `org.manage`, values behind
 * `work.update`/`work.read`.
 */
export const WORK_CUSTOM_FIELDS_SERVICE = Symbol.for('tmanage.WorkCustomFieldsService');
/** x257. A work item's recurrence rule + in-app next-occurrence, behind `work.read`/`work.update`. */
export const WORK_ITEM_RECURRENCE_SERVICE = Symbol.for('tmanage.WorkItemRecurrenceService');
/** x274. Read-only adjacency graph of a work item's typed links, behind `work.read`. */
export const WORK_RELATIONS_GRAPH_SERVICE = Symbol.for('tmanage.WorkRelationsGraphService');
/** Work item activity timeline (x291). Read-only merged feed of audit events + comments. */
export const WORK_ACTIVITY_LOG_SERVICE = Symbol.for('tmanage.WorkActivityLogService');
/** x308. An organization's custom work-board columns, behind `org.manage` (writes) / `work.read` (list). */
export const WORK_BOARD_COLUMNS_SERVICE = Symbol.for('tmanage.WorkBoardColumnsService');
export const WORKFLOW_TEMPLATES_REPOSITORY = Symbol.for('tmanage.WorkflowTemplatesRepository');
export const WORKFLOW_RUNS_REPOSITORY = Symbol.for('tmanage.WorkflowRunsRepository');
export const WORKFLOW_RUN_SERVICE = Symbol.for('tmanage.WorkflowRunService');
/** Automations run history (x164). The org-scoped, read-only run-history repository. */
export const WORKFLOW_RUN_HISTORY_REPOSITORY = Symbol.for('tmanage.WorkflowRunHistoryRepository');
/** A11Y-183 (x183, module 20). The member's-own accessibility-preferences repository. */
export const A11Y_PREFERENCES_REPOSITORY = Symbol.for('tmanage.A11yPreferencesRepository');
/** PREF-DISPLAY (x285, module 20). The member's-own display-preferences repository. */
export const DISPLAY_PREFERENCES_REPOSITORY = Symbol.for('tmanage.DisplayPreferencesRepository');
/** PREF-DISPLAY (x285, module 20). The member's-own display-preferences service. */
export const DISPLAY_PREFERENCES_SERVICE = Symbol.for('tmanage.DisplayPreferencesService');
/** Automation workflow conditions (x190). The org-scoped per-step condition repository. */
export const WORKFLOW_CONDITIONS_REPOSITORY = Symbol.for('tmanage.WorkflowConditionsRepository');
/** Automation variables (x305). The org-scoped non-secret variable repository. */
export const AUTOMATION_VARIABLES_REPOSITORY = Symbol.for('tmanage.AutomationVariablesRepository');
/** PEOPLE allocations (x171). The project-scoped person-allocation repository. */
export const PERSON_ALLOCATIONS_REPOSITORY = Symbol.for('tmanage.PersonAllocationsRepository');
/** People capacity (x170). The tenant-scoped per-member weekly-capacity repository. */
export const PERSON_CAPACITY_REPOSITORY = Symbol.for('tmanage.PersonCapacityRepository');
/** People reporting lines / org chart (x217). The tenant-scoped per-member manager repository. */
export const REPORTING_LINES_REPOSITORY = Symbol.for('tmanage.ReportingLinesRepository');
/** Member availability (x218). The tenant-scoped per-member out-of-office window repository. */
export const MEMBER_AVAILABILITY_REPOSITORY = Symbol.for('tmanage.MemberAvailabilityRepository');
/** Team capacity heatmap (x193). The org-level read service that folds capacity × allocations. */
export const CAPACITY_HEATMAP_SERVICE = Symbol.for('tmanage.CapacityHeatmapService');
export const PERSON_SKILLS_REPOSITORY = Symbol.for('tmanage.PersonSkillsRepository');
/** x194. The read-only skill directory search repository (find members by skill tag). */
export const PERSON_SKILL_SEARCH_REPOSITORY = Symbol.for('tmanage.PersonSkillSearchRepository');
/** Billing profile (module 19, x180). The org-scoped read/upsert billing-profile repository. */
export const BILLING_PROFILE_REPOSITORY = Symbol.for('tmanage.BillingProfileRepository');
/** Billing tax / legal-entity details (module 19, x283). The org-scoped read/upsert repository. */
export const BILLING_TAX_DETAILS_REPOSITORY = Symbol.for('tmanage.BillingTaxDetailsRepository');
/** Billing tax / legal-entity details (module 19, x283). The authorize + validate + upsert service. */
export const BILLING_TAX_DETAILS_SERVICE = Symbol.for('tmanage.BillingTaxDetailsService');
/** PREF-QUIET (x215, module 20). The member's-own notification quiet-hours store. */
export const QUIET_HOURS_REPOSITORY = Symbol.for('tmanage.QuietHoursRepository');
/** PREF-DIGEST (x245, module 20). The member's-own notification digest-cadence store. */
export const DIGEST_PREF_REPOSITORY = Symbol.for('tmanage.DigestPreferenceRepository');
/** PREF-STARTUP (x287, module 20). The member's-own default startup landing view store. */
export const STARTUP_PREFS_REPOSITORY = Symbol.for('tmanage.StartupPrefsRepository');
export const HOME_SERVICE = Symbol.for('tmanage.HomeService');
/** Home widget preferences (x243, module 4). The member's-own Home widget layout read/write repository. */
export const HOME_WIDGET_PREFS_REPOSITORY = Symbol.for('tmanage.HomeWidgetPrefsRepository');
/** Home quick links (x273, module 4). The member's-own My Day quick-links store. */
export const HOME_QUICK_LINKS_REPOSITORY = Symbol.for('tmanage.HomeQuickLinksRepository');
/** Home quick links (x273, module 4). The member's-own My Day quick-links service. */
export const HOME_QUICK_LINKS_SERVICE = Symbol.for('tmanage.HomeQuickLinksService');
/** PRF keyboard shortcuts (x286, module 20). The member's-own keyboard-shortcut override store. */
export const SHORTCUT_PREFS_REPOSITORY = Symbol.for('tmanage.ShortcutPrefsRepository');
export const WORK_VIEWS_SERVICE = Symbol.for('tmanage.WorkViewsService');
/** CAL-01 / MTG-01 (x90). The calendar module's meeting read/write. */
export const MEETINGS_REPOSITORY = Symbol.for('tmanage.MeetingsRepository');
export const MEETINGS_SERVICE = Symbol.for('tmanage.MeetingsService');
/** CAL-01 / MTG-01 attendees + RSVP (x126). The calendar module's attendee read/write. */
export const MEETING_ATTENDEES_REPOSITORY = Symbol.for('tmanage.MeetingAttendeesRepository');
export const MEETING_ATTENDEES_SERVICE = Symbol.for('tmanage.MeetingAttendeesService');
export const MEETING_SERIES_REPOSITORY = Symbol.for('tmanage.MeetingSeriesRepository');
export const MEETING_SERIES_SERVICE = Symbol.for('tmanage.MeetingSeriesService');
export const MEETING_OCCURRENCE_OVERRIDE_SERVICE = Symbol.for(
  'tmanage.MeetingOccurrenceOverrideService',
);
/** DOC-01 (x91). The docs module's document read/write. */
export const DOCUMENTS_REPOSITORY = Symbol.for('tmanage.DocumentsRepository');
export const DOCUMENTS_SERVICE = Symbol.for('tmanage.DocumentsService');
/** Docs "collaboration later" (x132). The docs module's document-comments read/add. */
export const DOCUMENT_COMMENTS_SERVICE = Symbol.for('tmanage.DocumentCommentsService');
/** Docs review workflow (x313). The docs module's document review request/decide/list. */
export const DOC_REVIEWS_SERVICE = Symbol.for('tmanage.DocReviewsService');
/** DEC-01 (x113). The decisions module's decision register author/list. */
export const DECISIONS_REPOSITORY = Symbol.for('tmanage.DecisionsRepository');
export const DECISIONS_SERVICE = Symbol.for('tmanage.DecisionsService');
/** DEC / module 12 (x149). The decision→work-item linkage (link/list/unlink). */
export const DECISION_WORK_LINKS_REPOSITORY = Symbol.for('tmanage.DecisionWorkLinksRepository');
export const DECISION_WORK_LINKS_SERVICE = Symbol.for('tmanage.DecisionWorkLinksService');
export const DECISION_COMMENTS_SERVICE = Symbol.for('tmanage.DecisionCommentsService');
/** PROJ / module 8 (x124). A project's objectives — create/list/transition. */
export const PROJECT_OBJECTIVES_REPOSITORY = Symbol.for('tmanage.ProjectObjectivesRepository');
export const PROJECT_OBJECTIVES_SERVICE = Symbol.for('tmanage.ProjectObjectivesService');
/** PROJ / portfolio (x267). Project tags — define/list org tags, assign/list/remove on a project. */
export const PROJECT_TAGS_SERVICE = Symbol.for('tmanage.ProjectTagsService');
/** PROJ / module 8 (x209). A project's internal risk register — create/list/update (matrix). */
export const PROJECT_RISK_REGISTER_REPOSITORY = Symbol.for('tmanage.ProjectRiskRegisterRepository');
export const PROJECT_RISK_REGISTER_SERVICE = Symbol.for('tmanage.ProjectRiskRegisterService');
/** PROJ / module 8 (x234). Reusable project templates — define/list/instantiate. */
export const PROJECT_TEMPLATES_REPOSITORY = Symbol.for('tmanage.ProjectTemplatesRepository');
export const PROJECT_TEMPLATES_SERVICE = Symbol.for('tmanage.ProjectTemplatesService');
/** PROJ / module 8 (x235). A project's internal status-update log — post/list (keyset-paged). */
export const PROJECT_STATUS_UPDATES_REPOSITORY = Symbol.for(
  'tmanage.ProjectStatusUpdatesRepository',
);
export const PROJECT_STATUS_UPDATES_SERVICE = Symbol.for('tmanage.ProjectStatusUpdatesService');
/** PROJ / project detail (x293). A project's budget — set/read against tracked effort. */
export const PROJECT_BUDGET_REPOSITORY = Symbol.for('tmanage.ProjectBudgetRepository');
export const PROJECT_BUDGET_SERVICE = Symbol.for('tmanage.ProjectBudgetService');
/** PROJ / module 8 (x294). A project's timeline phases — define/list/delete, assign a milestone. */
export const PROJECT_PHASES_REPOSITORY = Symbol.for('tmanage.ProjectPhasesRepository');
export const PROJECT_PHASES_SERVICE = Symbol.for('tmanage.ProjectPhasesService');
/** PROJ / module 8 (x295). A project's milestone-plan baselines — snapshot/list/variance (read). */
export const PROJECT_BASELINE_REPOSITORY = Symbol.for('tmanage.ProjectBaselineRepository');
export const PROJECT_BASELINE_SERVICE = Symbol.for('tmanage.ProjectBaselineService');
/** PROJ / module 8 (x310). Custom fields for projects — define fields (org) and set values per project. */
export const PROJECT_CUSTOM_FIELDS_REPOSITORY = Symbol.for('tmanage.ProjectCustomFieldsRepository');
export const PROJECT_CUSTOM_FIELDS_SERVICE = Symbol.for('tmanage.ProjectCustomFieldsService');
/** PROJ / module 8 (x311). A project's retrospective-notes log — create/list-by-category/delete. */
export const PROJECT_RETRO_NOTES_REPOSITORY = Symbol.for('tmanage.ProjectRetroNotesRepository');
export const PROJECT_RETRO_NOTES_SERVICE = Symbol.for('tmanage.ProjectRetroNotesService');
/** PROJ / module 8 (x136). An organization's objectives / OKRs — create/list/transition. */
export const ORG_OBJECTIVES_REPOSITORY = Symbol.for('tmanage.OrgObjectivesRepository');
export const ORG_OBJECTIVES_SERVICE = Symbol.for('tmanage.OrgObjectivesService');
/** PROJ / module 8 (x137). The read-only portfolio roll-up across the caller's visible projects. */
export const PROJECT_PORTFOLIO_REPOSITORY = Symbol.for('tmanage.ProjectPortfolioRepository');
export const PROJECT_PORTFOLIO_SERVICE = Symbol.for('tmanage.ProjectPortfolioService');
/** PROJ / module 8 (x208). The read-only computed health roll-up over the caller's visible projects. */
export const PROJECT_HEALTH_REPOSITORY = Symbol.for('tmanage.ProjectHealthRepository');
export const PROJECT_HEALTH_SERVICE = Symbol.for('tmanage.ProjectHealthService');
export const OBJECTIVE_WORK_LINKS_REPOSITORY = Symbol.for('tmanage.ObjectiveWorkLinksRepository');
export const OBJECTIVE_WORK_LINKS_SERVICE = Symbol.for('tmanage.ObjectiveWorkLinksService');
/** PROJ / module 8 (x236). Milestone dependency edges — link/list/unlink a milestone's prerequisites. */
export const MILESTONE_LINKS_REPOSITORY = Symbol.for('tmanage.MilestoneLinksRepository');
export const MILESTONE_LINKS_SERVICE = Symbol.for('tmanage.MilestoneLinksService');
export const PROJECT_DEPENDENCIES_REPOSITORY = Symbol.for('tmanage.ProjectDependenciesRepository');
export const PROJECT_DEPENDENCIES_SERVICE = Symbol.for('tmanage.ProjectDependenciesService');
/** PROJ / module 8 (x207). An objective's key results — create/list/update, progress computed on read. */
export const KEY_RESULTS_REPOSITORY = Symbol.for('tmanage.KeyResultsRepository');
export const KEY_RESULTS_SERVICE = Symbol.for('tmanage.KeyResultsService');
export const CLIENT_REQUESTS_REPOSITORY = Symbol.for('tmanage.ClientRequestsRepository');
export const CLIENT_REQUESTS_SERVICE = Symbol.for('tmanage.ClientRequestsService');
/** FR-05 (x92). The approvals aggregate — deliverable versions and the decide path. */
export const APPROVALS_SERVICE = Symbol.for('tmanage.ApprovalsService');
export const CONVERSATIONS_REPOSITORY = Symbol.for('tmanage.ConversationsRepository');
export const CONVERSATIONS_SERVICE = Symbol.for('tmanage.ConversationsService');
export const MESSAGE_REACTIONS_REPOSITORY = Symbol.for('tmanage.MessageReactionsRepository');
export const MESSAGE_REACTIONS_SERVICE = Symbol.for('tmanage.MessageReactionsService');
/** x247. Pinning a message to a conversation's pinned-context list. */
export const MESSAGE_PINS_SERVICE = Symbol.for('tmanage.MessagePinsService');
export const THREAD_REPLIES_SERVICE = Symbol.for('tmanage.ThreadRepliesService');
export const CONVERSATION_READ_STATE_SERVICE = Symbol.for('tmanage.ConversationReadStateService');
/** x251. A member's unsent composer draft per conversation. */
export const MESSAGE_DRAFTS_REPOSITORY = Symbol.for('tmanage.MessageDraftsRepository');
export const MESSAGE_DRAFTS_SERVICE = Symbol.for('tmanage.MessageDraftsService');
/** CH-09 (x252). A member's own conversation mute state. */
export const CONVERSATION_MUTE_REPOSITORY = Symbol.for('tmanage.ConversationMuteRepository');
export const CONVERSATION_MUTE_SERVICE = Symbol.for('tmanage.ConversationMuteService');
export const OUTBOX_EVENTS_REPOSITORY = Symbol.for('tmanage.OutboxEventsRepository');
export const NOTIFICATIONS_REPOSITORY = Symbol.for('tmanage.NotificationsRepository');
export const NOTIFICATION_PREFERENCES_REPOSITORY = Symbol.for(
  'tmanage.NotificationPreferencesRepository',
);
export const NOTIFICATION_PREFERENCES_SERVICE = Symbol.for(
  'tmanage.NotificationPreferencesService',
);
export const INBOX_SERVICE = Symbol.for('tmanage.InboxService');
export const INBOX_FLAG_SERVICE = Symbol.for('tmanage.InboxFlagService');
export const PORTAL_INBOX_SERVICE = Symbol.for('tmanage.PortalInboxService');
export const INBOX_SNOOZE_SERVICE = Symbol.for('tmanage.InboxSnoozeService');
/** INBOX saved filters (IN-02, x261). The per-membership, tenant-scoped saved inbox filters service. */
export const INBOX_SAVED_FILTERS_SERVICE = Symbol.for('tmanage.InboxSavedFiltersService');
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
/** x270. File tags — define org tags and assign / list them on file assets. */
export const FILE_TAGS_SERVICE = Symbol.for('tmanage.FileTagsService');
export const FILE_FOLDERS_SERVICE = Symbol.for('tmanage.FileFoldersService');
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
/** INS saved views (x210). The per-user saved insights views create/list/delete service. */
export const INSIGHT_SAVED_VIEWS_SERVICE = Symbol.for('tmanage.InsightSavedViewsService');
/** x211. The insight-snapshots service — captures and lists point-in-time metric snapshots. */
export const INSIGHTS_SNAPSHOTS_SERVICE = Symbol.for('tmanage.InsightSnapshotsService');
/** x228. The per-user recurring insights-report schedule create/list/delete service. */
export const INSIGHT_REPORT_SCHEDULES_SERVICE = Symbol.for('tmanage.InsightReportSchedulesService');
/** x230. The insight-targets service — set/read an org's goal line per metric and judge attainment. */
export const INSIGHT_TARGETS_SERVICE = Symbol.for('tmanage.InsightTargetsService');
/** x302. The per-user insight-dashboard-layout service — reads/upserts the caller's own tile layout. */
export const INSIGHT_DASHBOARD_LAYOUT_SERVICE = Symbol.for('tmanage.InsightDashboardLayoutService');
/** x320. The insight custom-reports service — a member's own composed insight reports, rendered live. */
export const INSIGHT_CUSTOM_REPORTS_SERVICE = Symbol.for('tmanage.InsightCustomReportsService');
/** SRCH-01 (x111). Global tenant-scoped search over work items, documents and meetings. */
export const SEARCH_REPOSITORY = Symbol.for('tmanage.SearchRepository');
export const SEARCH_SERVICE = Symbol.for('tmanage.SearchService');
/** SRCH saved/recent (x214). The per-user, tenant-scoped saved & recent searches service. */
export const SAVED_SEARCHES_SERVICE = Symbol.for('tmanage.SavedSearchesService');
/** SRCH saved-search sharing (x272). Share/unshare a saved search with the studio; the shared list. */
export const SAVED_SEARCH_SHARES_SERVICE = Symbol.for('tmanage.SavedSearchSharesService');
/** Search recent history (x288). The per-member, tenant-scoped recent search history service. */
export const SEARCH_HISTORY_SERVICE = Symbol.for('tmanage.SearchHistoryService');

export const SEARCH_PINS_SERVICE = Symbol.for('tmanage.SearchPinsService');

/** Public & trust site (x159). The public status page's published-only incidents read. */
export const PUBLIC_SITE_STATUS_REPOSITORY = Symbol.for('tmanage.PublicSiteStatusRepository');
/** x161. The public site's contact / lead intake — the INSERT-only writer over `marketing_leads`. */
export const MARKETING_LEADS_REPOSITORY = Symbol.for('tmanage.MarketingLeadsRepository');
/** Platform states (x185). The GLOBAL maintenance-window read (public) and schedule (admin). */
export const MAINTENANCE_WINDOWS_REPOSITORY = Symbol.for('tmanage.MaintenanceWindowsRepository');
/** Billing / module 19 (x177). The subscription read + plan-change service. */
export const SUBSCRIPTION_SERVICE = Symbol.for('tmanage.SubscriptionService');
/** Billing / module 19 (x177). The `subscriptions` repository — one row per organization. */
export const SUBSCRIPTION_REPOSITORY = Symbol.for('tmanage.SubscriptionRepository');
/** Billing / module 19 (x198). The plan-change preview service — a deterministic cost estimate. */
export const PLAN_PREVIEW_SERVICE = Symbol.for('tmanage.PlanPreviewService');
