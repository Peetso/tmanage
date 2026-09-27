/**
 * The API↔web response-shape pairing — D10's replacement for the vacuous `contracts:validate`.
 *
 * `packages/contracts` was named by `package.json` from the initial commit and never authored,
 * so `pnpm --filter @tmanage/contracts validate` matched no project and exited 0 having checked
 * nothing. Nothing else in the repository compared the API's response projections with the
 * shapes `apps/web` declares for them: the two apps typecheck as separate projects, the eslint
 * boundary *forbids* the import that would link them, and the web unit tests fabricate response
 * bodies. Only `pnpm test:e2e` could catch a shape change, and only for fields its twenty
 * journeys happen to render.
 *
 * This file is the link. It is type-only — it emits nothing and runs nowhere — and it lives in
 * `e2e` because `e2e` is the one workspace outside every `no-restricted-imports` boundary glob
 * in `eslint.config.js`; those target `apps/web/**`, `packages/ui/**` and `packages/domain/**`,
 * never here. `apps/web` still may not import `apps/api`. This file may, and does so on both
 * sides at once so that a disagreement between them is a compile error.
 *
 * It is checked two ways:
 *
 *   - `pnpm --filter @tmanage/e2e typecheck` (and so `pnpm typecheck`) compiles the assertions
 *     below. Rename a field on either side, or change a `string` to a `number`, and `tsc` fails.
 *   - `pnpm contracts:check` runs that compile *and* enumerates every `export interface …View`
 *     under `apps/api/src/modules/**\/*.service.ts`, failing if any of them is neither asserted
 *     here nor carried in the named exemption list in `scripts/contracts-check.mjs`. A new API
 *     view therefore cannot appear unpaired and unnoticed.
 *
 * @see docs/planning/48-CLAUDE-CODE-IMPLEMENTATION-START-PROMPT.md §178 (the boundary rule)
 */

// ── The API's response projections ──────────────────────────────────────────
import type { AcceptedClientRequestView as ApiAcceptedClientRequestView } from '../../apps/api/src/modules/requests/client-requests.service.js';
import type { AcceptedInvitationView as ApiAcceptedInvitationView } from '../../apps/api/src/modules/tenancy/invitations.service.js';
import type { AuditEventView as ApiAuditEventView } from '../../apps/api/src/modules/audit/audit.service.js';
import type { AdminAuditEventView as ApiAdminAuditEventView } from '../../apps/api/src/modules/audit/audit.service.js';
import type { ChallengeResponseView as ApiChallengeResponseView } from '../../apps/api/src/modules/identity/authentication.controller.js';
import type { ClientDecideView as ApiClientDecideView } from '../../apps/api/src/modules/approvals/approvals.service.js';
import type { ClientProjectionView as ApiClientProjectionView } from '../../apps/api/src/modules/approvals/approvals.service.js';
import type { ClientRequestClientView as ApiClientRequestClientView } from '../../apps/api/src/modules/requests/client-requests.service.js';
import type { ClientRequestView as ApiClientRequestView } from '../../apps/api/src/modules/requests/client-requests.service.js';
import type { ConversationView as ApiConversationView } from '../../apps/api/src/modules/conversations/conversations.service.js';
import type { ConvertMessageResultView as ApiConvertMessageResultView } from '../../apps/api/src/modules/conversations/conversations.service.js';
import type { CreatedOrganizationView as ApiCreatedOrganizationView } from '../../apps/api/src/modules/tenancy/provisioning.service.js';
import type { DocumentView as ApiDocumentView } from '../../apps/api/src/modules/docs/documents.service.js';
import type { DocumentVersionView as ApiDocumentVersionView } from '../../apps/api/src/modules/docs/documents.service.js';
import type { DocumentCommentView as ApiDocumentCommentView } from '../../apps/api/src/modules/docs/document-comments.service.js';
import type { DecisionView as ApiDecisionView } from '../../apps/api/src/modules/decisions/decisions.service.js';
import type { DecisionDetailView as ApiDecisionDetailView } from '../../apps/api/src/modules/decisions/decisions.service.js';
import type { DecisionLockView as ApiDecisionLockView } from '../../apps/api/src/modules/decisions/decisions.service.js';
import type { DocumentTemplateView as ApiDocumentTemplateView } from '../../apps/api/src/modules/docs/documents.service.js';
import type { DocumentTemplateVariableView as ApiDocumentTemplateVariableView } from '../../apps/api/src/modules/docs/document-template-variables.controller.js';
import type { AutomationScheduleView as ApiAutomationScheduleView } from '../../apps/api/src/modules/automations/schedules.controller.js';
import type { EnrolledFactorView as ApiEnrolledFactorView } from '../../apps/api/src/modules/identity/authentication.service.js';
import type { EstablishedSessionView as ApiEstablishedSessionView } from '../../apps/api/src/modules/identity/session.service.js';
import type { EstablishedView as ApiEstablishedView } from '../../apps/api/src/modules/identity/authentication.controller.js';
import type { ContactSubmitView as ApiContactSubmitView } from '../../apps/api/src/modules/public-site/contact.controller.js';
import type {
  ImportCommitRowView as ApiImportCommitRowView,
  ImportCommitView as ApiImportCommitView,
} from '../../apps/api/src/modules/import/import.service.js';
import type { InboxBundleView as ApiInboxBundleView } from '../../apps/api/src/modules/inbox/inbox.service.js';
import type { InboxPageView as ApiInboxPageView } from '../../apps/api/src/modules/inbox/inbox.service.js';
import type { InboxUsageNoticeView as ApiInboxUsageNoticeView } from '../../apps/api/src/modules/inbox/inbox.service.js';
import type { MyDayView as ApiMyDayView } from '../../apps/api/src/modules/home/home.service.js';
import type { WaitingView as ApiWaitingView } from '../../apps/api/src/modules/home/home.service.js';
import type { HomeSummaryView as ApiHomeSummaryView } from '../../apps/api/src/modules/home/home.service.js';
import type { HomePulseView as ApiHomePulseView } from '../../apps/api/src/modules/home/home-pulse.service.js';
import type { SavedContextView as ApiSavedContextView } from '../../apps/api/src/modules/home/home.service.js';
import type { HomePinView as ApiHomePinView } from '../../apps/api/src/modules/home/home-pins.controller.js';
import type { NotificationKindPrefView as ApiNotificationKindPrefView } from '../../apps/api/src/modules/notifications/notification-kind-prefs.controller.js';
import type { OnboardingTourView as ApiOnboardingTourView } from '../../apps/api/src/modules/home/onboarding-tour.controller.js';
import type { InvitationPreviewView as ApiInvitationPreviewView } from '../../apps/api/src/modules/tenancy/invitations.service.js';
import type { InvitationView as ApiInvitationView } from '../../apps/api/src/modules/tenancy/invitations.service.js';
import type { IssuedInvitationView as ApiIssuedInvitationView } from '../../apps/api/src/modules/tenancy/invitations.service.js';
import type { MeetingNoteView as ApiMeetingNoteView } from '../../apps/api/src/modules/calendar/meetings.service.js';
import type { MeetingView as ApiMeetingView } from '../../apps/api/src/modules/calendar/meetings.service.js';
import type { MeetingAttendeeView as ApiMeetingAttendeeView } from '../../apps/api/src/modules/calendar/meeting-attendees.service.js';
import type { MeetingAgendaView as ApiMeetingAgendaView } from '../../apps/api/src/modules/calendar/meeting-agenda.controller.js';
import type {
  NotificationView as ApiNotificationView,
  NotificationFeedView as ApiNotificationFeedView,
} from '../../apps/api/src/modules/notifications/notifications-feed.controller.js';
import type { MeetingSeriesView as ApiMeetingSeriesView } from '../../apps/api/src/modules/calendar/meeting-series.service.js';
import type { MemberView as ApiMemberView } from '../../apps/api/src/modules/tenancy/members.controller.js';
import type {
  MemberOffboardingImpactView as ApiMemberOffboardingImpactView,
  OffboardedMemberView as ApiOffboardedMemberView,
} from '../../apps/api/src/modules/tenancy/offboarding.service.js';
import type { MessageRevisionView as ApiMessageRevisionView } from '../../apps/api/src/modules/conversations/conversations.service.js';
import type { MessageView as ApiMessageView } from '../../apps/api/src/modules/conversations/conversations.service.js';
import type { OrganizationSummaryView as ApiOrganizationSummaryView } from '../../apps/api/src/modules/tenancy/provisioning.service.js';
import type { PortalFileView as ApiPortalFileView } from '../../apps/api/src/modules/files/portal-file-list.service.js';
import type { PortalInboxBundleView as ApiPortalInboxBundleView } from '../../apps/api/src/modules/inbox/portal-inbox.service.js';
import type { PortalInboxPageView as ApiPortalInboxPageView } from '../../apps/api/src/modules/inbox/portal-inbox.service.js';
import type { PortalProjectView as ApiPortalProjectView } from '../../apps/api/src/modules/clients/portal.service.js';
import type { PortalUpdateView as ApiPortalUpdateView } from '../../apps/api/src/modules/clients/portal.service.js';
import type { PortalPersonView as ApiPortalPersonView } from '../../apps/api/src/modules/clients/portal-people.repository.js';
import type { PortalWorkItemView as ApiPortalWorkItemView } from '../../apps/api/src/modules/clients/portal.service.js';
import type { PortalDeliverableView as ApiPortalDeliverableView } from '../../apps/api/src/modules/clients/portal.service.js';
import type { PortalDeliverableFileView as ApiPortalDeliverableFileView } from '../../apps/api/src/modules/clients/portal.service.js';
import type { UpdateCommentView as ApiUpdateCommentView } from '../../apps/api/src/modules/clients/update-comments.service.js';
import type { ClientUpdateCommentView as ApiClientUpdateCommentView } from '../../apps/api/src/modules/clients/update-comments.service.js';
import type { ProjectMilestoneView as ApiProjectMilestoneView } from '../../apps/api/src/modules/clients/project-milestones.projection.js';
import type { ClientMilestoneView as ApiClientMilestoneView } from '../../apps/api/src/modules/clients/project-milestones.projection.js';
import type { ProjectRiskView as ApiProjectRiskView } from '../../apps/api/src/modules/clients/project-risks.controller.js';
import type { ClientRiskView as ApiClientRiskView } from '../../apps/api/src/modules/clients/project-risks.controller.js';
import type { ProjectClientView as ApiProjectClientView } from '../../apps/api/src/modules/clients/clients.service.js';
import type { ProjectMemberView as ApiProjectMemberView } from '../../apps/api/src/modules/projects/project-members.controller.js';
import type { ProjectView as ApiProjectView } from '../../apps/api/src/modules/projects/projects.service.js';
import type { PublicHomeView as ApiPublicHomeView } from '../../apps/api/src/modules/public-site/public-content.service.js';
import type { ProjectObjectiveView as ApiProjectObjectiveView } from '../../apps/api/src/modules/projects/project-objectives.service.js';
import type { OrgObjectiveView as ApiOrgObjectiveView } from '../../apps/api/src/modules/projects/org-objectives.service.js';
import type { ProjectPortfolioView as ApiProjectPortfolioView } from '../../apps/api/src/modules/projects/portfolio.service.js';
import type { PublicPlanView as ApiPublicPlanView } from '../../apps/api/src/modules/public-site/plan-catalog.service.js';
import type { ObjectiveWorkLinkView as ApiObjectiveWorkLinkView } from '../../apps/api/src/modules/projects/objective-work-links.service.js';
import type { DecisionWorkLinkView as ApiDecisionWorkLinkView } from '../../apps/api/src/modules/decisions/decision-work-links.service.js';
import type { SearchResultView as ApiSearchResultView } from '../../apps/api/src/modules/search/search.service.js';
import type { RealtimeTicketView as ApiRealtimeTicketView } from '../../apps/api/src/modules/realtime/realtime.controller.js';
import type { SessionSummaryView as ApiSessionSummaryView } from '../../apps/api/src/modules/identity/session.service.js';
import type { UsageView as ApiUsageView } from '../../apps/api/src/modules/files/usage.service.js';
import type { ApprovalCycleView as ApiApprovalCycleView } from '../../apps/api/src/modules/insights/insights.service.js';
import type { DeliveryFlowView as ApiDeliveryFlowView } from '../../apps/api/src/modules/insights/insights.service.js';
import type { InsightsPortfolioView as ApiInsightsPortfolioView } from '../../apps/api/src/modules/insights/insights.service.js';
import type { InsightsWorkloadView as ApiInsightsWorkloadView } from '../../apps/api/src/modules/insights/insights.service.js';
import type { InsightsAdoptionView as ApiInsightsAdoptionView } from '../../apps/api/src/modules/insights/adoption.controller.js';
import type { WorkloadForecastView as ApiWorkloadForecastView } from '../../apps/api/src/modules/insights/workload-forecast.service.js';
import type { RequestAgingView as ApiRequestAgingView } from '../../apps/api/src/modules/requests/request-aging.controller.js';
import type { PublicChangelogView as ApiPublicChangelogView } from '../../apps/api/src/modules/public-site/changelog.controller.js';
import type { WorkItemView as ApiWorkItemView } from '../../apps/api/src/modules/work/work-items.service.js';
import type { WorkChecklistItemView as ApiWorkChecklistItemView } from '../../apps/api/src/modules/work/work-checklist.service.js';
import type { WorkCommentView as ApiWorkCommentView } from '../../apps/api/src/modules/work/work-comments.service.js';
import type { WorkFormView as ApiWorkFormView } from '../../apps/api/src/modules/work/work-forms.controller.js';
import type { WorkflowTemplateView as ApiWorkflowTemplateView } from '../../apps/api/src/modules/automations/templates.controller.js';
import type { WorkflowRunView as ApiWorkflowRunView } from '../../apps/api/src/modules/automations/run.controller.js';
import type { IntegrationAppView as ApiIntegrationAppView } from '../../apps/api/src/modules/automations/directory.controller.js';
import type { IntegrationConnectionView as ApiIntegrationConnectionView } from '../../apps/api/src/modules/automations/directory.controller.js';
import type { WebhookEndpointView as ApiWebhookEndpointView } from '../../apps/api/src/modules/automations/webhooks.controller.js';
import type { WorkTimelineView as ApiWorkTimelineView } from '../../apps/api/src/modules/work-views/work-views.service.js';
import type { WorkloadView as ApiWorkloadView } from '../../apps/api/src/modules/work-views/work-views.service.js';
import type { WorkCalendarView as ApiWorkCalendarView } from '../../apps/api/src/modules/work-views/work-views.service.js';
import type { SavedViewView as ApiSavedViewView } from '../../apps/api/src/modules/work-views/work-views.service.js';
import type { WorkspaceView as ApiWorkspaceView } from '../../apps/api/src/modules/tenancy/workspaces.controller.js';
import type { OrgSettingsView as ApiOrgSettingsView } from '../../apps/api/src/modules/tenancy/org-settings.controller.js';
import type { PublicTrustView as ApiPublicTrustView } from '../../apps/api/src/modules/public-site/trust-content.service.js';
import type {
  PublicIncidentView as ApiPublicIncidentView,
  PublicStatusView as ApiPublicStatusView,
} from '../../apps/api/src/modules/public-site/status.controller.js';

// ── The shapes `apps/web` declares for them ─────────────────────────────────
import type {
  ClientApprovalView as WebClientApprovalView,
  ClientDecideResult as WebClientDecideResult,
} from '../../apps/web/src/lib/api/approvals';
import type { EnrolledFactor as WebEnrolledFactor } from '../../apps/web/src/lib/api/auth';
import type { MyDay as WebMyDay } from '../../apps/web/src/lib/api/home';
import type { Waiting as WebWaiting } from '../../apps/web/src/lib/api/home';
import type { HomeSummary as WebHomeSummary } from '../../apps/web/src/lib/api/home';
import type { HomePulse as WebHomePulse } from '../../apps/web/src/lib/api/home';
import type { SavedContext as WebSavedContext } from '../../apps/web/src/lib/api/home';
import type { HomePinView as WebHomePinView } from '../../apps/web/src/lib/api/home';
import type { NotificationKindPrefView as WebNotificationKindPrefView } from '../../apps/web/src/lib/api/notification-kind-prefs';
import type { OrgSettingsView as WebOrgSettingsView } from '../../apps/web/src/lib/api/org-settings';
import type { OnboardingTourView as WebOnboardingTourView } from '../../apps/web/src/lib/api/onboarding-tour';
import type {
  AuthenticatedResponse as WebAuthenticatedResponse,
  MfaRequiredResponse as WebMfaRequiredResponse,
} from '../../apps/web/src/lib/api/auth';
import type {
  AcceptedClientRequest as WebAcceptedClientRequest,
  ClientRequestHistoryEntry as WebClientRequestHistoryEntry,
  ClientRequestRecord as WebClientRequestRecord,
} from '../../apps/web/src/lib/api/client-requests';
import type { ProjectShare as WebProjectShare } from '../../apps/web/src/lib/api/clients';
import type { DocumentVersionSummary as WebDocumentVersionSummary } from '../../apps/web/src/lib/api/documents';
import type { DecisionSummary as WebDecisionSummary } from '../../apps/web/src/lib/api/decisions';
import type { WorkFormSummary as WebWorkFormSummary } from '../../apps/web/src/lib/api/work-forms';
import type { WorkflowTemplateSummary as WebWorkflowTemplateSummary } from '../../apps/web/src/lib/api/automations';
import type { WorkflowRunSummary as WebWorkflowRunSummary } from '../../apps/web/src/lib/api/automations';
import type { IntegrationAppView as WebIntegrationAppView } from '../../apps/web/src/lib/api/integration-directory';
import type { IntegrationConnectionView as WebIntegrationConnectionView } from '../../apps/web/src/lib/api/integration-directory';
import type { WebhookEndpointSummary as WebWebhookEndpointSummary } from '../../apps/web/src/lib/api/webhooks';
import type { DecisionDetail as WebDecisionDetail } from '../../apps/web/src/lib/api/decisions';
import type { DecisionLock as WebDecisionLock } from '../../apps/web/src/lib/api/decisions';
import type { DocumentTemplateSummary as WebDocumentTemplateSummary } from '../../apps/web/src/lib/api/document-templates';
import type { ProjectObjectiveSummary as WebProjectObjectiveSummary } from '../../apps/web/src/lib/api/project-objectives';
import type { DocumentTemplateVariableSummary as WebDocumentTemplateVariableSummary } from '../../apps/web/src/lib/api/document-template-variables';
import type { AutomationScheduleSummary as WebAutomationScheduleSummary } from '../../apps/web/src/lib/api/automation-schedules';
import type { OrgObjectiveSummary as WebOrgObjectiveSummary } from '../../apps/web/src/lib/api/org-objectives';
import type { ProjectPortfolioSummary as WebProjectPortfolioSummary } from '../../apps/web/src/lib/api/project-portfolio';
import type { PublicPlanView as WebPublicPlanView } from '../../apps/web/src/lib/api/public-plans';
import type { ObjectiveWorkLink as WebObjectiveWorkLink } from '../../apps/web/src/lib/api/objective-work-links';
import type { DecisionWorkLink as WebDecisionWorkLink } from '../../apps/web/src/lib/api/decision-work-links';
import type {
  ConversationSummary as WebConversationSummary,
  ConvertMessageResult as WebConvertMessageResult,
  MessageRevisionSummary as WebMessageRevisionSummary,
  MessageSummary as WebMessageSummary,
} from '../../apps/web/src/lib/api/conversations';
import type { DocumentView as WebDocumentView } from '../../apps/web/src/lib/api/documents';
import type { DocumentCommentView as WebDocumentCommentView } from '../../apps/web/src/lib/api/document-comments';
import type {
  InboxBundle as WebInboxBundle,
  InboxPage as WebInboxPage,
  InboxUsageNotice as WebInboxUsageNotice,
} from '../../apps/web/src/lib/api/inbox';
import type {
  AcceptedInvitation as WebAcceptedInvitation,
  InvitationPreview as WebInvitationPreview,
  InvitationSummary as WebInvitationSummary,
  IssuedInvitation as WebIssuedInvitation,
} from '../../apps/web/src/lib/api/invitations';
import type { MeetingNoteView as WebMeetingNoteView } from '../../apps/web/src/lib/api/meetings';
import type { MeetingView as WebMeetingView } from '../../apps/web/src/lib/api/meetings';
import type { MeetingAttendeeView as WebMeetingAttendeeView } from '../../apps/web/src/lib/api/meeting-attendees';
import type { MeetingAgendaView as WebMeetingAgendaView } from '../../apps/web/src/lib/api/meeting-agenda';
import type {
  NotificationView as WebNotificationView,
  NotificationFeedView as WebNotificationFeedView,
} from '../../apps/web/src/lib/api/notifications-feed';
import type { MeetingSeriesView as WebMeetingSeriesView } from '../../apps/web/src/lib/api/meeting-series';
import type { MemberSummary as WebMemberSummary } from '../../apps/web/src/lib/api/members';
import type { ProjectMemberSummary as WebProjectMemberSummary } from '../../apps/web/src/lib/api/project-members';
import type {
  OffboardingImpactView as WebOffboardingImpactView,
  OffboardedMember as WebOffboardedMember,
} from '../../apps/web/src/lib/api/offboarding';
import type {
  CreatedOrganization as WebCreatedOrganization,
  OrganizationSummary as WebOrganizationSummary,
} from '../../apps/web/src/lib/api/organizations';
import type {
  ClientRequest as WebClientRequest,
  PortalFile as WebPortalFile,
  PortalInboxBundle as WebPortalInboxBundle,
  PortalInboxPage as WebPortalInboxPage,
  PortalDeliverable as WebPortalDeliverable,
  PortalDeliverableFile as WebPortalDeliverableFile,
  PortalPerson as WebPortalPerson,
  PortalProject as WebPortalProject,
  PortalUpdate as WebPortalUpdate,
  UpdateComment as WebUpdateComment,
  ClientUpdateComment as WebClientUpdateComment,
  PortalWorkItem as WebPortalWorkItem,
  ProjectMilestone as WebProjectMilestone,
  ClientMilestone as WebClientMilestone,
  ProjectRisk as WebProjectRisk,
  ClientRisk as WebClientRisk,
} from '../../apps/web/src/lib/api/portal';
import type {
  ImportReceipt as WebImportReceipt,
  ImportReceiptRow as WebImportReceiptRow,
} from '../../apps/web/src/lib/api/imports';
import type {
  ProjectSummary as WebProjectSummary,
  WorkspaceSummary as WebWorkspaceSummary,
} from '../../apps/web/src/lib/api/projects';
import type { PublicHome as WebPublicHome } from '../../apps/web/src/lib/api/public-site';
import type { RealtimeTicket as WebRealtimeTicket } from '../../apps/web/src/lib/api/realtime';
import type { SearchResult as WebSearchResult } from '../../apps/web/src/lib/api/search';
import type { ContactSubmitView as WebContactSubmitView } from '../../apps/web/src/lib/api/contact';
import type {
  EstablishedSession as WebEstablishedSession,
  SessionSummary as WebSessionSummary,
} from '../../apps/web/src/lib/api/session';
import type { OrganizationUsage as WebOrganizationUsage } from '../../apps/web/src/lib/api/usage';
import type { AdminAuditEvent as WebAdminAuditEvent } from '../../apps/web/src/lib/api/admin-audit';
import type { ApprovalCycle as WebApprovalCycle } from '../../apps/web/src/lib/api/approval-cycle';
import type { DeliveryFlow as WebDeliveryFlow } from '../../apps/web/src/lib/api/delivery-flow';
import type { InsightsPortfolio as WebInsightsPortfolio } from '../../apps/web/src/lib/api/insights-portfolio';
import type { InsightsWorkloadView as WebInsightsWorkloadView } from '../../apps/web/src/lib/api/insights-workload';
import type { InsightsAdoptionView as WebInsightsAdoptionView } from '../../apps/web/src/lib/api/insights-adoption';
import type { WorkloadForecastView as WebWorkloadForecastView } from '../../apps/web/src/lib/api/workload-forecast';
import type { RequestAgingView as WebRequestAgingView } from '../../apps/web/src/lib/api/request-aging';
import type { PublicChangelogView as WebPublicChangelogView } from '../../apps/web/src/lib/api/public-changelog';
import type { WorkItemSummary as WebWorkItemSummary } from '../../apps/web/src/lib/api/work-items';
import type { WorkChecklistItem as WebWorkChecklistItem } from '../../apps/web/src/lib/api/work-items';
import type { WorkComment as WebWorkComment } from '../../apps/web/src/lib/api/work-items';
import type { WorkTimelineView as WebWorkTimelineView } from '../../apps/web/src/lib/api/work-views';
import type { WorkloadView as WebWorkloadView } from '../../apps/web/src/lib/api/work-views';
import type { WorkCalendarView as WebWorkCalendarView } from '../../apps/web/src/lib/api/work-views';
import type { SavedViewView as WebSavedViewView } from '../../apps/web/src/lib/api/work-views';
import type { PublicTrustView as WebPublicTrustView } from '../../apps/web/src/lib/api/public-trust';
import type {
  PublicIncidentView as WebPublicIncidentView,
  PublicStatusView as WebPublicStatusView,
} from '../../apps/web/src/lib/api/public-site';

// ── The assertions themselves ───────────────────────────────────────────────

/**
 * What a failure looks like.
 *
 * A template literal type rather than an object, because TypeScript prints a string literal
 * into the error text verbatim: a renamed field reports
 * `fields only on the api type: forecastOn; only on the web type: forecastAt` instead of a
 * bare `false`, and the reader is told which side moved without opening either file. Both
 * sides reading `none` means the field names line up and a field's *type* changed.
 */
type OnlyOn<A, B> = [Exclude<keyof A, keyof B>] extends [never]
  ? 'none'
  : Exclude<keyof A, keyof B>;

type ApiWebMismatch<Api, Web> =
  `contract drift between apps/api and apps/web — fields only on the api type: ${Extract<OnlyOn<Api, Web>, string>}; only on the web type: ${Extract<OnlyOn<Web, Api>, string>} (both "none" = the fields line up and a field's type changed)`;

/** Mutual assignability. The default, and what every pair should satisfy. */
type Exact<Api, Web> = [Api] extends [Web]
  ? [Web] extends [Api]
    ? true
    : ApiWebMismatch<Api, Web>
  : ApiWebMismatch<Api, Web>;

/**
 * One-way assignability: every `Api` value is a valid `Web` value, but not the reverse.
 *
 * For a pair where the API response carries strictly more than the web screen reads — the
 * history screen consumes `AuditEventView` but declares only the seven fields it renders, not
 * `correlationId`/`metadata`/`effectiveActorId` — an `Exact` assertion would be a false claim.
 * `Narrows<Api, Web>` states the true relationship: the API projection is assignable to the web
 * shape, so nothing the screen reads can move or change type on the API side without failing here.
 */
type Narrows<Api, Web> = [Api] extends [Web] ? true : ApiWebMismatch<Api, Web>;

/** `never extends true` is vacuously satisfied, so a failing check must resolve to an object. */
type Assert<T extends true> = T;

// Exact pairs — the API projection and the web declaration are the same type.
type _conversation = Assert<Exact<ApiConversationView, WebConversationSummary>>;
type _message = Assert<Exact<ApiMessageView, WebMessageSummary>>;
type _messageRevision = Assert<Exact<ApiMessageRevisionView, WebMessageRevisionSummary>>;
type _inboxBundle = Assert<Exact<ApiInboxBundleView, WebInboxBundle>>;
type _inboxUsageNotice = Assert<Exact<ApiInboxUsageNoticeView, WebInboxUsageNotice>>;
type _inboxPage = Assert<Exact<ApiInboxPageView, WebInboxPage>>;
type _portalInboxBundle = Assert<Exact<ApiPortalInboxBundleView, WebPortalInboxBundle>>;
type _portalInboxPage = Assert<Exact<ApiPortalInboxPageView, WebPortalInboxPage>>;
type _portalProject = Assert<Exact<ApiPortalProjectView, WebPortalProject>>;
type _portalUpdate = Assert<Exact<ApiPortalUpdateView, WebPortalUpdate>>;
// SEC / Portal update comments (x203): the internal thread and the client projection. The panel
// reads exactly these responses, so both pairs are Exact; the client view drops the staff author.
type _updateComment = Assert<Exact<ApiUpdateCommentView, WebUpdateComment>>;
type _clientUpdateComment = Assert<Exact<ApiClientUpdateCommentView, WebClientUpdateComment>>;
type _projectRisk = Assert<Exact<ApiProjectRiskView, WebProjectRisk>>;
type _clientRisk = Assert<Exact<ApiClientRiskView, WebClientRisk>>;
type _portalFile = Assert<Exact<ApiPortalFileView, WebPortalFile>>;
type _portalPerson = Assert<Exact<ApiPortalPersonView, WebPortalPerson>>;
type _portalWorkItem = Assert<Exact<ApiPortalWorkItemView, WebPortalWorkItem>>;
// CONTRACT-001 (x114): the client portal's deliverables and their file lists. The screen reads
// exactly these responses, so both pairs are Exact.
type _portalDeliverable = Assert<Exact<ApiPortalDeliverableView, WebPortalDeliverable>>;
type _portalDeliverableFile = Assert<Exact<ApiPortalDeliverableFileView, WebPortalDeliverableFile>>;
type _projectMilestone = Assert<Exact<ApiProjectMilestoneView, WebProjectMilestone>>;
type _clientMilestone = Assert<Exact<ApiClientMilestoneView, WebClientMilestone>>;
type _projectClient = Assert<Exact<ApiProjectClientView, WebProjectShare>>;
type _project = Assert<Exact<ApiProjectView, WebProjectSummary>>;

/**
 * Public & trust site (module 1, x156). `GET /v1/public/site/home` — the marketing home content.
 * `MarketingHomeScreen` reads exactly this deterministic payload (hero, features, CTA targets), so
 * the pair is Exact.
 */
type _publicHome = Assert<Exact<ApiPublicHomeView, WebPublicHome>>;

/**
 * ADM-02 (x116). `GET/POST/PATCH/DELETE …/projects/:projectId/members` — a project membership row.
 * The `MembersAndRolesScreen` reads exactly this projection (`projectMembershipId`, `userId`,
 * `role`, `createdAt`), resolving the display name from the member directory rather than from this
 * endpoint, so the pair is Exact.
 */
type _projectMember = Assert<Exact<ApiProjectMemberView, WebProjectMemberSummary>>;
type _clientRequestClient = Assert<Exact<ApiClientRequestClientView, WebClientRequest>>;

/**
 * PROJ / module 8 (x124). `ProjectObjectiveView` (`GET`/`POST …/projects/:id/objectives` and the
 * `PATCH …/objectives/:objectiveId` response) — a project's objective and its lifecycle status.
 * Paired with a live web consumer: `ProjectObjectivesScreen` reads exactly this response, so this is
 * a real `Exact` pair. The `status` union (`open | met | missed`) is the same on both sides.
 */
type _projectObjective = Assert<Exact<ApiProjectObjectiveView, WebProjectObjectiveSummary>>;

/**
 * PROJ / module 8 (x136). `OrgObjectiveView` (`GET`/`POST …/organizations/:orgSlug/objectives` and the
 * `PATCH …/objectives/:objectiveId` response) — an organization's objective / OKR and its lifecycle
 * status. The org-level counterpart of `ProjectObjectiveView` (x124), with no `projectId`. Paired with
 * a live web consumer: `OrgObjectivesScreen` reads exactly this response, so this is a real `Exact`
 * pair. The `status` union (`open | met | missed`) is the same on both sides.
 */
type _orgObjective = Assert<Exact<ApiOrgObjectiveView, WebOrgObjectiveSummary>>;

/**
 * PROJ / module 8 (x137). `ProjectPortfolioView` (`GET …/projects/portfolio`) — one project's
 * read-only roll-up: open-work count, x124 objective tallies by status, and latest activity. Paired
 * with a live web consumer: `ProjectPortfolioScreen` reads exactly this response, so this is a real
 * `Exact` pair, including the nested `objectiveCounts` object, which is the same shape on both sides.
 */
type _projectPortfolio = Assert<Exact<ApiProjectPortfolioView, WebProjectPortfolioSummary>>;

/**
 * FEAT · module 1 Public site (x157). `PublicPlanView` (`GET /v1/public/site/plans`) — one plan tier
 * as the public pricing page reads it: id, name, tagline, monthly price in minor units, currency, seat
 * rule, `featured` flag and feature bullets. A `@Public()` read with no tenant and nothing personal.
 * Paired with a live web consumer: `PricingScreen` reads exactly this response, so this is a real
 * `Exact` pair.
 */
type _publicPlan = Assert<Exact<ApiPublicPlanView, WebPublicPlanView>>;

/**
 * PROJ / module 8 (x138). `ObjectiveWorkLinkView` (`GET`/`POST …/objectives/:id/work-links` response) —
 * the edge from an objective to a work item, with the linked item's title and state. Paired with a live
 * web consumer: `ObjectiveWorkLinksPanel` reads exactly this response, so this is a real `Exact` pair.
 */
type _objectiveWorkLink = Assert<Exact<ApiObjectiveWorkLinkView, WebObjectiveWorkLink>>;

/**
 * DEC / module 12 (x149). `DecisionWorkLinkView` (`GET`/`POST …/decisions/:id/work-links` response) —
 * the edge from a decision to a work item, with the linked item's title and state. Paired with a live
 * web consumer: `DecisionWorkLinksPanel` reads exactly this response, so this is a real `Exact` pair.
 */
type _decisionWorkLink = Assert<Exact<ApiDecisionWorkLinkView, WebDecisionWorkLink>>;

/**
 * CAL-01 / MTG-01 third slice (x108). `GET .../meetings/:meetingId/notes` — a meeting's captured
 * notes and decisions, read by `MeetingNotesScreen`. x105 landed the API read/write with no web
 * consumer (the view was carried EXEMPT in `scripts/contracts-check.mjs`); this slice ships the
 * read screen and its `apps/web` shape, so the exemption was retired and the view is paired Exact.
 */
type _meetingNote = Assert<Exact<ApiMeetingNoteView, WebMeetingNoteView>>;

/**
 * DOC-02/DOC-03 (x112). `DocumentVersionView` (`GET`/`POST …/documents/:id/versions[/:n]`,
 * `POST …/documents/:id/restore`) — one immutable version of a document. The `DocumentEditorScreen`
 * reads exactly this response for its history/compare/restore, so the pair is Exact.
 */
type _documentVersion = Assert<Exact<ApiDocumentVersionView, WebDocumentVersionSummary>>;

/**
 * Docs "collaboration later" (x132). `DocumentCommentView` (`GET`/`POST
 * …/documents/:documentId/comments`) — one comment on a document. The `DocumentCommentsPanel` beside
 * `DocumentViewScreen` reads exactly this response, so the pair is Exact. `organizationId` is on
 * neither side — the API never echoes the tenant id into a response body.
 */
type _documentComment = Assert<Exact<ApiDocumentCommentView, WebDocumentCommentView>>;

/**
 * DEC-01 (x113). `DecisionView` (`GET`/`POST …/decisions`, request body + response). Paired with a
 * live web consumer — DEC-01 ships `DecisionRegisterScreen`, which reads exactly this response — so
 * this is a real `Exact` pair, not an EXEMPT entry. The `status` union (`proposed | accepted |
 * superseded`) is the same on both sides; a value one side does not contain cannot be typed here.
 */
type _decision = Assert<Exact<ApiDecisionView, WebDecisionSummary>>;

/**
 * DEC-01-b / DEC-02 (x117). `DecisionDetailView` (`GET …/decisions/:id` and the `POST
 * …/decisions/:id/supersede` response) — a decision plus its supersede chain (`supersededBy` /
 * `supersedes`). Paired with a live web consumer: `DecisionRegisterScreen` reads exactly this to
 * render a decision's detail and lifecycle controls, so this is a real `Exact` pair.
 */
type _decisionDetail = Assert<Exact<ApiDecisionDetailView, WebDecisionDetail>>;

/**
 * SEC / Decisions (x150). `DecisionLockView` (`POST …/decisions/:id/lock` response) — the durable fact
 * that a decision has been sealed against further lifecycle writes (`lockedBy` / `lockedAt`). Paired
 * with a live web consumer: `DecisionRegisterScreen`'s lock control reads exactly this, so the pair is
 * Exact. `organizationId` is absent on both sides — the wire projection never echoes the tenant id.
 */
type _decisionLock = Assert<Exact<ApiDecisionLockView, WebDecisionLock>>;

/**
 * DOC-04/ADM-06 (x119). `DocumentTemplateView` (`GET`/`POST …/documents/templates`) — one org-scoped
 * document template. The `DocumentTemplatesScreen` gallery reads exactly this response, so the pair
 * is Exact. `organizationId` is absent on both sides — the wire projection never echoes the tenant
 * id. (The applied document's shape is DOC-01's `DocumentView` pairing, kept private in the web
 * client to avoid a second competing projection.)
 */
type _documentTemplate = Assert<Exact<ApiDocumentTemplateView, WebDocumentTemplateSummary>>;
/**
 * CAL-01 / MTG-01 (x90 API, x122 web). `GET`/`POST .../meetings` — a project's meetings, listed
 * and created by `MeetingsScreen`. x90 landed the API with no web consumer (the view was carried
 * EXEMPT in `scripts/contracts-check.mjs`); x122 ships the list/create screen and its `apps/web`
 * shape, so the exemption was retired and the view is paired Exact.
 */
type _meeting = Assert<Exact<ApiMeetingView, WebMeetingView>>;

/**
 * CAL-01 / MTG-01 attendees + RSVP (x126). `GET`/`POST .../meetings/:meetingId/attendees` and
 * `PATCH .../attendees/:attendeeId` — a meeting's attendees and their RSVP, read and driven by
 * `MeetingAttendeesScreen`. The member is named by `userId` (the roster's identity), never the
 * internal `membershipId`; paired Exact, so a rename or retype on either side fails the gate.
 */
type _meetingAttendee = Assert<Exact<ApiMeetingAttendeeView, WebMeetingAttendeeView>>;

/**
 * CAL agenda / day view (x127). `GET .../meetings/agenda?from&to` — the tenant's meetings grouped by
 * their start day, read by `MeetingAgendaScreen`. A read-only composition over `meetings` with no
 * new table; the view lives on the controller (no service, like the shape it composes). Paired Exact
 * with the web `MeetingAgendaView`; the nested day/entry shapes are inlined on both sides.
 */
type _meetingAgenda = Assert<Exact<ApiMeetingAgendaView, WebMeetingAgendaView>>;

/**
 * NOTIF feed (x151). `GET .../notifications` and `POST .../notifications/:id/read` — the flat
 * per-notification feed over `notifications` (0010, no new table), read by
 * `NotificationsFeedScreen`. Behind `work.read` (INBOX-001's choice), own-principal scoped: the
 * mark-read resolves the caller's own row before it writes, and another user's id is a 404. Both
 * the item `NotificationView` and the page `NotificationFeedView` are paired Exact, so a rename
 * or retype on either side fails the gate.
 */
type _notification = Assert<Exact<ApiNotificationView, WebNotificationView>>;
type _notificationFeed = Assert<Exact<ApiNotificationFeedView, WebNotificationFeedView>>;
/**
 * Public changelog (x160). `GET /v1/public/site/changelog` — a `@Public()` read of the GLOBAL
 * `changelog_entries` (0061), published entries newest-first grouped by month, read by
 * `ChangelogScreen`. Paired Exact with the web `PublicChangelogView`; the nested month/entry shapes
 * are inlined on both sides and no tenant id appears on either (the content belongs to no tenant).
 */
type _publicChangelog = Assert<Exact<ApiPublicChangelogView, WebPublicChangelogView>>;

/**
 * CAL recurrence (x129). `GET`/`POST .../meeting-series` — a tenant's recurring meeting series,
 * listed and created by `MeetingSeriesScreen`, and `GET .../:seriesId/occurrences` (a `{ seriesId,
 * occurrences: string[] }` shape with no named `*View`, so nothing to pair there). The series view is
 * paired Exact from the start — the screen and its `apps/web` shape ship in the same slice — so a
 * renamed or retyped field on either side is a compile error here. `freq` is the same
 * `daily|weekly|monthly` union on both sides.
 */
type _meetingSeries = Assert<Exact<ApiMeetingSeriesView, WebMeetingSeriesView>>;

/**
 * DOC-04 (x130). `DocumentTemplateVariableView` (`GET`/`POST …/document-templates/:templateId/
 * variables`) — one declared variable of a template. `DocumentTemplateVariablesScreen` reads exactly
 * this response, so the pair is Exact. `organizationId` is absent on both sides — the wire projection
 * never echoes the tenant id.
 */
type _documentTemplateVariable = Assert<
  Exact<ApiDocumentTemplateVariableView, WebDocumentTemplateVariableSummary>
>;

/**
 * Automations (x167). `AutomationScheduleView` (`GET …/automations/schedules`, `POST
 * …/automations/templates/:templateId/schedule`) — one scheduled trigger for a workflow template.
 * `AutomationSchedulesScreen` reads exactly this response, so the pair is Exact. `organizationId` is
 * absent on both sides — the wire projection never echoes the tenant id.
 */
type _automationSchedule = Assert<Exact<ApiAutomationScheduleView, WebAutomationScheduleSummary>>;

/** USAGE-001 slice 5 — `{ used, reserved, quota, unit: 'bytes', reconciledAt }` (§8, no web screen yet). */
type _usage = Assert<Exact<ApiUsageView, WebOrganizationUsage>>;

/**
 * INS-02 — `GET …/insights/projects/:projectId/approval-cycle`. A project's approvals rolled up by
 * terminal outcome (`approved`/`changes_requested`/`invalidated`): per outcome the count, the
 * decided count, and the summed requested→decided duration. Paired with a real web consumer —
 * INS-02 ships `InsightsApprovalCycleScreen`, so this is a live `Exact` pair, not an exemption.
 */
type _approvalCycle = Assert<Exact<ApiApprovalCycleView, WebApprovalCycle>>;

/**
 * ON-09 / ADM-10 import receipt (x104). The commit half (x100) shipped `ImportCommitView` /
 * `ImportCommitRowView` API-only (EXEMPT); the receipt read + `ImportReceiptScreen` now consume
 * them at `GET …/imports/:jobId/receipt`, so the pair is exact and the EXEMPT entries are retired.
 */
type _importReceipt = Assert<Exact<ApiImportCommitView, WebImportReceipt>>;
type _importReceiptRow = Assert<Exact<ApiImportCommitRowView, WebImportReceiptRow>>;

/**
 * INS-01 — `GET …/insights/projects/:projectId/delivery-flow`. A project's work items tallied by
 * workflow status (`backlog … archived`): `counts` per status and their `itemCount` sum. Paired
 * with a real web consumer — INS's third slice ships `InsightsScreen`, so this is a live `Exact`
 * pair, not an exemption. `counts` keys the domain `WorkItemState` union on both sides, so a
 * renamed or dropped status is a compile error here.
 */
type _deliveryFlow = Assert<Exact<ApiDeliveryFlowView, WebDeliveryFlow>>;

/**
 * INS-01 — `GET …/insights/portfolio` (x120). The org-level roll-up across the caller's accessible
 * projects: one row per project (id, name, and the delivery-flow + approval-cycle reads the
 * per-project screens show), with the readable-page count. Paired with a real web consumer —
 * `InsightsPortfolioScreen` replaces the `/insights` stub — so this is a live `Exact` pair. The
 * nested `deliveryFlow`/`approvalCycle` are the same shapes the two pairs above assert, so a drift
 * in either surfaces here too.
 */
type _insightsPortfolio = Assert<Exact<ApiInsightsPortfolioView, WebInsightsPortfolio>>;

/**
 * INS-05 — `GET …/insights/workload`. The org-wide workload/capacity portfolio roll-up: `projects`
 * (per-project open/scheduled item and distinct-assignee counts, heaviest first), `totals` (the
 * aggregate across them), and `computedAt`. Paired with a real web consumer — INS-05 appends the
 * workload section to `InsightsScreen`, so this is a live `Exact` pair, not an exemption.
 */
type _insightsWorkload = Assert<Exact<ApiInsightsWorkloadView, WebInsightsWorkloadView>>;

/**
 * INS-06 — `GET …/insights/adoption`. The org-wide adoption roll-up: `activeMembers`,
 * `membersWithWork` and `meetingsHeld` over a clamped `windowDays`, plus `computedAt`. Paired with a
 * real web consumer — INS-06 ships `InsightsAdoptionScreen`, so this is a live `Exact` pair, not an
 * exemption.
 */
type _insightsAdoption = Assert<Exact<ApiInsightsAdoptionView, WebInsightsAdoptionView>>;

/**
 * x134 — `GET …/insights/workload-forecast?weeks`. The forward-looking workload forecast: `weeks`
 * (per upcoming week the committed open work and constant capacity, with an over-capacity flag),
 * `totals` (the aggregate across the horizon), and `computedAt`. The `InsightsForecastScreen` reads
 * exactly this response, so this is a live `Exact` pair, not an exemption.
 */
type _workloadForecast = Assert<Exact<ApiWorkloadForecastView, WebWorkloadForecastView>>;

/**
 * x154 — `GET …/client-requests/aging`. The request-aging roll-up: `thresholds` (the fixed day
 * boundaries), `counts` (fresh/aging/overdue plus the uncommitted tally and total), `requests` (the
 * bounded, oldest-first aged rows), and `computedAt`. The `RequestAgingScreen` reads exactly this
 * response, so this is a live `Exact` pair, not an exemption.
 */
type _requestAging = Assert<Exact<ApiRequestAgingView, WebRequestAgingView>>;

// These three were `Narrows` — the API projection typed a lifecycle column as bare `string`
// while the web declared the union the column is actually constrained to (CONTRACT-001). The API
// side has since been tightened to the domain union at its projection, guarded where a raw
// `varchar` is read, so the pair is now `Exact`: a `state` the web's union does not contain can
// no longer be typed on the API view, and the gate catches it either way.

/** `WorkItemView.state` ↔ `WORK_ITEM_STATES` (`@tmanage/domain`). */
type _workItem = Assert<Exact<ApiWorkItemView, WebWorkItemSummary>>;

/**
 * x145. `WorkChecklistItemView` ↔ `WorkChecklistItem` — one work-item checklist / sub-item
 * (`GET`/`POST …/work-items/:id/checklist`, `PATCH …/checklist/:itemId`). `WorkChecklistPanel`
 * reads exactly this shape, so the `id`/`workItemId`/`label`/`done`/`position`/`createdAt` pair is
 * held identical on both sides.
 */
type _workChecklistItem = Assert<Exact<ApiWorkChecklistItemView, WebWorkChecklistItem>>;

/**
 * x147. `WorkCommentView` ↔ `WorkComment` — one work-item comment / activity entry
 * (`GET`/`POST …/work-items/:id/comments`). `WorkCommentsPanel` reads exactly this shape, so the
 * `id`/`workItemId`/`authorMembershipId`/`body`/`createdAt` pair is held identical on both sides.
 * Append-only: there is no edit or delete route, so no update shape to pair.
 */
type _workComment = Assert<Exact<ApiWorkCommentView, WebWorkComment>>;

/**
 * WORK intake forms (x146). `WorkFormView` (`GET`/`POST …/work-forms`, response) — an org-scoped
 * form definition. Paired with a live web consumer: `WorkFormsScreen` reads exactly this response to
 * list forms and drive the fill-to-create form. The `fields` element (`{ label, type, required }`)
 * and the `type` union (`text | number | date | checkbox`) are identical on both sides. The
 * submission response is the created work item, covered by the `WorkItemView`↔`WorkItemSummary` pair.
 */
type _workForm = Assert<Exact<ApiWorkFormView, WebWorkFormSummary>>;

/**
 * Automations & integrations (x162). `WorkflowTemplateView` (`GET`/`POST …/automations/templates`,
 * response) — an org-scoped automation template definition. Paired with a live web consumer:
 * `AutomationTemplatesScreen` reads exactly this response to list templates and drive the define form.
 * `triggerKind`/`actionKind` are `string` on both sides (the closed set is enforced server-side), and
 * `config` is an arbitrary object on both. `organizationId` is absent on both.
 */
type _workflowTemplate = Assert<Exact<ApiWorkflowTemplateView, WebWorkflowTemplateSummary>>;

/**
 * Automations & integrations (x163). `WorkflowRunView` (`POST …/automations/templates/:id/run`,
 * response) — the org-scoped record of one template execution. Paired with a live web consumer:
 * `AutomationRunButton` reads exactly this response to show the run's outcome. `status` is `string` on
 * both sides (the closed set is enforced server-side), `detail` is an arbitrary object on both, and
 * `organizationId` is absent on both.
 */
type _workflowRun = Assert<Exact<ApiWorkflowRunView, WebWorkflowRunSummary>>;

/**
 * Automations app directory (x165). `IntegrationConnectionView` (`GET`/`POST
 * …/automations/apps[/:appId/connections]`) — one recorded connection, and `IntegrationAppView` — a
 * catalog app with its connections merged. Paired Exact with the web consumer
 * (`IntegrationDirectoryScreen` via `lib/api/integration-directory`): the `status` union
 * (`connected | pending`), the `config` bag (`Record<string, string | number | boolean>`) and the
 * nested `connections` element are identical on both sides. `organizationId` is absent on both.
 */
type _integrationConnection = Assert<
  Exact<ApiIntegrationConnectionView, WebIntegrationConnectionView>
>;
type _integrationApp = Assert<Exact<ApiIntegrationAppView, WebIntegrationAppView>>;

/**
 * Automations webhooks (x166). `WebhookEndpointView` (`GET`/`POST …/automations/webhooks` and the
 * `PATCH …/webhooks/:id` response) — one org-scoped outbound webhook endpoint. Paired with a live web
 * consumer: `WebhookEndpointsScreen` reads exactly this response to list endpoints and toggle one.
 * Neither side carries `organizationId` or any secret field — the signing secret is stored hashed and
 * never projected — so this is a real `Exact` pair.
 */
type _webhookEndpoint = Assert<Exact<ApiWebhookEndpointView, WebWebhookEndpointSummary>>;

/**
 * SRCH-01 (x111). `SearchResultView` ↔ `SearchResult` — the unified global-search hit
 * (`GET …/search?q=`). Paired Exact, not exempt: SRCH-01 ships `SearchScreen`, a real web consumer,
 * so the `kind`/`id`/`title`/`projectId`/`snippet` shape and the `SearchResultKind` union are held
 * identical on both sides.
 */
type _searchResult = Assert<Exact<ApiSearchResultView, WebSearchResult>>;

/**
 * HOME-03 My Day. The response is one projection — its per-row entry is inlined on both sides
 * (an `MyDayEntry` API interface with no `View` suffix, an inline object on the web), so this
 * pair covers it structurally through the nested `WorkItemView`↔`WorkItemSummary` shape above.
 */
type _myDay = Assert<Exact<ApiMyDayView, WebMyDay>>;

/**
 * HOME-04 Waiting (x98 approvals; x102 client-wait + stale). `GET .../home/waiting` — approvals
 * pending on the caller as a reviewer, client requests awaiting their triage, and stale client
 * follow-ups. One projection; its per-row entry is a discriminated union inlined on both sides (a
 * `WaitingEntry = ApprovalWaitingEntry | ClientRequestWaitingEntry` API union with no `View`
 * suffix, an inline object union on the web), the `kind` discriminant keeping a later delegated
 * bucket an added arm, not a reshape. The `MyDayScreen` Waiting section reads exactly this
 * response, so the pair is Exact.
 */
type _waiting = Assert<Exact<ApiWaitingView, WebWaiting>>;

/**
 * HOME-01 hero summary (x102). `GET .../home/summary` — the derived counts the My Day hero shows,
 * aggregated by the API from the same My Day and Waiting reads. The `MyDayScreen` hero reads
 * exactly this response, so the pair is Exact.
 */
type _homeSummary = Assert<Exact<ApiHomeSummaryView, WebHomeSummary>>;

/**
 * HOME-01 Focus/Pulse summary (x143). `GET .../home/pulse` — the acting user's four headline counts
 * (open work, due today, waiting on you, meetings today), each gated per row by the API. The
 * `HomeHeroSection` reads exactly this response, so the pair is Exact.
 */
type _homePulse = Assert<Exact<ApiHomePulseView, WebHomePulse>>;

/**
 * HOME-05 saved/pinned context (x110). `GET/POST/DELETE .../home/saved-context` — the caller's pins
 * grouped by project. One projection; its group and item entries are inlined on both sides (an
 * `SavedContextView` API interface with no `View`-suffixed nested type, an inline object on the
 * web), so this pair covers them structurally, and the `entityType` union (`message|doc|work|file`)
 * must match exactly. The `MyDayScreen` Saved section reads exactly this response.
 */
type _savedContext = Assert<Exact<ApiSavedContextView, WebSavedContext>>;

/**
 * HOME-05 follow-up (x144). `GET/POST/DELETE .../home/pins` — the acting membership's Home pins,
 * newest first, distinct from the older per-user saved-context above. One projection; its per-pin
 * item is inlined on both sides (an inline object on the API's `HomePinView`, the same on the web),
 * so this pair covers it structurally, and the `targetKind` union (`work|project|document`) must
 * match exactly. The `MyDayScreen` Pinned section reads exactly this response.
 */
type _homePins = Assert<Exact<ApiHomePinView, WebHomePinView>>;

/**
 * Per-kind notification opt-out (x152). `GET .../notification-preferences/kinds` and
 * `PUT .../kinds/:kind` — the acting membership's per-kind settings, every kind present. One
 * projection; its per-kind item is inlined on both sides, so this pair covers it structurally, and
 * the `kind` union (`client_request|work_item|message|file`) must match exactly. The
 * `NotificationKindPrefs` screen reads exactly this response.
 */
type _notificationKindPrefs = Assert<
  Exact<ApiNotificationKindPrefView, WebNotificationKindPrefView>
>;

/**
 * Organization settings / policy (x153). `OrgSettingsView` (`GET/PUT …/settings`, response) — the
 * organization's allowlisted key/value settings. Paired with a live web consumer: `OrgSettingsScreen`
 * reads exactly this response to render one labelled field per setting. One projection; its per-entry
 * `{ key, value }` is inlined on both sides (an inline object on the API's `OrgSettingsView`, the same
 * on the web), so this pair covers it structurally. The wire projection never echoes the tenant id.
 */
type _orgSettings = Assert<Exact<ApiOrgSettingsView, WebOrgSettingsView>>;

/**
 * ON-10 guided-tour progress (x155). `GET .../onboarding/tour` and
 * `POST .../onboarding/tour/:step/complete` — the acting member's fixed guided tour, each step with
 * its completed flag. One projection; its per-step item is inlined on both sides, so this pair covers
 * it structurally, and the `step` union (`welcome|create_project|invite_team|explore_work|
 * share_portal`) must match exactly. The `OnboardingTourScreen` reads exactly this response.
 */
type _onboardingTour = Assert<Exact<ApiOnboardingTourView, WebOnboardingTourView>>;

/**
 * WK-04 (x94). `GET .../work-views/timeline/:projectId` — the accessible Work timeline. The
 * `WorkTimelineScreen` reads exactly this response, so the pair is Exact; the nested item's
 * `state` is the same `WORK_ITEM_STATES` union as the work list's.
 */
type _workTimeline = Assert<Exact<ApiWorkTimelineView, WebWorkTimelineView>>;

/**
 * WK-06 (x99). `GET .../work-views/workload/:projectId` — the accessible Work workload. The
 * `WorkWorkloadScreen` reads exactly this response, so the pair is Exact; each group's fields
 * (`ownerUserId`, `openItemCount`, `scheduledItemCount`) line up on both sides.
 */
type _workWorkload = Assert<Exact<ApiWorkloadView, WebWorkloadView>>;

/**
 * WK-05 (x103). `GET .../work-views/calendar/:projectId?from&to` — the accessible Work calendar.
 * The `WorkCalendarScreen` reads exactly this response, so the pair is Exact; the nested item's
 * `state` is the same `WORK_ITEM_STATES` union as the work list's and the timeline's.
 */
type _workCalendar = Assert<Exact<ApiWorkCalendarView, WebWorkCalendarView>>;

/**
 * WK-08 (x107). `GET/POST .../work-views/saved` and `PUT .../work-views/saved/:id` — the saved
 * Work view. `WorkSavedViewsScreen` reads exactly this response (config included), so the pair is
 * Exact; the nested `config` is the same filter/grouping/columns shape on both sides.
 */
type _savedView = Assert<Exact<ApiSavedViewView, WebSavedViewView>>;

/**
 * DOC-01 / DOC-03 (x106). `GET .../documents` (list) and `GET .../documents/:documentId` (read)
 * return `DocumentView`; the `DocsHubScreen` and `DocumentViewScreen` read exactly that shape, so
 * the pair is Exact. `organizationId` is on neither side — the API never echoes the tenant id
 * into a response body. This retired x91's EXEMPT entry for `DocumentView`.
 */
type _document = Assert<Exact<ApiDocumentView, WebDocumentView>>;

/** `ClientRequestView.state` ↔ the nine states of `23-ERD` §6. */
type _clientRequest = Assert<Exact<ApiClientRequestView, WebClientRequestRecord>>;

/** `InvitationView.status` ↔ `pending | accepted | expired | revoked`. */
type _invitation = Assert<Exact<ApiInvitationView, WebInvitationSummary>>;

/**
 * CONTRACT-001 remainder (x69). The client-request history screen renders a seven-field subset
 * of `AuditEventView`; the API view also carries `effectiveActorId`, `correlationId` and
 * `metadata`, which the screen does not read. Narrowing, not Exact — this un-stales the
 * `AuditEventView` EXEMPT entry, whose "no web consumer" reason is now false
 * (`GET .../client-requests/:id/history`, client-requests.controller.ts:315, serves this screen).
 */
type _clientRequestHistory = Assert<Narrows<ApiAuditEventView, WebClientRequestHistoryEntry>>;

/**
 * ADM audit viewer (x115). `GET .../audit/events` — the Administration audit-log read behind
 * `audit.read`. A **new** narrow projection, distinct from `AuditEventView`: seven fields
 * (id, occurredAt, actorId, action, entityType, entityId, summary) with no `metadata`,
 * `correlationId` or `effectiveActorId`, so a broad admin list cannot surface a producer's
 * payload (x49/x58 redaction). The `AdminAuditScreen` reads exactly this row, so the pair is
 * Exact. Named `AdminAuditEventView` on the API side to avoid clashing with the pre-existing
 * `AuditEventView`, which pairs (Narrows) the client-request history screen above.
 */
type _adminAudit = Assert<Exact<ApiAdminAuditEventView, WebAdminAuditEvent>>;

/**
 * CONTRACT-001 lift (x71). The seven pairs x69 left out. Five named their response type in the
 * owning service but not as an `export interface *View`, so the coverage guard could not see
 * them; each is now the service's declared return type under a `…View` name, renamed with no
 * change to the object any endpoint builds. Two — the session pair — describe the wire body the
 * controller serialises: `EstablishedSessionView`/`SessionSummaryView` carry the ISO-string dates
 * `JSON.stringify` already emits, distinct from the `Date`-typed internal projections of the same
 * name in `session.service.ts`/`sessions.repository.ts`, so the web shapes pair Exact.
 */

/** `POST …/messages/:id/work-items` — INT-07's convert-with-dedupe. */
type _convertMessage = Assert<Exact<ApiConvertMessageResultView, WebConvertMessageResult>>;

/** `POST …/client-requests/:id/acceptance` — REQ-002's accept-and-commit. */
type _acceptedClientRequest = Assert<Exact<ApiAcceptedClientRequestView, WebAcceptedClientRequest>>;

/** `POST …/invitations` — ON-04's issued token, shown once. */
type _issuedInvitation = Assert<Exact<ApiIssuedInvitationView, WebIssuedInvitation>>;

/** `POST /v1/invitations/previews` — ID-03's pre-acceptance preview. */
type _invitationPreview = Assert<Exact<ApiInvitationPreviewView, WebInvitationPreview>>;

/** `POST /v1/invitations/acceptances` — the membership an acceptance creates. */
type _acceptedInvitation = Assert<Exact<ApiAcceptedInvitationView, WebAcceptedInvitation>>;

/** `POST /v1/dev/sessions` and `POST /v1/sessions/refresh` — `{ csrfToken, expiresAt }`. */
type _establishedSession = Assert<Exact<ApiEstablishedSessionView, WebEstablishedSession>>;

/** `GET /v1/sessions/current/devices` — one device row, ISO-string dates on the wire. */
type _sessionSummary = Assert<Exact<ApiSessionSummaryView, WebSessionSummary>>;

/**
 * CONTRACT-001 class-1-lift (x79). The four controller-level response bodies x77 had to exempt
 * on the web side because their API interface was declared but not `export`ed: the member and
 * workspace directory rows, and the two arms of the sign-in response. Each interface is now
 * exported from the controller that serialises it — `EstablishedBody`/`ChallengeResponseBody`
 * renamed to the house `…View` suffix so the coverage gate enumerates them on the API side too —
 * with no change to the object any handler builds, so the web shapes pair Exact.
 */

/** `GET …/members` — one active-member directory row. */
type _member = Assert<Exact<ApiMemberView, WebMemberSummary>>;

/**
 * `GET …/members/:userId/offboarding-impact` and `POST …/members/:userId/offboard` — ADM-12/13
 * (x121). `OffboardingScreen` reads both responses exactly as the API projects them, so each pairs
 * Exact; `organizationId` is on neither side.
 */
type _offboardingImpact = Assert<Exact<ApiMemberOffboardingImpactView, WebOffboardingImpactView>>;
type _offboardedMember = Assert<Exact<ApiOffboardedMemberView, WebOffboardedMember>>;

/** `GET …/workspaces` — one workspace row, ISO-string `createdAt` on the wire. */
type _workspace = Assert<Exact<ApiWorkspaceView, WebWorkspaceSummary>>;

/**
 * Public & trust site (x159). `GET /v1/public/site/status` — the public status page: an overall
 * banner state and the recent published incidents, ISO-string dates on the wire. `StatusScreen`
 * reads exactly these responses, so both pairs are Exact; the `status`/`overall` unions are the same
 * on both sides.
 */
type _publicIncident = Assert<Exact<ApiPublicIncidentView, WebPublicIncidentView>>;
type _publicStatus = Assert<Exact<ApiPublicStatusView, WebPublicStatusView>>;

/** `POST /v1/auth/password|mfa|recovery-code` — the established-session arm. */
type _authenticated = Assert<Exact<ApiEstablishedView, WebAuthenticatedResponse>>;

/** `POST /v1/auth/password` — the MFA-required arm of the sign-in response. */
type _mfaRequired = Assert<Exact<ApiChallengeResponseView, WebMfaRequiredResponse>>;

/**
 * CONTRACT-001 class-3 (x78). Three response bodies that `apps/api` built as inline object
 * literals now have named, exported `*View` shapes beside the code that returns them, with no
 * change to the bytes any endpoint emits. Each is the wire shape (ISO-string dates where the
 * internal projection uses `Date`), so the web declarations pair Exact.
 *
 * A fourth — `RealtimeTicketView` (POST …/realtime/tickets) — is authored in
 * `realtime.controller.ts` because `RealtimeModule` has no service to hold it. x77 extended
 * `scripts/contracts-check.mjs` to enumerate controller-declared views, so the coverage guard
 * now sees it and it is paired Exact below (pass-10 integration reconcile).
 */

/** `GET /v1/organizations` — `ID-04`'s directory row. */
type _organizationSummary = Assert<Exact<ApiOrganizationSummaryView, WebOrganizationSummary>>;

/** `POST /v1/organizations` — `ON-01`'s created organization. */
type _createdOrganization = Assert<Exact<ApiCreatedOrganizationView, WebCreatedOrganization>>;

/** `GET /v1/auth/factors` — one enrolled MFA factor, `confirmedAt` an ISO string or `null`. */
type _enrolledFactor = Assert<Exact<ApiEnrolledFactorView, WebEnrolledFactor>>;

/** `POST …/realtime/tickets` — a minted realtime ticket; `expiresAt` an ISO string, `socketUrl` `null` where no live socket exists. */
type _realtimeTicket = Assert<Exact<ApiRealtimeTicketView, WebRealtimeTicket>>;

/**
 * CONTRACT-001 approvals (FR-05, x92). The `ApprovalDecisionView` pair.
 *
 * Request: `POST …/approvals/:approvalId/decision` — `{ decision: 'approve' | 'request_changes',
 * version: number, feedback?: string }`. Response: `ApprovalDecisionView` in
 * `apps/api/src/modules/approvals/approvals.service.ts` — the immutable decision record
 * (`decidedByUserId`, `decidedAt`, `contentHash`, `state`), decision fields null until decided.
 *
 * No `Assert<Exact<…>>` pair yet: there is no web consumer this slice, so `ApprovalDecisionView`
 * is carried in `scripts/contracts-check.mjs`'s EXEMPT list, matching x86's `ProjectHealthView`
 * posture. x92-b adds the client deep-link decision screen and its `apps/web` shape, and this
 * comment becomes a real `Assert<Exact<ApiApprovalDecisionView, WebApprovalDecision>>` then.
 *
 * CONTRACT-001 (ON-09, x95) — the onboarding-import validate/dry-run pair, recorded here but
 * not asserted against an `apps/web` type: there is no web consumer this slice (the ON-09 screen
 * is a follow-up), so `ImportValidationView` is carried in `scripts/contracts-check.mjs` EXEMPT
 * rather than paired. This block is the documented shape both sides must match when the screen
 * lands; pair it with the web declaration then and retire the exemption.
 *
 * Request  `POST /v1/organizations/:orgSlug/imports/validations` (`org.manage`), body
 *          `{ sourceKind: 'project', mapping: Record<targetField, sourceColumn>, rows: object[] }`
 *          (`ImportValidationRequest` in import.service.ts; bounded/parsed by
 *          `parseImportValidationBody`, MAX_IMPORT_ROWS rows).
 * Response `ImportValidationView` — `{ jobId, sourceKind, status: 'validated' |
 *          'validated_with_errors', totalCount, validCount, invalidCount, errors: { row, errors:
 *          { field, message }[] }[] }`. Commits no target entity; `jobId` is the persisted
 *          `import_jobs` anchor.
 */

/**
 * DocumentView (DOC-01/DOC-03, x106), MeetingNoteView (CAL-01/MTG-01, x108) and MeetingView
 * (CAL-01/MTG-01, x122) are now paired above (`_document`, `_meetingNote`, `_meeting`); their
 * earlier EXEMPT notes were retired when their screens landed.
 */

/**
 * CONTRACT-001 client projection (FR-05, x97). The `ClientProjectionView` pair.
 *
 * Request: `POST …/approvals/projections` — `{ deliverableVersionId: string, projection: {…} }`
 * (the allowlisted client-safe payload, 12-PERMISSION-MATRIX §1). Read:
 * `GET …/approvals/projections/:deliverableVersionId`. Response: `ClientProjectionView` in
 * `apps/api/src/modules/approvals/approvals.service.ts` — the immutable client projection
 * (`contentHash`, `projection`, `publishedByUserId`, `publishedAt`).
 *
 * x101 adds the client deep-link screen that renders it (`ClientApprovalScreen`) and its `apps/web`
 * shape `ClientApprovalView`, so `ClientProjectionView` leaves the EXEMPT list and is paired Exact
 * here. `ApprovalDecisionView` stays exempt: it is the internal reviewer decide record, and x101
 * ships only the *client* decide, whose response is the separate client-safe `ClientDecideView`.
 */

/** `GET …/approvals/projections/:deliverableVersionId` — the immutable client projection the deep-link screen renders. */
type _clientProjection = Assert<Exact<ApiClientProjectionView, WebClientApprovalView>>;

/**
 * `POST …/approvals/projections/:deliverableVersionId/decision` — FR-05's client decide (x101).
 *
 * Request: `{ decision: 'approve' | 'request_changes', feedback?: string }`. Response: the
 * client-safe `ClientDecideView` — the version decided on, the resulting lifecycle `state`,
 * `decidedAt` (ISO string), and the change-request note — never the internal `ApprovalDecisionView`.
 */
type _clientDecide = Assert<Exact<ApiClientDecideView, WebClientDecideResult>>;

/**
 * `GET /v1/public/site/trust` — the public security & trust page (x158, module 1).
 *
 * Public and tenant-less: deterministic code-defined copy (controls, data handling, subprocessors,
 * compliance posture, and the path to the status page). The `PublicTrustView` pair keeps the copy
 * the API serves and the copy the screen renders from drifting into two security postures.
 */
type _publicTrust = Assert<Exact<ApiPublicTrustView, WebPublicTrustView>>;
/**
 * `POST /public/site/contact` — the public site's contact / lead intake (module 1, x161).
 *
 * The only unauthenticated write in the public site. Its response is a bare acknowledgement that
 * reflects nothing stored — `{ status: 'received' }` — so the API `ContactSubmitView` and the web
 * `ContactSubmitView` pair Exact. The request body (`ContactSubmitInput`) is request-side and is
 * dropped by `contracts-check`'s `Input` suffix rule.
 */
type _contactSubmit = Assert<Exact<ApiContactSubmitView, WebContactSubmitView>>;
