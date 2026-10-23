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
import type { A11yPreferencesView as ApiA11yPreferencesView } from '../../apps/api/src/modules/preferences/a11y.controller.js';
import type { DisplayPreferencesView as ApiDisplayPreferencesView } from '../../apps/api/src/modules/preferences/display-prefs.service.js';
import type { InsightSavedViewView as ApiInsightSavedViewView } from '../../apps/api/src/modules/insights/saved-views.controller.js';
import type {
  InsightCustomReportView as ApiInsightCustomReportView,
  InsightCustomReportRenderedView as ApiInsightCustomReportRenderedView,
} from '../../apps/api/src/modules/insights/custom-reports.controller.js';
import type { ReportScheduleView as ApiReportScheduleView } from '../../apps/api/src/modules/insights/report-schedules.controller.js';
import type { QuietHoursView as ApiQuietHoursView } from '../../apps/api/src/modules/preferences/quiet-hours.controller.js';
import type { QuietHoursActiveView as ApiQuietHoursActiveView } from '../../apps/api/src/modules/preferences/quiet-hours.controller.js';
import type { DigestPrefView as ApiDigestPrefView } from '../../apps/api/src/modules/preferences/digest.controller.js';
import type { ShortcutMapView as ApiShortcutMapView } from '../../apps/api/src/modules/preferences/shortcut-prefs.controller.js';
import type { ShortcutView as ApiShortcutView } from '../../apps/api/src/modules/preferences/shortcut-prefs.controller.js';
import type { ResolvedShortcutView as ApiResolvedShortcutView } from '../../apps/api/src/modules/preferences/shortcut-prefs.service.js';
import type { AcceptedInvitationView as ApiAcceptedInvitationView } from '../../apps/api/src/modules/tenancy/invitations.service.js';
import type { AuditEventView as ApiAuditEventView } from '../../apps/api/src/modules/audit/audit.service.js';
import type { AdminAuditEventView as ApiAdminAuditEventView } from '../../apps/api/src/modules/audit/audit.service.js';
import type { AdminOverviewView as ApiAdminOverviewView } from '../../apps/api/src/modules/admin/overview.controller.js';
import type { OrgBrandingView as ApiOrgBrandingView } from '../../apps/api/src/modules/admin/org-branding.controller.js';
import type { ChallengeResponseView as ApiChallengeResponseView } from '../../apps/api/src/modules/identity/authentication.controller.js';
import type { ClientDecideView as ApiClientDecideView } from '../../apps/api/src/modules/approvals/approvals.service.js';
import type { ClientProjectionView as ApiClientProjectionView } from '../../apps/api/src/modules/approvals/approvals.service.js';
import type { ClientRequestClientView as ApiClientRequestClientView } from '../../apps/api/src/modules/requests/client-requests.service.js';
import type { ClientRequestView as ApiClientRequestView } from '../../apps/api/src/modules/requests/client-requests.service.js';
import type { ConversationView as ApiConversationView } from '../../apps/api/src/modules/conversations/conversations.service.js';
import type { ConvertMessageResultView as ApiConvertMessageResultView } from '../../apps/api/src/modules/conversations/conversations.service.js';
import type {
  ThreadReplyView as ApiThreadReplyView,
  ThreadView as ApiThreadView,
} from '../../apps/api/src/modules/conversations/thread-replies.service.js';
import type { CreatedOrganizationView as ApiCreatedOrganizationView } from '../../apps/api/src/modules/tenancy/provisioning.service.js';
import type { AddressAvailabilityView as ApiAddressAvailabilityView } from '../../apps/api/src/modules/tenancy/organizations.controller.js';
import type { DocumentView as ApiDocumentView } from '../../apps/api/src/modules/docs/documents.service.js';
import type { DocumentVersionView as ApiDocumentVersionView } from '../../apps/api/src/modules/docs/documents.service.js';
import type { DocRevisionView as ApiDocRevisionView } from '../../apps/api/src/modules/docs/revisions.service.js';
import type { DocBookmarkView as ApiDocBookmarkView } from '../../apps/api/src/modules/docs/bookmarks.service.js';
import type { InboxSavedFilterView as ApiInboxSavedFilterView } from '../../apps/api/src/modules/inbox/inbox-saved-filters.service.js';
import type { GlossaryTermView as ApiGlossaryTermView } from '../../apps/api/src/modules/docs/glossary.service.js';
import type {
  CollectionView as ApiCollectionView,
  CollectionDocumentView as ApiCollectionDocumentView,
} from '../../apps/api/src/modules/docs/collections.service.js';
import type { ProjectFavoriteView as ApiProjectFavoriteView } from '../../apps/api/src/modules/projects/project-favorites.service.js';
import type {
  DocTagView as ApiDocTagView,
  DocumentTagView as ApiDocumentTagView,
} from '../../apps/api/src/modules/docs/doc-tags.service.js';
import type { DocLinkView as ApiDocLinkView } from '../../apps/api/src/modules/docs/doc-links.service.js';
import type { DocReadStateView as ApiDocReadStateView } from '../../apps/api/src/modules/docs/doc-read-state.service.js';
import type { MetricFavoriteView as ApiMetricFavoriteView } from '../../apps/api/src/modules/insights/metric-favorites.service.js';
import type { DocSubscriptionView as ApiDocSubscriptionView } from '../../apps/api/src/modules/docs/subscriptions.service.js';
import type { DocumentCommentView as ApiDocumentCommentView } from '../../apps/api/src/modules/docs/document-comments.service.js';
import type { DocReviewView as ApiDocReviewView } from '../../apps/api/src/modules/docs/reviews.service.js';
import type { DecisionView as ApiDecisionView } from '../../apps/api/src/modules/decisions/decisions.service.js';
import type { DecisionDetailView as ApiDecisionDetailView } from '../../apps/api/src/modules/decisions/decisions.service.js';
import type { DecisionLockView as ApiDecisionLockView } from '../../apps/api/src/modules/decisions/decisions.service.js';
import type { DecisionCommentView as ApiDecisionCommentView } from '../../apps/api/src/modules/decisions/comments.service.js';
import type { InvoiceView as ApiInvoiceView } from '../../apps/api/src/modules/billing/invoices.controller.js';
import type { InvoiceDetailView as ApiInvoiceDetailView } from '../../apps/api/src/modules/billing/invoices.controller.js';
import type { InvoiceLineItemView as ApiInvoiceLineItemView } from '../../apps/api/src/modules/billing/invoice-line-items.controller.js';
import type { InvoiceLinesView as ApiInvoiceLinesView } from '../../apps/api/src/modules/billing/invoice-line-items.controller.js';
import type { DocumentTemplateView as ApiDocumentTemplateView } from '../../apps/api/src/modules/docs/documents.service.js';
import type { DocumentTemplateVariableView as ApiDocumentTemplateVariableView } from '../../apps/api/src/modules/docs/document-template-variables.controller.js';
import type { AutomationScheduleView as ApiAutomationScheduleView } from '../../apps/api/src/modules/automations/schedules.controller.js';
import type {
  UsageAlertView as ApiUsageAlertView,
  UsageAlertStatusView as ApiUsageAlertStatusView,
} from '../../apps/api/src/modules/billing/usage-alerts.service.js';
import type { UsageExportView as ApiUsageExportView } from '../../apps/api/src/modules/billing/usage-export.service.js';
import type { CostCenterView as ApiCostCenterView } from '../../apps/api/src/modules/billing/cost-centers.service.js';
import type { CostCenterReportRowView as ApiCostCenterReportRowView } from '../../apps/api/src/modules/billing/cost-center-report.service.js';
import type { EnrolledFactorView as ApiEnrolledFactorView } from '../../apps/api/src/modules/identity/authentication.service.js';
import type { EstablishedSessionView as ApiEstablishedSessionView } from '../../apps/api/src/modules/identity/session.service.js';
import type { EstablishedView as ApiEstablishedView } from '../../apps/api/src/modules/identity/authentication.controller.js';
import type { ContactSubmitView as ApiContactSubmitView } from '../../apps/api/src/modules/public-site/contact.controller.js';
import type {
  FirstOwnerAvailabilityView as ApiFirstOwnerAvailabilityView,
  FirstOwnerSetupView as ApiFirstOwnerSetupView,
} from '../../apps/api/src/modules/setup/first-owner.service.js';
import type {
  PublicSignupAvailabilityView as ApiPublicSignupAvailabilityView,
  PublicSignupView as ApiPublicSignupView,
} from '../../apps/api/src/modules/signup/public-signup.service.js';
import type {
  PlatformMeView as ApiPlatformMeView,
  PlatformOverviewView as ApiPlatformOverviewView,
  PlatformCompanyView as ApiPlatformCompanyView,
  PlatformCompanyAuditView as ApiPlatformCompanyAuditView,
  PlatformCompanyDetailView as ApiPlatformCompanyDetailView,
  PlatformPersonView as ApiPlatformPersonView,
  PlatformSettingsView as ApiPlatformSettingsView,
  PlatformAuditEventView as ApiPlatformAuditEventView,
} from '../../apps/api/src/modules/platform-admin/platform-admin.service.js';
import type {
  StorageStatusView as ApiStorageStatusView,
  DriveAttachmentView as ApiDriveAttachmentView,
  PickerSessionView as ApiPickerSessionView,
} from '../../apps/api/src/modules/google-drive/google-drive.service.js';
import type { ConsentView as ApiConsentView } from '../../apps/api/src/modules/oauth/consent.controller.js';
import type {
  ConnectedAppView as ApiConnectedAppView,
  ConnectedAppsView as ApiConnectedAppsView,
} from '../../apps/api/src/modules/oauth/grants.service.js';
import type { PendingAiActionView as ApiPendingAiActionView } from '../../apps/api/src/modules/mcp/pending-actions.service.js';
import type {
  GoogleAvailabilityView as ApiGoogleAvailabilityView,
  GooglePendingMfaView as ApiGooglePendingMfaView,
  GoogleStartView as ApiGoogleStartView,
} from '../../apps/api/src/modules/google-auth/google-auth.controller.js';
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
import type { UserPreferencesView as ApiUserPreferencesView } from '../../apps/api/src/modules/preferences/preferences.controller.js';
import type { HomeWidgetPrefsView as ApiHomeWidgetPrefsView } from '../../apps/api/src/modules/home/widget-prefs.controller.js';
import type { InvitationPreviewView as ApiInvitationPreviewView } from '../../apps/api/src/modules/tenancy/invitations.service.js';
import type { InvitationRegistrationView as ApiInvitationRegistrationView } from '../../apps/api/src/modules/tenancy/invitations.controller.js';
import type { PasswordResetRequestedView as ApiPasswordResetRequestedView } from '../../apps/api/src/modules/identity/password-reset.controller.js';
import type { PasswordResetRequestedView as WebPasswordResetRequestedView } from '../../apps/web/src/lib/api/password-reset';
import type { InvitationView as ApiInvitationView } from '../../apps/api/src/modules/tenancy/invitations.service.js';
import type { IssuedInvitationView as ApiIssuedInvitationView } from '../../apps/api/src/modules/tenancy/invitations.service.js';
import type { MeetingNoteView as ApiMeetingNoteView } from '../../apps/api/src/modules/calendar/meetings.service.js';
import type { MeetingView as ApiMeetingView } from '../../apps/api/src/modules/calendar/meetings.service.js';
import type { MeetingAttendeeView as ApiMeetingAttendeeView } from '../../apps/api/src/modules/calendar/meeting-attendees.service.js';
import type { MeetingClientAttendeeView as ApiMeetingClientAttendeeView } from '../../apps/api/src/modules/calendar/meeting-attendees.service.js';
import type { ClientAttendeeCandidateView as ApiClientAttendeeCandidateView } from '../../apps/api/src/modules/calendar/meeting-attendees.service.js';
import type { MeetingActionItemView as ApiMeetingActionItemView } from '../../apps/api/src/modules/calendar/meeting-action-items.service.js';
import type { MeetingRsvpView as ApiMeetingRsvpView } from '../../apps/api/src/modules/calendar/rsvp.service.js';
import type { MeetingTimePollView as ApiMeetingTimePollView } from '../../apps/api/src/modules/calendar/time-poll.service.js';
import type { MeetingAgendaView as ApiMeetingAgendaView } from '../../apps/api/src/modules/calendar/meeting-agenda.controller.js';
import type { CalendarGridView as ApiCalendarGridView } from '../../apps/api/src/modules/calendar/grid.service.js';
import type {
  NotificationView as ApiNotificationView,
  NotificationFeedView as ApiNotificationFeedView,
} from '../../apps/api/src/modules/notifications/notifications-feed.controller.js';
import type { MeetingSeriesView as ApiMeetingSeriesView } from '../../apps/api/src/modules/calendar/meeting-series.service.js';
import type { AgendaTemplateView as ApiAgendaTemplateView } from '../../apps/api/src/modules/calendar/agenda-templates.service.js';
import type { OccurrenceOverrideView as ApiOccurrenceOverrideView } from '../../apps/api/src/modules/calendar/occurrence-override.service.js';
import type { MemberView as ApiMemberView } from '../../apps/api/src/modules/tenancy/members.controller.js';
import type { PersonDirectoryView as ApiPersonDirectoryView } from '../../apps/api/src/modules/people/directory.controller.js';
import type {
  MemberOffboardingImpactView as ApiMemberOffboardingImpactView,
  OffboardedMemberView as ApiOffboardedMemberView,
} from '../../apps/api/src/modules/tenancy/offboarding.service.js';
import type { MessageRevisionView as ApiMessageRevisionView } from '../../apps/api/src/modules/conversations/conversations.service.js';
import type { MessageView as ApiMessageView } from '../../apps/api/src/modules/conversations/conversations.service.js';
import type { MessageReactionTallyView as ApiMessageReactionTallyView } from '../../apps/api/src/modules/conversations/message-reactions.service.js';
import type { PinnedMessageView as ApiPinnedMessageView } from '../../apps/api/src/modules/conversations/message-pins.service.js';
import type { SavedMessageView as ApiSavedMessageView } from '../../apps/api/src/modules/conversations/message-bookmarks.service.js';
import type { MentionView as ApiMentionView } from '../../apps/api/src/modules/conversations/my-mentions.service.js';
import type { MessageAttachmentView as ApiMessageAttachmentView } from '../../apps/api/src/modules/conversations/message-attachments.service.js';
import type { OrganizationSummaryView as ApiOrganizationSummaryView } from '../../apps/api/src/modules/tenancy/provisioning.service.js';
import type { PortalFileView as ApiPortalFileView } from '../../apps/api/src/modules/files/portal-file-list.service.js';
import type { PortalInboxBundleView as ApiPortalInboxBundleView } from '../../apps/api/src/modules/inbox/portal-inbox.service.js';
import type { PortalInboxPageView as ApiPortalInboxPageView } from '../../apps/api/src/modules/inbox/portal-inbox.service.js';
import type { PortalProjectView as ApiPortalProjectView } from '../../apps/api/src/modules/clients/portal.service.js';
import type { PortalUpdateView as ApiPortalUpdateView } from '../../apps/api/src/modules/clients/portal.service.js';
import type { UpdateEditView as ApiUpdateEditView } from '../../apps/api/src/modules/clients/portal.service.js';
// A10: the internal updates list (published card + unpublish confirm).
import type { ManagedUpdateView as ApiManagedUpdateView } from '../../apps/api/src/modules/clients/portal.service.js';
import type { ManagedUpdate as WebManagedUpdate } from '../../apps/web/src/lib/api/managed-updates';
import type { PortalPersonView as ApiPortalPersonView } from '../../apps/api/src/modules/clients/portal-people.repository.js';
import type { PortalWorkItemView as ApiPortalWorkItemView } from '../../apps/api/src/modules/clients/portal.service.js';
import type { PortalDeliverableView as ApiPortalDeliverableView } from '../../apps/api/src/modules/clients/portal.service.js';
import type { PortalDeliverableFileView as ApiPortalDeliverableFileView } from '../../apps/api/src/modules/clients/portal.service.js';
import type { UpdateCommentView as ApiUpdateCommentView } from '../../apps/api/src/modules/clients/update-comments.service.js';
import type { ClientUpdateCommentView as ApiClientUpdateCommentView } from '../../apps/api/src/modules/clients/update-comments.service.js';
import type { PortalAnnouncementView as ApiPortalAnnouncementView } from '../../apps/api/src/modules/clients/portal-announcements.service.js';
import type { ClientPortalAnnouncementView as ApiClientPortalAnnouncementView } from '../../apps/api/src/modules/clients/portal-announcements.service.js';
import type { ClientMessageView as ApiClientMessageView } from '../../apps/api/src/modules/clients/client-messages.service.js';
import type { AdminClientMessageView as ApiAdminClientMessageView } from '../../apps/api/src/modules/clients/client-messages.service.js';
import type { ProjectMilestoneView as ApiProjectMilestoneView } from '../../apps/api/src/modules/clients/project-milestones.projection.js';
import type { ClientMilestoneView as ApiClientMilestoneView } from '../../apps/api/src/modules/clients/project-milestones.projection.js';
import type { MilestoneEditView as ApiMilestoneEditView } from '../../apps/api/src/modules/clients/milestone-lifecycle.controller.js';
import type { ProjectRiskView as ApiProjectRiskView } from '../../apps/api/src/modules/clients/project-risks.controller.js';
import type { PortalAccessLogView as ApiPortalAccessLogView } from '../../apps/api/src/modules/clients/portal-access-log.controller.js';
import type { ClientRiskView as ApiClientRiskView } from '../../apps/api/src/modules/clients/project-risks.controller.js';
import type { PortalSettingsView as ApiPortalSettingsView } from '../../apps/api/src/modules/clients/portal-settings.controller.js';
import type { ProjectClientView as ApiProjectClientView } from '../../apps/api/src/modules/clients/clients.service.js';
import type {
  ClientMembershipView as ApiClientMembershipView,
  ClientOrganizationView as ApiClientOrganizationView,
} from '../../apps/api/src/modules/clients/clients.service.js';
import type { ProjectMemberView as ApiProjectMemberView } from '../../apps/api/src/modules/projects/project-members.controller.js';
import type { ProjectView as ApiProjectView } from '../../apps/api/src/modules/projects/projects.service.js';
import type { PublicHomeView as ApiPublicHomeView } from '../../apps/api/src/modules/public-site/public-content.service.js';
import type { PublicFaqView as ApiPublicFaqView } from '../../apps/api/src/modules/public-site/faq.service.js';
import type {
  PublicResourceListView as ApiPublicResourceListView,
  PublicResourceView as ApiPublicResourceView,
} from '../../apps/api/src/modules/public-site/public-content.service.js';
import type { ProjectObjectiveView as ApiProjectObjectiveView } from '../../apps/api/src/modules/projects/project-objectives.service.js';
import type { ProjectInternalRiskView as ApiProjectInternalRiskView } from '../../apps/api/src/modules/projects/risk-register.service.js';
import type { ProjectTemplateView as ApiProjectTemplateView } from '../../apps/api/src/modules/projects/templates.service.js';
import type {
  ProjectStatusUpdatePageView as ApiProjectStatusUpdatePageView,
  ProjectStatusUpdateView as ApiProjectStatusUpdateView,
} from '../../apps/api/src/modules/projects/status-updates.service.js';
import type { OrgObjectiveView as ApiOrgObjectiveView } from '../../apps/api/src/modules/projects/org-objectives.service.js';
import type { ProjectPortfolioView as ApiProjectPortfolioView } from '../../apps/api/src/modules/projects/portfolio.service.js';
import type { ProjectHealthView as ApiProjectHealthView } from '../../apps/api/src/modules/projects/health.service.js';
import type { PublicPlanView as ApiPublicPlanView } from '../../apps/api/src/modules/public-site/plan-catalog.service.js';
import type { ObjectiveWorkLinkView as ApiObjectiveWorkLinkView } from '../../apps/api/src/modules/projects/objective-work-links.service.js';
import type { MilestoneLinkView as ApiMilestoneLinkView } from '../../apps/api/src/modules/projects/milestone-links.service.js';
import type { KeyResultView as ApiKeyResultView } from '../../apps/api/src/modules/projects/key-results.service.js';
import type { DecisionWorkLinkView as ApiDecisionWorkLinkView } from '../../apps/api/src/modules/decisions/decision-work-links.service.js';
import type { PersonAllocationView as ApiPersonAllocationView } from '../../apps/api/src/modules/people/allocations.controller.js';
import type { SearchResultView as ApiSearchResultView } from '../../apps/api/src/modules/search/search.service.js';
import type { CommandView as ApiCommandView } from '../../apps/api/src/modules/search/commands.controller.js';
import type { CopilotAnswerView as ApiCopilotAnswerView } from '../../apps/api/src/modules/copilot/copilot.service.js';
import type { RealtimeTicketView as ApiRealtimeTicketView } from '../../apps/api/src/modules/realtime/realtime.controller.js';
import type { SessionSummaryView as ApiSessionSummaryView } from '../../apps/api/src/modules/identity/session.service.js';
import type { UsageView as ApiUsageView } from '../../apps/api/src/modules/files/usage.service.js';
import type { SubscriptionView as ApiSubscriptionView } from '../../apps/api/src/modules/billing/subscription.service.js';
import type { PlanChangePreviewView as ApiPlanChangePreviewView } from '../../apps/api/src/modules/billing/plan-preview.service.js';
import type { ApprovalCycleView as ApiApprovalCycleView } from '../../apps/api/src/modules/insights/insights.service.js';
import type { DeliveryFlowView as ApiDeliveryFlowView } from '../../apps/api/src/modules/insights/insights.service.js';
import type { InsightsPortfolioView as ApiInsightsPortfolioView } from '../../apps/api/src/modules/insights/insights.service.js';
import type { InsightsWorkloadView as ApiInsightsWorkloadView } from '../../apps/api/src/modules/insights/insights.service.js';
import type { InsightsAdoptionView as ApiInsightsAdoptionView } from '../../apps/api/src/modules/insights/adoption.controller.js';
import type { SnapshotView as ApiSnapshotView } from '../../apps/api/src/modules/insights/snapshots.service.js';
import type { PeriodComparisonView as ApiPeriodComparisonView } from '../../apps/api/src/modules/insights/comparison.service.js';
import type { MetricTargetView as ApiMetricTargetView } from '../../apps/api/src/modules/insights/targets.service.js';
import type { MetricTargetStatusView as ApiMetricTargetStatusView } from '../../apps/api/src/modules/insights/targets.service.js';
import type { InsightAnnotationView as ApiInsightAnnotationView } from '../../apps/api/src/modules/insights/insight-annotations.service.js';
import type { MetricAlertView as ApiMetricAlertView } from '../../apps/api/src/modules/insights/metric-alerts.service.js';
import type { MetricAlertStatusView as ApiMetricAlertStatusView } from '../../apps/api/src/modules/insights/metric-alerts.service.js';
import type { WorkloadForecastView as ApiWorkloadForecastView } from '../../apps/api/src/modules/insights/workload-forecast.service.js';
import type { InsightDashboardLayoutView as ApiInsightDashboardLayoutView } from '../../apps/api/src/modules/insights/dashboard-layout.controller.js';
import type { RequestAgingView as ApiRequestAgingView } from '../../apps/api/src/modules/requests/request-aging.controller.js';
import type { RequestTriageView as ApiRequestTriageView } from '../../apps/api/src/modules/requests/request-triage.controller.js';
import type { RequestCommentView as ApiRequestCommentView } from '../../apps/api/src/modules/requests/request-comments.service.js';
import type { RequestTagsView as ApiRequestTagsView } from '../../apps/api/src/modules/requests/request-tags.controller.js';
import type { PublicChangelogView as ApiPublicChangelogView } from '../../apps/api/src/modules/public-site/changelog.controller.js';
import type { PersonProfileView as ApiPersonProfileView } from '../../apps/api/src/modules/people/profile.controller.js';
import type { MemberProfileView as ApiMemberProfileView } from '../../apps/api/src/modules/people/member-profile.controller.js';
import type { MyProfileView as ApiMyProfileView } from '../../apps/api/src/modules/people/my-profile.controller.js';
import type {
  TeamView as ApiTeamView,
  TeamMemberView as ApiTeamMemberView,
  TeamDetailView as ApiTeamDetailView,
} from '../../apps/api/src/modules/people/teams.controller.js';
import type { WorkItemView as ApiWorkItemView } from '../../apps/api/src/modules/work/work-items.service.js';
import type { BulkTransitionView as ApiBulkTransitionView } from '../../apps/api/src/modules/work/bulk-transition.service.js';
import type { WorkChecklistItemView as ApiWorkChecklistItemView } from '../../apps/api/src/modules/work/work-checklist.service.js';
import type {
  WorkSubtaskView as ApiWorkSubtaskView,
  WorkSubtaskListView as ApiWorkSubtaskListView,
} from '../../apps/api/src/modules/work/subtasks.service.js';
import type { WorkCommentView as ApiWorkCommentView } from '../../apps/api/src/modules/work/work-comments.service.js';
import type { WorkItemLinkView as ApiWorkItemLinkView } from '../../apps/api/src/modules/work/item-links.service.js';
import type { WorkRelationsGraphView as ApiWorkRelationsGraphView } from '../../apps/api/src/modules/work/relations-graph.service.js';
import type { ItemFileView as ApiItemFileView } from '../../apps/api/src/modules/work/item-files.service.js';
import type {
  TimeLogView as ApiTimeLogView,
  TimeLogListView as ApiTimeLogListView,
} from '../../apps/api/src/modules/work/time-logs.service.js';
import type { WorkItemEstimateView as ApiWorkItemEstimateView } from '../../apps/api/src/modules/work/item-estimate.service.js';
import type { ItemWatcherView as ApiItemWatcherView } from '../../apps/api/src/modules/work/watchers.service.js';
import type { WorkActivityEntryView as ApiWorkActivityEntryView } from '../../apps/api/src/modules/work/activity-log.service.js';
import type {
  WorkItemReminderView as ApiWorkItemReminderView,
  DueReminderView as ApiDueReminderView,
} from '../../apps/api/src/modules/work/item-reminders.service.js';
import type {
  ItemLabelView as ApiItemLabelView,
  WorkLabelView as ApiWorkLabelView,
} from '../../apps/api/src/modules/work/work-labels.service.js';
import type {
  WorkCustomFieldDefinitionView as ApiWorkCustomFieldDefinitionView,
  WorkCustomFieldValueView as ApiWorkCustomFieldValueView,
} from '../../apps/api/src/modules/work/custom-fields.service.js';
import type {
  WorkItemRecurrenceView as ApiWorkItemRecurrenceView,
  NextOccurrenceView as ApiNextOccurrenceView,
} from '../../apps/api/src/modules/work/item-recurrence.service.js';
import type {
  ProjectTagView as ApiProjectTagView,
  ProjectTagAssignmentView as ApiProjectTagAssignmentView,
} from '../../apps/api/src/modules/projects/project-tags.service.js';
import type {
  FileTagView as ApiFileTagView,
  FileTagAssignmentView as ApiFileTagAssignmentView,
} from '../../apps/api/src/modules/files/file-tags.service.js';
import type {
  ChecklistTemplateView as ApiChecklistTemplateView,
  ApplyTemplateResultView as ApiApplyTemplateResultView,
} from '../../apps/api/src/modules/work/checklist-templates.service.js';
import type { BoardColumnView as ApiBoardColumnView } from '../../apps/api/src/modules/work/board-columns.service.js';
import type {
  FileFolderView as ApiFileFolderView,
  FileFolderPlacementView as ApiFileFolderPlacementView,
} from '../../apps/api/src/modules/files/folders.service.js';
import type { FileCommentView as ApiFileCommentView } from '../../apps/api/src/modules/files/comments.service.js';
import type { WorkFormView as ApiWorkFormView } from '../../apps/api/src/modules/work/work-forms.controller.js';
import type { WorkflowTemplateView as ApiWorkflowTemplateView } from '../../apps/api/src/modules/automations/templates.controller.js';
import type { WorkflowRunView as ApiWorkflowRunView } from '../../apps/api/src/modules/automations/run.controller.js';
import type { IntegrationAppView as ApiIntegrationAppView } from '../../apps/api/src/modules/automations/directory.controller.js';
import type { IntegrationConnectionView as ApiIntegrationConnectionView } from '../../apps/api/src/modules/automations/directory.controller.js';
import type { ConnectionHealthView as ApiConnectionHealthView } from '../../apps/api/src/modules/automations/connection-health.controller.js';
import type { WebhookEndpointView as ApiWebhookEndpointView } from '../../apps/api/src/modules/automations/webhooks.controller.js';
import type { WebhookDeliveryView as ApiWebhookDeliveryView } from '../../apps/api/src/modules/automations/webhook-deliveries.controller.js';
import type { WorkflowRunHistoryView as ApiWorkflowRunHistoryView } from '../../apps/api/src/modules/automations/history.controller.js';
import type { WorkflowRunDetailView as ApiWorkflowRunDetailView } from '../../apps/api/src/modules/automations/history.controller.js';
import type { WorkflowTemplateEditView as ApiWorkflowTemplateEditView } from '../../apps/api/src/modules/automations/template-edit.controller.js';
import type { TemplateCloneView as ApiTemplateCloneView } from '../../apps/api/src/modules/automations/template-clone.controller.js';
import type { WorkflowConditionView as ApiWorkflowConditionView } from '../../apps/api/src/modules/automations/conditions.controller.js';
import type { AutomationVariableView as ApiAutomationVariableView } from '../../apps/api/src/modules/automations/variables.controller.js';
import type { AutomationTemplateTagView as ApiAutomationTemplateTagView } from '../../apps/api/src/modules/automations/template-tags.controller.js';
import type { AutomationTaggedTemplateView as ApiAutomationTaggedTemplateView } from '../../apps/api/src/modules/automations/template-tags.controller.js';
import type { PersonCapacityView as ApiPersonCapacityView } from '../../apps/api/src/modules/people/capacity.controller.js';
import type { ReportingLineView as ApiReportingLineView } from '../../apps/api/src/modules/people/reporting-lines.controller.js';
import type { AvailabilityView as ApiAvailabilityView } from '../../apps/api/src/modules/people/availability.controller.js';
import type { PersonTimeOffView as ApiPersonTimeOffView } from '../../apps/api/src/modules/people/time-off.controller.js';
import type { CapacityHeatmapView as ApiCapacityHeatmapView } from '../../apps/api/src/modules/people/capacity-heatmap.service.js';
import type { BillingProfileView as ApiBillingProfileView } from '../../apps/api/src/modules/billing/profile.controller.js';
import type { TaxDetailsView as ApiTaxDetailsView } from '../../apps/api/src/modules/billing/tax-details.service.js';
import type { BillingContactView as ApiBillingContactView } from '../../apps/api/src/modules/billing/contacts.service.js';
import type { BillingSeatView as ApiBillingSeatView } from '../../apps/api/src/modules/billing/seats.controller.js';
import type { BillingCreditView as ApiBillingCreditView } from '../../apps/api/src/modules/billing/credits.service.js';
import type { BillingDiscountView as ApiBillingDiscountView } from '../../apps/api/src/modules/billing/discounts.service.js';
import type { WorkTimelineView as ApiWorkTimelineView } from '../../apps/api/src/modules/work-views/work-views.service.js';
import type { WorkloadView as ApiWorkloadView } from '../../apps/api/src/modules/work-views/work-views.service.js';
import type { WorkCalendarView as ApiWorkCalendarView } from '../../apps/api/src/modules/work-views/work-views.service.js';
import type { SavedViewView as ApiSavedViewView } from '../../apps/api/src/modules/work-views/work-views.service.js';
import type { SavedSearchView as ApiSavedSearchView } from '../../apps/api/src/modules/search/saved-searches.service.js';
import type { RecentSearchView as ApiRecentSearchView } from '../../apps/api/src/modules/search/saved-searches.service.js';
import type { SharedSavedSearchView as ApiSharedSavedSearchView } from '../../apps/api/src/modules/search/saved-search-shares.service.js';
import type { SearchHistoryEntryView as ApiSearchHistoryEntryView } from '../../apps/api/src/modules/search/search-history.service.js';
import type { SearchPinView as ApiSearchPinView } from '../../apps/api/src/modules/search/search-pins.service.js';
import type { SearchScopeView as ApiSearchScopeView } from '../../apps/api/src/modules/search/saved-scopes.service.js';
import type { WorkspaceView as ApiWorkspaceView } from '../../apps/api/src/modules/tenancy/workspaces.controller.js';
import type { OrgSettingsView as ApiOrgSettingsView } from '../../apps/api/src/modules/tenancy/org-settings.controller.js';
import type { OrganizationProfileView as ApiOrganizationProfileView } from '../../apps/api/src/modules/tenancy/organizations.controller.js';
import type { DownloadScanPolicyView as ApiDownloadScanPolicyView } from '../../apps/api/src/modules/tenancy/download-scan-policy.controller.js';
import type { PublicTrustView as ApiPublicTrustView } from '../../apps/api/src/modules/public-site/trust-content.service.js';
import type { PublicLegalView as ApiPublicLegalView } from '../../apps/api/src/modules/public-site/public-content.service.js';
import type {
  PublicIncidentView as ApiPublicIncidentView,
  PublicStatusView as ApiPublicStatusView,
} from '../../apps/api/src/modules/public-site/status.controller.js';
import type {
  MaintenanceWindowView as ApiMaintenanceWindowView,
  PublicMaintenanceView as ApiPublicMaintenanceView,
} from '../../apps/api/src/modules/platform/maintenance.controller.js';
import type { CustomRoleView as ApiCustomRoleView } from '../../apps/api/src/modules/admin/roles.controller.js';
import type { DataExportRequestView as ApiDataExportRequestView } from '../../apps/api/src/modules/admin/export-requests.controller.js';
import type { AdminInvitationsView as ApiAdminInvitationsView } from '../../apps/api/src/modules/admin/invitation-management.controller.js';
import type { RoleEditView as ApiRoleEditView } from '../../apps/api/src/modules/admin/role-edit.controller.js';
import type { MemberBulkRoleView as ApiMemberBulkRoleView } from '../../apps/api/src/modules/tenancy/member-bulk-role.controller.js';
import type { ActiveSessionView as ApiActiveSessionView } from '../../apps/api/src/modules/identity/admin-sessions.controller.js';
import type { OrgPolicyView as ApiOrgPolicyView } from '../../apps/api/src/modules/admin/policies.controller.js';
import type { PolicySimulationView as ApiPolicySimulationView } from '../../apps/api/src/modules/admin/policy-simulate.service.js';
import type { SecuritySettingsView as ApiSecuritySettingsView } from '../../apps/api/src/modules/admin/security.controller.js';
import type { IpAllowlistEntryView as ApiIpAllowlistEntryView } from '../../apps/api/src/modules/admin/ip-allowlist.service.js';
import type { AuditRetentionView as ApiAuditRetentionView } from '../../apps/api/src/modules/admin/audit-retention.service.js';
import type { ApprovalDelegationView as ApiApprovalDelegationView } from '../../apps/api/src/modules/approvals/delegation.service.js';
// pass25 pairings (x276–x301) — these APPROVED slices shipped without a contract pairing; added by integrator 25.
import type { AnnouncementView as ApiAnnouncementView } from '../../apps/api/src/modules/admin/announcements.service.js';
import type {
  FeatureFlagAdminView as ApiFeatureFlagAdminView,
  FeatureFlagsAdminView as ApiFeatureFlagsAdminView,
  FeatureFlagsResolvedView as ApiFeatureFlagsResolvedView,
} from '../../apps/api/src/modules/admin/feature-flags.controller.js';
import type { MemberAdminNoteView as ApiMemberAdminNoteView } from '../../apps/api/src/modules/admin/member-notes.service.js';
import type { PlanChangeRequestView as ApiPlanChangeRequestView } from '../../apps/api/src/modules/billing/plan-change-requests.service.js';
import type { PurchaseOrderView as ApiPurchaseOrderView } from '../../apps/api/src/modules/billing/purchase-orders.service.js';
import type { MeetingTimePollOptionView as ApiMeetingTimePollOptionView } from '../../apps/api/src/modules/calendar/time-poll.service.js';
import type { InboxRuleView as ApiInboxRuleView } from '../../apps/api/src/modules/inbox/rules.service.js';
import type { StartupPrefView as ApiStartupPrefView } from '../../apps/api/src/modules/preferences/startup-prefs.controller.js';
import type {
  ProjectBaselineView as ApiProjectBaselineView,
  ProjectBaselineVarianceView as ApiProjectBaselineVarianceView,
} from '../../apps/api/src/modules/projects/baseline.service.js';
import type { ProjectBudgetView as ApiProjectBudgetView } from '../../apps/api/src/modules/projects/budget.service.js';
import type {
  ProjectPhaseView as ApiProjectPhaseView,
  MilestonePhaseAssignmentView as ApiMilestonePhaseAssignmentView,
} from '../../apps/api/src/modules/projects/phases.service.js';
import type { SecurityAlertsView as ApiSecurityAlertsView } from '../../apps/api/src/modules/admin/security-alerts.service.js';
import type {
  ApprovalStepView as ApiApprovalStepView,
  ApprovalChainView as ApiApprovalChainView,
} from '../../apps/api/src/modules/approvals/steps.service.js';
import type { RecentItemsView as ApiRecentItemsView } from '../../apps/api/src/modules/home/recent-items.service.js';
import type {
  PortalBrandingView as ApiPortalBrandingView,
  PortalBrandingClientView as ApiPortalBrandingClientView,
} from '../../apps/api/src/modules/portal/branding.controller.js';
import type {
  PortalFeedbackClientView as ApiPortalFeedbackClientView,
  PortalFeedbackStaffView as ApiPortalFeedbackStaffView,
} from '../../apps/api/src/modules/portal/feedback.service.js';
import type {
  ProjectCustomFieldDefinitionView as ApiProjectCustomFieldDefinitionView,
  ProjectCustomFieldValueView as ApiProjectCustomFieldValueView,
} from '../../apps/api/src/modules/projects/custom-fields.service.js';
import type { ProjectDependencyView as ApiProjectDependencyView } from '../../apps/api/src/modules/projects/dependencies.service.js';
import type {
  ProjectRetroNoteView as ApiProjectRetroNoteView,
  ProjectRetroBoardView as ApiProjectRetroBoardView,
} from '../../apps/api/src/modules/projects/retro-notes.service.js';

// ── The shapes `apps/web` declares for them ─────────────────────────────────
import type {
  ClientApprovalView as WebClientApprovalView,
  ClientDecideResult as WebClientDecideResult,
} from '../../apps/web/src/lib/api/approvals';
import type { EnrolledFactor as WebEnrolledFactor } from '../../apps/web/src/lib/api/auth';
import type { A11yPreferencesView as WebA11yPreferencesView } from '../../apps/web/src/lib/api/a11y-preferences';
import type { DisplayPreferencesView as WebDisplayPreferencesView } from '../../apps/web/src/lib/api/display-preferences';
import type { InsightSavedViewView as WebInsightSavedViewView } from '../../apps/web/src/lib/api/insight-saved-views';
import type {
  InsightCustomReportView as WebInsightCustomReportView,
  InsightCustomReportRenderedView as WebInsightCustomReportRenderedView,
} from '../../apps/web/src/lib/api/insight-custom-reports';
import type { ReportScheduleView as WebReportScheduleView } from '../../apps/web/src/lib/api/insight-report-schedules';
import type { QuietHoursView as WebQuietHoursView } from '../../apps/web/src/lib/api/quiet-hours';
import type { QuietHoursActiveView as WebQuietHoursActiveView } from '../../apps/web/src/lib/api/quiet-hours';
import type { DigestPrefView as WebDigestPrefView } from '../../apps/web/src/lib/api/digest';
import type { ShortcutMapView as WebShortcutMapView } from '../../apps/web/src/lib/api/keyboard-shortcuts';
import type { ShortcutView as WebShortcutView } from '../../apps/web/src/lib/api/keyboard-shortcuts';
import type { ResolvedShortcutView as WebResolvedShortcutView } from '../../apps/web/src/lib/api/keyboard-shortcuts';
import type { MyDay as WebMyDay } from '../../apps/web/src/lib/api/home';
import type { Waiting as WebWaiting } from '../../apps/web/src/lib/api/home';
import type { HomeSummary as WebHomeSummary } from '../../apps/web/src/lib/api/home';
import type { HomePulse as WebHomePulse } from '../../apps/web/src/lib/api/home';
import type { SavedContext as WebSavedContext } from '../../apps/web/src/lib/api/home';
import type { HomePinView as WebHomePinView } from '../../apps/web/src/lib/api/home';
import type { HomeWidgetPrefsView as WebHomeWidgetPrefsView } from '../../apps/web/src/lib/api/home-widget-prefs';
import type { NotificationKindPrefView as WebNotificationKindPrefView } from '../../apps/web/src/lib/api/notification-kind-prefs';
import type { OrgSettingsView as WebOrgSettingsView } from '../../apps/web/src/lib/api/org-settings';
import type { OrganizationProfileView as WebOrganizationProfileView } from '../../apps/web/src/lib/api/organizations';
import type { CustomRoleView as WebCustomRoleView } from '../../apps/web/src/lib/api/admin-roles';
import type { DataExportRequestView as WebDataExportRequestView } from '../../apps/web/src/lib/api/admin-export-requests';
import type { AdminInvitationsView as WebAdminInvitationsView } from '../../apps/web/src/lib/api/admin-invitations';
import type { RoleEditView as WebRoleEditView } from '../../apps/web/src/lib/api/admin-role-edit';
import type { MemberBulkRoleView as WebMemberBulkRoleView } from '../../apps/web/src/lib/api/admin-member-bulk-role';
import type { ActiveSessionView as WebActiveSessionView } from '../../apps/web/src/lib/api/admin-sessions';
import type { OrgPolicyView as WebOrgPolicyView } from '../../apps/web/src/lib/api/policies';
import type { PolicySimulationView as WebPolicySimulationView } from '../../apps/web/src/lib/api/policy-simulate';
import type { SecuritySettingsView as WebSecuritySettingsView } from '../../apps/web/src/lib/api/admin-security';
import type { IpAllowlistEntryView as WebIpAllowlistEntryView } from '../../apps/web/src/lib/api/admin-ip-allowlist';
import type { AuditRetentionView as WebAuditRetentionView } from '../../apps/web/src/lib/api/admin-audit-retention';
import type { SecurityAlertsView as WebSecurityAlertsView } from '../../apps/web/src/lib/api/admin-security-alerts';
import type { OnboardingTourView as WebOnboardingTourView } from '../../apps/web/src/lib/api/onboarding-tour';
import type { UserPreferencesView as WebUserPreferencesView } from '../../apps/web/src/lib/api/preferences';
import type {
  AuthenticatedResponse as WebAuthenticatedResponse,
  MfaRequiredResponse as WebMfaRequiredResponse,
} from '../../apps/web/src/lib/api/auth';
import type {
  AcceptedClientRequest as WebAcceptedClientRequest,
  ClientRequestHistoryEntry as WebClientRequestHistoryEntry,
  ClientRequestRecord as WebClientRequestRecord,
} from '../../apps/web/src/lib/api/client-requests';
import type {
  ClientMembership as WebClientMembership,
  ClientOrganization as WebClientOrganization,
  ProjectShare as WebProjectShare,
} from '../../apps/web/src/lib/api/clients';
import type {
  ClientMembershipView as WebClientMembershipView,
  ClientOrganizationView as WebClientOrganizationView,
} from '../../apps/web/src/lib/api/project-client';
import type { DocumentVersionSummary as WebDocumentVersionSummary } from '../../apps/web/src/lib/api/documents';
import type { DocRevisionSummary as WebDocRevisionSummary } from '../../apps/web/src/lib/api/doc-revisions';
import type { DocBookmarkSummary as WebDocBookmarkSummary } from '../../apps/web/src/lib/api/doc-bookmarks';
import type { DocSubscriptionSummary as WebDocSubscriptionSummary } from '../../apps/web/src/lib/api/doc-subscriptions';
import type { SavedMessageSummary as WebSavedMessageSummary } from '../../apps/web/src/lib/api/message-bookmarks';
import type { InboxSavedFilterView as WebInboxSavedFilterView } from '../../apps/web/src/lib/api/inbox-saved-filters';
import type { GlossaryTermSummary as WebGlossaryTermSummary } from '../../apps/web/src/lib/api/glossary';
import type {
  DocCollectionSummary as WebDocCollectionSummary,
  CollectionDocumentSummary as WebCollectionDocumentSummary,
} from '../../apps/web/src/lib/api/doc-collections';
import type { ProjectFavoriteSummary as WebProjectFavoriteSummary } from '../../apps/web/src/lib/api/project-favorites';
import type { DocTag as WebDocTag } from '../../apps/web/src/lib/api/doc-tags';
import type { DocumentTag as WebDocumentTag } from '../../apps/web/src/lib/api/doc-tags';
import type { MessageAttachmentSummary as WebMessageAttachmentSummary } from '../../apps/web/src/lib/api/message-attachments';
import type { DocLinkSummary as WebDocLinkSummary } from '../../apps/web/src/lib/api/doc-links';
import type { DocReadStateSummary as WebDocReadStateSummary } from '../../apps/web/src/lib/api/doc-read-state';
import type { ApprovalDelegationSummary as WebApprovalDelegationSummary } from '../../apps/web/src/lib/api/approval-delegations';
import type { MetricFavoriteSummary as WebMetricFavoriteSummary } from '../../apps/web/src/lib/api/metric-favorites';
import type { DecisionSummary as WebDecisionSummary } from '../../apps/web/src/lib/api/decisions';
import type { WorkFormSummary as WebWorkFormSummary } from '../../apps/web/src/lib/api/work-forms';
import type { WorkflowTemplateSummary as WebWorkflowTemplateSummary } from '../../apps/web/src/lib/api/automations';
import type { WorkflowRunSummary as WebWorkflowRunSummary } from '../../apps/web/src/lib/api/automations';
import type { IntegrationAppView as WebIntegrationAppView } from '../../apps/web/src/lib/api/integration-directory';
import type { IntegrationConnectionView as WebIntegrationConnectionView } from '../../apps/web/src/lib/api/integration-directory';
import type { ConnectionHealthView as WebConnectionHealthView } from '../../apps/web/src/lib/api/connection-health';
import type { WebhookEndpointSummary as WebWebhookEndpointSummary } from '../../apps/web/src/lib/api/webhooks';
import type { WebhookDeliveryView as WebWebhookDeliveryView } from '../../apps/web/src/lib/api/webhook-deliveries';
import type { WorkflowRunHistoryItem as WebWorkflowRunHistoryItem } from '../../apps/web/src/lib/api/automations';
import type { WorkflowRunDetail as WebWorkflowRunDetail } from '../../apps/web/src/lib/api/automations';
import type { WorkflowTemplateEditView as WebWorkflowTemplateEditView } from '../../apps/web/src/lib/api/automations';
import type { TemplateCloneView as WebTemplateCloneView } from '../../apps/web/src/lib/api/automations';
import type { WorkflowConditionSummary as WebWorkflowConditionSummary } from '../../apps/web/src/lib/api/automations';
import type { AutomationVariableSummary as WebAutomationVariableSummary } from '../../apps/web/src/lib/api/automation-variables';
import type { AutomationTemplateTagSummary as WebAutomationTemplateTagSummary } from '../../apps/web/src/lib/api/automation-template-tags';
import type { AutomationTaggedTemplateSummary as WebAutomationTaggedTemplateSummary } from '../../apps/web/src/lib/api/automation-template-tags';
import type { PersonCapacity as WebPersonCapacity } from '../../apps/web/src/lib/api/person-capacity';
import type { ReportingLine as WebReportingLine } from '../../apps/web/src/lib/api/reporting-lines';
import type { AvailabilityView as WebAvailabilityView } from '../../apps/web/src/lib/api/people-availability';
import type { PersonTimeOffView as WebPersonTimeOffView } from '../../apps/web/src/lib/api/person-time-off';
import type { CapacityHeatmapView as WebCapacityHeatmapView } from '../../apps/web/src/lib/api/team-capacity-heatmap';
import type { PersonSkillView as ApiPersonSkillView } from '../../apps/api/src/modules/people/skills.controller.js';
import type { PersonSkillSummary as WebPersonSkillSummary } from '../../apps/web/src/lib/api/people-skills';
import type { PersonCertificationView as ApiPersonCertificationView } from '../../apps/api/src/modules/people/certifications.service.js';
import type { PersonCertificationSummary as WebPersonCertificationSummary } from '../../apps/web/src/lib/api/people-certifications';
import type { SkillSearchView as ApiSkillSearchView } from '../../apps/api/src/modules/people/skill-search.controller.js';
import type { FocusBlockView as ApiFocusBlockView } from '../../apps/api/src/modules/calendar/focus-blocks.service.js';
import type { ConversationMuteView as ApiConversationMuteView } from '../../apps/api/src/modules/conversations/conversation-mute.controller.js';
import type { MessageSearchMatchView as ApiMessageSearchMatchView } from '../../apps/api/src/modules/conversations/conversation-search.service.js';
import type { MessageDraftView as ApiMessageDraftView } from '../../apps/api/src/modules/conversations/message-drafts.service.js';
import type { ConversationReadStateView as ApiConversationReadStateView } from '../../apps/api/src/modules/conversations/read-state.service.js';
import type { ConversationUnreadView as ApiConversationUnreadView } from '../../apps/api/src/modules/conversations/read-state.service.js';
import type { InboxSnoozeView as ApiInboxSnoozeView } from '../../apps/api/src/modules/inbox/inbox-snooze.service.js';
import type { InboxSourceMutesView as ApiInboxSourceMutesView } from '../../apps/api/src/modules/inbox/source-mutes.service.js';
import type { SkillSearchResult as WebSkillSearchResult } from '../../apps/web/src/lib/api/people-skill-search';
import type { BillingProfileView as WebBillingProfileView } from '../../apps/web/src/lib/api/billing';
import type { TaxDetailsView as WebTaxDetailsView } from '../../apps/web/src/lib/api/billing-tax-details';
import type { BillingContactView as WebBillingContactView } from '../../apps/web/src/lib/api/billing-contacts';
import type { BillingSeat as WebBillingSeat } from '../../apps/web/src/lib/api/billing-seats';
import type { BillingCreditView as WebBillingCreditView } from '../../apps/web/src/lib/api/billing-credits';
import type { BillingDiscountView as WebBillingDiscountView } from '../../apps/web/src/lib/api/billing-discounts';
import type { DecisionDetail as WebDecisionDetail } from '../../apps/web/src/lib/api/decisions';
import type { DecisionLock as WebDecisionLock } from '../../apps/web/src/lib/api/decisions';
import type { DecisionComment as WebDecisionComment } from '../../apps/web/src/lib/api/decision-comments';
import type { InvoiceSummary as WebInvoiceSummary } from '../../apps/web/src/lib/api/invoices';
import type { InvoiceDetail as WebInvoiceDetail } from '../../apps/web/src/lib/api/invoices';
import type { InvoiceLineItem as WebInvoiceLineItem } from '../../apps/web/src/lib/api/invoice-line-items';
import type { InvoiceLines as WebInvoiceLines } from '../../apps/web/src/lib/api/invoice-line-items';
import type { DocumentTemplateSummary as WebDocumentTemplateSummary } from '../../apps/web/src/lib/api/document-templates';
import type { ProjectObjectiveSummary as WebProjectObjectiveSummary } from '../../apps/web/src/lib/api/project-objectives';
import type { ProjectInternalRiskSummary as WebProjectInternalRiskSummary } from '../../apps/web/src/lib/api/project-risk-register';
import type { ProjectTemplateView as WebProjectTemplateView } from '../../apps/web/src/lib/api/project-templates';
import type {
  ProjectStatusUpdatePage as WebProjectStatusUpdatePage,
  ProjectStatusUpdateSummary as WebProjectStatusUpdateSummary,
} from '../../apps/web/src/lib/api/project-status-updates';
import type { PortalSettingsView as WebPortalSettingsView } from '../../apps/web/src/lib/api/portal-settings';
import type { DocumentTemplateVariableSummary as WebDocumentTemplateVariableSummary } from '../../apps/web/src/lib/api/document-template-variables';
import type { AutomationScheduleSummary as WebAutomationScheduleSummary } from '../../apps/web/src/lib/api/automation-schedules';
import type { OrgObjectiveSummary as WebOrgObjectiveSummary } from '../../apps/web/src/lib/api/org-objectives';
import type { ProjectPortfolioSummary as WebProjectPortfolioSummary } from '../../apps/web/src/lib/api/project-portfolio';
import type { ProjectHealthSummary as WebProjectHealthSummary } from '../../apps/web/src/lib/api/project-health';
import type { PublicPlanView as WebPublicPlanView } from '../../apps/web/src/lib/api/public-plans';
import type { ObjectiveWorkLink as WebObjectiveWorkLink } from '../../apps/web/src/lib/api/objective-work-links';
import type { MilestoneLink as WebMilestoneLink } from '../../apps/web/src/lib/api/milestone-links';
import type { KeyResult as WebKeyResult } from '../../apps/web/src/lib/api/key-results';
import type { DecisionWorkLink as WebDecisionWorkLink } from '../../apps/web/src/lib/api/decision-work-links';
import type { PersonAllocationSummary as WebPersonAllocationSummary } from '../../apps/web/src/lib/api/person-allocations';
import type {
  ConversationSummary as WebConversationSummary,
  ConvertMessageResult as WebConvertMessageResult,
  MessageRevisionSummary as WebMessageRevisionSummary,
  MessageSummary as WebMessageSummary,
} from '../../apps/web/src/lib/api/conversations';
import type { MessageReactionTally as WebMessageReactionTally } from '../../apps/web/src/lib/api/message-reactions';
import type { PinnedMessage as WebPinnedMessage } from '../../apps/web/src/lib/api/message-pins';
import type { MentionSummary as WebMentionSummary } from '../../apps/web/src/lib/api/my-mentions';
import type { DocumentView as WebDocumentView } from '../../apps/web/src/lib/api/documents';
import type { DocumentCommentView as WebDocumentCommentView } from '../../apps/web/src/lib/api/document-comments';
import type { DocReviewView as WebDocReviewView } from '../../apps/web/src/lib/api/doc-reviews';
import type {
  ThreadReplyView as WebThreadReplyView,
  ThreadView as WebThreadView,
} from '../../apps/web/src/lib/api/thread-replies';
import type {
  InboxBundle as WebInboxBundle,
  InboxPage as WebInboxPage,
  InboxUsageNotice as WebInboxUsageNotice,
} from '../../apps/web/src/lib/api/inbox';
import type {
  AcceptedInvitation as WebAcceptedInvitation,
  InvitationPreview as WebInvitationPreview,
  InvitationRegistration as WebInvitationRegistration,
  InvitationSummary as WebInvitationSummary,
  IssuedInvitation as WebIssuedInvitation,
} from '../../apps/web/src/lib/api/invitations';
import type { MeetingNoteView as WebMeetingNoteView } from '../../apps/web/src/lib/api/meetings';
import type { MeetingView as WebMeetingView } from '../../apps/web/src/lib/api/meetings';
import type { MeetingAttendeeView as WebMeetingAttendeeView } from '../../apps/web/src/lib/api/meeting-attendees';
import type { MeetingClientAttendeeView as WebMeetingClientAttendeeView } from '../../apps/web/src/lib/api/meeting-attendees';
import type { ClientAttendeeCandidateView as WebClientAttendeeCandidateView } from '../../apps/web/src/lib/api/meeting-attendees';
import type { MeetingActionItemView as WebMeetingActionItemView } from '../../apps/web/src/lib/api/meeting-action-items';
import type { MeetingRsvpView as WebMeetingRsvpView } from '../../apps/web/src/lib/api/meeting-rsvp';
import type { MeetingTimePollView as WebMeetingTimePollView } from '../../apps/web/src/lib/api/meeting-time-poll';
import type { MeetingAgendaView as WebMeetingAgendaView } from '../../apps/web/src/lib/api/meeting-agenda';
import type { CalendarGridView as WebCalendarGridView } from '../../apps/web/src/lib/api/calendar-grid';
import type {
  NotificationView as WebNotificationView,
  NotificationFeedView as WebNotificationFeedView,
} from '../../apps/web/src/lib/api/notifications-feed';
import type { MeetingSeriesView as WebMeetingSeriesView } from '../../apps/web/src/lib/api/meeting-series';
import type { AgendaTemplateView as WebAgendaTemplateView } from '../../apps/web/src/lib/api/agenda-templates';
import type { OccurrenceOverrideView as WebOccurrenceOverrideView } from '../../apps/web/src/lib/api/meeting-occurrence-override';
import type { MemberSummary as WebMemberSummary } from '../../apps/web/src/lib/api/members';
import type { PersonSummary as WebPersonSummary } from '../../apps/web/src/lib/api/people';
import type { ProjectMemberSummary as WebProjectMemberSummary } from '../../apps/web/src/lib/api/project-members';
import type {
  OffboardingImpactView as WebOffboardingImpactView,
  OffboardedMember as WebOffboardedMember,
} from '../../apps/web/src/lib/api/offboarding';
import type {
  AddressAvailability as WebAddressAvailability,
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
  UpdateEdit as WebUpdateEdit,
  UpdateComment as WebUpdateComment,
  ClientUpdateComment as WebClientUpdateComment,
  ClientMessage as WebClientMessage,
  AdminClientMessage as WebAdminClientMessage,
  PortalWorkItem as WebPortalWorkItem,
  ProjectMilestone as WebProjectMilestone,
  ClientMilestone as WebClientMilestone,
  MilestoneEdit as WebMilestoneEdit,
  ProjectRisk as WebProjectRisk,
  ClientRisk as WebClientRisk,
} from '../../apps/web/src/lib/api/portal';
import type { PortalAccessLogEvent as WebPortalAccessLogEvent } from '../../apps/web/src/lib/api/portal-access-log';
import type {
  PortalAnnouncement as WebPortalAnnouncement,
  ClientPortalAnnouncement as WebClientPortalAnnouncement,
} from '../../apps/web/src/lib/api/portal-announcements';
import type {
  ImportReceipt as WebImportReceipt,
  ImportReceiptRow as WebImportReceiptRow,
} from '../../apps/web/src/lib/api/imports';
import type {
  ProjectSummary as WebProjectSummary,
  WorkspaceSummary as WebWorkspaceSummary,
} from '../../apps/web/src/lib/api/projects';
import type { PublicHome as WebPublicHome } from '../../apps/web/src/lib/api/public-site';
import type {
  PublicResourceListView as WebPublicResourceListView,
  PublicResourceView as WebPublicResourceView,
} from '../../apps/web/src/lib/api/public-resources';
import type { RealtimeTicket as WebRealtimeTicket } from '../../apps/web/src/lib/api/realtime';
import type { SearchResult as WebSearchResult } from '../../apps/web/src/lib/api/search';
import type { ContactSubmitView as WebContactSubmitView } from '../../apps/web/src/lib/api/contact';
import type {
  FirstOwnerAvailabilityView as WebFirstOwnerAvailabilityView,
  FirstOwnerSetupView as WebFirstOwnerSetupView,
} from '../../apps/web/src/lib/api/setup';
import type {
  PublicSignupAvailabilityView as WebPublicSignupAvailabilityView,
  PublicSignupView as WebPublicSignupView,
} from '../../apps/web/src/lib/api/sign-up';
import type {
  PlatformMeView as WebPlatformMeView,
  PlatformOverviewView as WebPlatformOverviewView,
  PlatformCompanyView as WebPlatformCompanyView,
  PlatformCompanyAuditView as WebPlatformCompanyAuditView,
  PlatformCompanyDetailView as WebPlatformCompanyDetailView,
  PlatformPersonView as WebPlatformPersonView,
  PlatformSettingsView as WebPlatformSettingsView,
  PlatformAuditEventView as WebPlatformAuditEventView,
} from '../../apps/web/src/lib/api/platform-admin';
import type {
  StorageStatusView as WebStorageStatusView,
  DriveAttachmentView as WebDriveAttachmentView,
  PickerSessionView as WebPickerSessionView,
} from '../../apps/web/src/lib/api/google-drive';
import type { ConsentView as WebConsentView } from '../../apps/web/src/lib/api/oauth-consent';
import type {
  ConnectedApp as WebConnectedApp,
  ConnectedAppsView as WebConnectedAppsView,
} from '../../apps/web/src/lib/api/connected-apps';
import type { AiApprovalView as WebAiApprovalView } from '../../apps/web/src/lib/api/ai-approvals';
import type {
  GoogleAvailabilityView as WebGoogleAvailabilityView,
  GooglePendingMfaView as WebGooglePendingMfaView,
  GoogleStartView as WebGoogleStartView,
} from '../../apps/web/src/lib/api/google-auth';
import type { Command as WebCommand } from '../../apps/web/src/lib/api/commands';
import type { CopilotAnswerView as WebCopilotAnswerView } from '../../apps/web/src/lib/api/copilot';
import type {
  EstablishedSession as WebEstablishedSession,
  SessionSummary as WebSessionSummary,
} from '../../apps/web/src/lib/api/session';
import type { OrganizationUsage as WebOrganizationUsage } from '../../apps/web/src/lib/api/usage';
import type { SubscriptionView as WebSubscriptionView } from '../../apps/web/src/lib/api/subscription';
import type { PlanChangePreviewView as WebPlanChangePreviewView } from '../../apps/web/src/lib/api/plan-preview';
import type {
  UsageAlertSummary as WebUsageAlertSummary,
  UsageAlertStatus as WebUsageAlertStatus,
} from '../../apps/web/src/lib/api/billing';
import type { UsageExportColumns as WebUsageExportColumns } from '../../apps/web/src/lib/api/billing-usage-export';
import type { CostCenterSummary as WebCostCenterSummary } from '../../apps/web/src/lib/api/billing-cost-centers';
import type { CostCenterReportRow as WebCostCenterReportRow } from '../../apps/web/src/lib/api/cost-center-report';
import type { AdminAuditEvent as WebAdminAuditEvent } from '../../apps/web/src/lib/api/admin-audit';
import type { AdminOverviewView as WebAdminOverviewView } from '../../apps/web/src/lib/api/admin-overview';
import type { OrgBrandingView as WebOrgBrandingView } from '../../apps/web/src/lib/api/org-branding';
import type { ApprovalCycle as WebApprovalCycle } from '../../apps/web/src/lib/api/approval-cycle';
import type { DeliveryFlow as WebDeliveryFlow } from '../../apps/web/src/lib/api/delivery-flow';
import type { InsightsPortfolio as WebInsightsPortfolio } from '../../apps/web/src/lib/api/insights-portfolio';
import type { InsightsWorkloadView as WebInsightsWorkloadView } from '../../apps/web/src/lib/api/insights-workload';
import type { InsightsAdoptionView as WebInsightsAdoptionView } from '../../apps/web/src/lib/api/insights-adoption';
import type { SnapshotView as WebSnapshotView } from '../../apps/web/src/lib/api/insights-snapshots';
import type { PeriodComparisonView as WebPeriodComparisonView } from '../../apps/web/src/lib/api/insights-comparison';
import type { MetricTargetView as WebMetricTargetView } from '../../apps/web/src/lib/api/insights-targets';
import type { MetricTargetStatusView as WebMetricTargetStatusView } from '../../apps/web/src/lib/api/insights-targets';
import type { InsightAnnotationView as WebInsightAnnotationView } from '../../apps/web/src/lib/api/insight-annotations';
import type { MetricAlertView as WebMetricAlertView } from '../../apps/web/src/lib/api/insights-metric-alerts';
import type { MetricAlertStatusView as WebMetricAlertStatusView } from '../../apps/web/src/lib/api/insights-metric-alerts';
import type { WorkloadForecastView as WebWorkloadForecastView } from '../../apps/web/src/lib/api/workload-forecast';
import type { InsightDashboardLayoutView as WebInsightDashboardLayoutView } from '../../apps/web/src/lib/api/insight-dashboard-layout';
import type { RequestAgingView as WebRequestAgingView } from '../../apps/web/src/lib/api/request-aging';
import type { RequestTriageView as WebRequestTriageView } from '../../apps/web/src/lib/api/request-triage';
import type { RequestComment as WebRequestComment } from '../../apps/web/src/lib/api/request-comments';
import type { RequestTagsView as WebRequestTagsView } from '../../apps/web/src/lib/api/request-tags';
import type { PublicChangelogView as WebPublicChangelogView } from '../../apps/web/src/lib/api/public-changelog';
import type { PersonProfileView as WebPersonProfileView } from '../../apps/web/src/lib/api/person-profile';
import type {
  MemberProfileView as WebMemberProfileView,
  MyProfileView as WebMyProfileView,
} from '../../apps/web/src/lib/api/member-profile';
import type {
  TeamView as WebTeamView,
  TeamMemberView as WebTeamMemberView,
  TeamDetailView as WebTeamDetailView,
} from '../../apps/web/src/lib/api/people-teams';
import type { WorkItemSummary as WebWorkItemSummary } from '../../apps/web/src/lib/api/work-items';
import type { BulkTransitionView as WebBulkTransitionView } from '../../apps/web/src/lib/api/work-bulk-transition';
import type { WorkChecklistItem as WebWorkChecklistItem } from '../../apps/web/src/lib/api/work-items';
import type {
  WorkSubtask as WebWorkSubtask,
  WorkSubtaskList as WebWorkSubtaskList,
} from '../../apps/web/src/lib/api/work-items';
import type { WorkComment as WebWorkComment } from '../../apps/web/src/lib/api/work-items';
import type { WorkItemLink as WebWorkItemLink } from '../../apps/web/src/lib/api/work-items';
import type { WorkRelationsGraph as WebWorkRelationsGraph } from '../../apps/web/src/lib/api/work-relations-graph';
import type { ItemFile as WebItemFile } from '../../apps/web/src/lib/api/work-items';
import type { TimeLog as WebTimeLog } from '../../apps/web/src/lib/api/work-items';
import type { TimeLogList as WebTimeLogList } from '../../apps/web/src/lib/api/work-items';
import type { WorkItemEstimate as WebWorkItemEstimate } from '../../apps/web/src/lib/api/work-items';
import type { ItemWatcher as WebItemWatcher } from '../../apps/web/src/lib/api/work-items';
import type { WorkItemReminder as WebWorkItemReminder } from '../../apps/web/src/lib/api/work-items';
import type { DueReminder as WebDueReminder } from '../../apps/web/src/lib/api/work-items';
import type { WorkActivityEntry as WebWorkActivityEntry } from '../../apps/web/src/lib/api/work-activity';
import type { WorkLabel as WebWorkLabel } from '../../apps/web/src/lib/api/work-labels';
import type { ItemLabel as WebItemLabel } from '../../apps/web/src/lib/api/work-labels';
import type { WorkCustomFieldDefinition as WebWorkCustomFieldDefinition } from '../../apps/web/src/lib/api/work-custom-fields';
import type { WorkCustomFieldValue as WebWorkCustomFieldValue } from '../../apps/web/src/lib/api/work-custom-fields';
import type { WorkItemRecurrence as WebWorkItemRecurrence } from '../../apps/web/src/lib/api/work-item-recurrence';
import type { NextOccurrence as WebNextOccurrence } from '../../apps/web/src/lib/api/work-item-recurrence';
import type { ProjectTag as WebProjectTag } from '../../apps/web/src/lib/api/project-tags';
import type { ProjectTagAssignment as WebProjectTagAssignment } from '../../apps/web/src/lib/api/project-tags';
import type { FileTag as WebFileTag } from '../../apps/web/src/lib/api/file-tags';
import type { FileTagAssignment as WebFileTagAssignment } from '../../apps/web/src/lib/api/file-tags';
import type { ChecklistTemplate as WebChecklistTemplate } from '../../apps/web/src/lib/api/work-checklist-templates';
import type { ApplyTemplateResult as WebApplyTemplateResult } from '../../apps/web/src/lib/api/work-checklist-templates';
import type { BoardColumn as WebBoardColumn } from '../../apps/web/src/lib/api/board-columns';
import type { FileFolder as WebFileFolder } from '../../apps/web/src/lib/api/file-folders';
import type { FileFolderPlacement as WebFileFolderPlacement } from '../../apps/web/src/lib/api/file-folders';
import type { FileComment as WebFileComment } from '../../apps/web/src/lib/api/file-comments';
import type { WorkTimelineView as WebWorkTimelineView } from '../../apps/web/src/lib/api/work-views';
import type { WorkloadView as WebWorkloadView } from '../../apps/web/src/lib/api/work-views';
import type { WorkCalendarView as WebWorkCalendarView } from '../../apps/web/src/lib/api/work-views';
import type { SavedViewView as WebSavedViewView } from '../../apps/web/src/lib/api/work-views';
import type { SavedSearch as WebSavedSearch } from '../../apps/web/src/lib/api/saved-searches';
import type { RecentSearch as WebRecentSearch } from '../../apps/web/src/lib/api/saved-searches';
import type { SharedSavedSearch as WebSharedSavedSearch } from '../../apps/web/src/lib/api/saved-search-shares';
import type { SearchHistoryEntry as WebSearchHistoryEntry } from '../../apps/web/src/lib/api/search-history';
import type { SearchPin as WebSearchPin } from '../../apps/web/src/lib/api/search-pins';
import type { SearchScope as WebSearchScope } from '../../apps/web/src/lib/api/saved-scopes';
import type { PublicTrustView as WebPublicTrustView } from '../../apps/web/src/lib/api/public-trust';
import type { PublicFaqView as WebPublicFaqView } from '../../apps/web/src/lib/api/public-faq';
import type { PublicLegalView as WebPublicLegalView } from '../../apps/web/src/lib/api/public-legal';
import type { FocusBlockView as WebFocusBlockView } from '../../apps/web/src/lib/api/focus-blocks';
import type { ConversationMuteView as WebConversationMuteView } from '../../apps/web/src/lib/api/conversation-mute';
import type { MessageSearchMatch as WebMessageSearchMatch } from '../../apps/web/src/lib/api/conversation-search';
import type { MessageDraftView as WebMessageDraftView } from '../../apps/web/src/lib/api/conversations';
import type { ConversationReadStateView as WebConversationReadStateView } from '../../apps/web/src/lib/api/conversation-read-state';
import type { ConversationUnreadView as WebConversationUnreadView } from '../../apps/web/src/lib/api/conversation-read-state';
import type { InboxSnoozeView as WebInboxSnoozeView } from '../../apps/web/src/lib/api/inbox-snooze';
import type { InboxSourceMutesView as WebInboxSourceMutesView } from '../../apps/web/src/lib/api/inbox-source-mutes';
import type {
  PublicIncidentView as WebPublicIncidentView,
  PublicStatusView as WebPublicStatusView,
} from '../../apps/web/src/lib/api/public-site';
import type {
  MaintenanceWindowView as WebMaintenanceWindowView,
  PublicMaintenanceView as WebPublicMaintenanceView,
} from '../../apps/web/src/lib/api/maintenance';
import type {
  InboxFlagView as ApiInboxFlagView,
  InboxFlaggedView as ApiInboxFlaggedView,
} from '../../apps/api/src/modules/inbox/inbox-flag.service.js';
import type { HomeQuickLinksView as ApiHomeQuickLinksView } from '../../apps/api/src/modules/home/quick-links.service.js';
import type {
  InboxFlagView as WebInboxFlagView,
  InboxFlaggedView as WebInboxFlaggedView,
} from '../../apps/web/src/lib/api/inbox-flags';
import type { HomeQuickLinksView as WebHomeQuickLinksView } from '../../apps/web/src/lib/api/home-quick-links';
// pass25 pairings (x276–x301), added by integrator 25.
import type { AnnouncementSummary as WebAnnouncementSummary } from '../../apps/web/src/lib/api/admin-announcements';
import type {
  FeatureFlagAdminView as WebFeatureFlagAdminView,
  FeatureFlagsAdminView as WebFeatureFlagsAdminView,
  FeatureFlagsResolvedView as WebFeatureFlagsResolvedView,
} from '../../apps/web/src/lib/api/admin-feature-flags';
import type { MemberAdminNoteView as WebMemberAdminNoteView } from '../../apps/web/src/lib/api/member-admin-notes';
import type { PlanChangeRequestView as WebPlanChangeRequestView } from '../../apps/web/src/lib/api/plan-change-requests';
import type { PurchaseOrderSummary as WebPurchaseOrderSummary } from '../../apps/web/src/lib/api/purchase-orders';
import type { MeetingTimePollOptionView as WebMeetingTimePollOptionView } from '../../apps/web/src/lib/api/meeting-time-poll';
import type { InboxRuleView as WebInboxRuleView } from '../../apps/web/src/lib/api/inbox-rules';
import type { StartupPrefView as WebStartupPrefView } from '../../apps/web/src/lib/api/startup-prefs';
import type {
  ProjectBaselineSummary as WebProjectBaselineSummary,
  ProjectBaselineVariance as WebProjectBaselineVariance,
} from '../../apps/web/src/lib/api/project-baseline';
import type { ProjectBudgetSummary as WebProjectBudgetSummary } from '../../apps/web/src/lib/api/project-budget';
import type {
  ProjectPhaseSummary as WebProjectPhaseSummary,
  MilestonePhaseAssignment as WebMilestonePhaseAssignment,
} from '../../apps/web/src/lib/api/project-phases';
import type {
  ApprovalStep as WebApprovalStep,
  ApprovalChain as WebApprovalChain,
} from '../../apps/web/src/lib/api/approval-steps';
import type { RecentItemsView as WebRecentItemsView } from '../../apps/web/src/lib/api/home';
import type {
  PortalBranding as WebPortalBranding,
  PortalBrandingClientView as WebPortalBrandingClientView,
} from '../../apps/web/src/lib/api/portal-branding';
import type {
  PortalDeliverableFeedback as WebPortalDeliverableFeedback,
  PortalDeliverableFeedbackStaffEntry as WebPortalDeliverableFeedbackStaffEntry,
} from '../../apps/web/src/lib/api/portal-deliverable-feedback';
import type {
  ProjectCustomFieldDefinition as WebProjectCustomFieldDefinition,
  ProjectCustomFieldValue as WebProjectCustomFieldValue,
} from '../../apps/web/src/lib/api/project-custom-fields';
import type { ProjectDependency as WebProjectDependency } from '../../apps/web/src/lib/api/project-dependencies';
import type {
  ProjectRetroNoteSummary as WebProjectRetroNoteSummary,
  ProjectRetroBoard as WebProjectRetroBoard,
} from '../../apps/web/src/lib/api/project-retro-notes';
import type {
  DocumentPersonView as ApiDocumentPersonView,
  DocumentSharingView as ApiDocumentSharingView,
  RecentDocumentView as ApiRecentDocumentView,
  RecentDocumentsView as ApiRecentDocumentsView,
} from '../../apps/api/src/modules/docs/document-sharing.service.js';
import type {
  DocumentPerson as WebDocumentPerson,
  DocumentSharing as WebDocumentSharing,
  RecentDocumentSummary as WebRecentDocumentSummary,
  RecentDocumentsResult as WebRecentDocumentsResult,
} from '../../apps/web/src/lib/api/documents';
import type { InsightsAdoptionGapView as ApiInsightsAdoptionGapView } from '../../apps/api/src/modules/insights/adoption.controller.js';
import type { InsightsAdoptionGapView as WebInsightsAdoptionGapView } from '../../apps/web/src/lib/api/insights-adoption';
import type {
  CreatedPersonalAccessTokenView as ApiCreatedPersonalAccessTokenView,
  PersonalAccessTokenView as ApiPersonalAccessTokenView,
} from '../../apps/api/src/modules/personal-access-tokens/personal-access-tokens.service.js';
import type {
  CreatedPersonalAccessTokenView as WebCreatedPersonalAccessTokenView,
  PersonalAccessTokenView as WebPersonalAccessTokenView,
} from '../../apps/web/src/lib/api/personal-access-tokens';
import type { PortfolioCapacityView as ApiPortfolioCapacityView } from '../../apps/api/src/modules/projects/portfolio-capacity.service.js';
import type { PortfolioMilestoneView as ApiPortfolioMilestoneView } from '../../apps/api/src/modules/projects/portfolio.service.js';
import type {
  PortfolioCapacity as WebPortfolioCapacity,
  PortfolioMilestone as WebPortfolioMilestone,
} from '../../apps/web/src/lib/api/project-portfolio';

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
// A11Y-183 (x183): the member's own accessibility preferences read/replaced over `/me/accessibility`.
type _a11yPreferences = Assert<Exact<ApiA11yPreferencesView, WebA11yPreferencesView>>;

// PREF-DISPLAY (x285): the member's own display preferences read/replaced over `/me/display-preferences`.
type _displayPreferences = Assert<Exact<ApiDisplayPreferencesView, WebDisplayPreferencesView>>;
// INS saved views (x210): a member's own named insights view, created/listed/deleted over
// `/insights/saved-views`. The screen reads exactly this response, so the pair is Exact.
type _insightSavedView = Assert<Exact<ApiInsightSavedViewView, WebInsightSavedViewView>>;
// INS custom reports (x320): a member's own composed insight report, created/listed/replaced/deleted
// over `/insights/custom-reports`, and read back rendered by id. The screen reads exactly these
// responses, so both pairs are Exact.
type _insightCustomReport = Assert<Exact<ApiInsightCustomReportView, WebInsightCustomReportView>>;
type _insightCustomReportRendered = Assert<
  Exact<ApiInsightCustomReportRenderedView, WebInsightCustomReportRenderedView>
>;
// INS report schedules (x228): a member's own recurring insights-report definition, created/listed/
// deleted over `/insights/report-schedules`. The screen reads exactly this response, so the pair is Exact.
type _insightReportSchedule = Assert<Exact<ApiReportScheduleView, WebReportScheduleView>>;
// PREF-QUIET (x215): the member's own notification quiet-hours window and active check.
type _quietHours = Assert<Exact<ApiQuietHoursView, WebQuietHoursView>>;
type _quietHoursActive = Assert<Exact<ApiQuietHoursActiveView, WebQuietHoursActiveView>>;
// PRF keyboard shortcuts (x286): the member's own command-palette shortcut overrides — the resolved
// map, one resolved shortcut, and the rebind result — read/rebound/reset over `/me/shortcuts`.
type _shortcutMap = Assert<Exact<ApiShortcutMapView, WebShortcutMapView>>;
type _shortcutView = Assert<Exact<ApiShortcutView, WebShortcutView>>;
type _resolvedShortcutView = Assert<Exact<ApiResolvedShortcutView, WebResolvedShortcutView>>;
// Home widget preferences (x243): the member's own Home widget order/hidden set over `/home/widget-prefs`.
type _homeWidgetPrefs = Assert<Exact<ApiHomeWidgetPrefsView, WebHomeWidgetPrefsView>>;
type _digestPref = Assert<Exact<ApiDigestPrefView, WebDigestPrefView>>;
// Approval delegation (x300): a delegator's own delegation over `/approvals/delegations`. The screen
// reads exactly this response, so the pair is Exact.
type _approvalDelegation = Assert<Exact<ApiApprovalDelegationView, WebApprovalDelegationSummary>>;
type _conversation = Assert<Exact<ApiConversationView, WebConversationSummary>>;
type _message = Assert<Exact<ApiMessageView, WebMessageSummary>>;
// CHAT my-mentions (x254): the caller's own recent mentions across their channels, read over
// `/me/mentions`. The screen reads exactly this response, so the pair is Exact.
type _mention = Assert<Exact<ApiMentionView, WebMentionSummary>>;
type _messageRevision = Assert<Exact<ApiMessageRevisionView, WebMessageRevisionSummary>>;
type _messageReactionTally = Assert<Exact<ApiMessageReactionTallyView, WebMessageReactionTally>>;
// x247. The pinned-message reference the strip lists and a pin write returns — the same shape on
// both sides, so the pair is Exact.
type _pinnedMessage = Assert<Exact<ApiPinnedMessageView, WebPinnedMessage>>;
// x249. A message's thread replies (`GET`/`POST …/messages/:messageId/thread`). The screen reads
// exactly these responses, so both pairs are Exact.
type _threadReply = Assert<Exact<ApiThreadReplyView, WebThreadReplyView>>;
type _thread = Assert<Exact<ApiThreadView, WebThreadView>>;
type _inboxBundle = Assert<Exact<ApiInboxBundleView, WebInboxBundle>>;
type _inboxUsageNotice = Assert<Exact<ApiInboxUsageNoticeView, WebInboxUsageNotice>>;
type _inboxPage = Assert<Exact<ApiInboxPageView, WebInboxPage>>;
type _portalInboxBundle = Assert<Exact<ApiPortalInboxBundleView, WebPortalInboxBundle>>;
type _portalInboxPage = Assert<Exact<ApiPortalInboxPageView, WebPortalInboxPage>>;
type _portalProject = Assert<Exact<ApiPortalProjectView, WebPortalProject>>;
type _portalUpdate = Assert<Exact<ApiPortalUpdateView, WebPortalUpdate>>;
// x201: the internal edit/unpublish response carries updatedAt (the client PortalUpdate does not).
type _updateEdit = Assert<Exact<ApiUpdateEditView, WebUpdateEdit>>;
// A10: the internal updates list names the author, the linked milestone and the first client open.
type _managedUpdate = Assert<Exact<ApiManagedUpdateView, WebManagedUpdate>>;
// SEC / Portal update comments (x203): the internal thread and the client projection. The panel
// reads exactly these responses, so both pairs are Exact; the client view drops the staff author.
type _updateComment = Assert<Exact<ApiUpdateCommentView, WebUpdateComment>>;
type _clientUpdateComment = Assert<Exact<ApiClientUpdateCommentView, WebClientUpdateComment>>;
// POR client portal (x304): the internal record returned by create and the client projection. The
// client view drops the staff author and createdAt; both pairs are Exact.
type _portalAnnouncement = Assert<Exact<ApiPortalAnnouncementView, WebPortalAnnouncement>>;
type _clientPortalAnnouncement = Assert<
  Exact<ApiClientPortalAnnouncementView, WebClientPortalAnnouncement>
>;
// SEC / Client portal messages (x322): the client posts and reads their own thread (the projection,
// no author/scope/tenant), and staff read the studio's inbound list (the full record). The screen
// reads exactly these responses, so both pairs are Exact.
type _clientMessage = Assert<Exact<ApiClientMessageView, WebClientMessage>>;
type _adminClientMessage = Assert<Exact<ApiAdminClientMessageView, WebAdminClientMessage>>;
type _projectRisk = Assert<Exact<ApiProjectRiskView, WebProjectRisk>>;
type _clientRisk = Assert<Exact<ApiClientRiskView, WebClientRisk>>;
// SEC / Client portal access log (x237): the internal audit read of what a client accessed. The
// `PortalAccessLogScreen` reads exactly this response, so the pair is Exact. There is no client-facing
// pair — the log is internal, never projected to a client.
type _portalAccessLog = Assert<Exact<ApiPortalAccessLogView, WebPortalAccessLogEvent>>;
// SEC / Client portal settings (x238): the internal per-project portal settings read/save over
// `…/projects/:id/portal-settings`. `PortalSettingsScreen` reads exactly this response (welcome,
// accent, the two toggles, plus the internal `updatedBy`/`updatedAt`), so the pair is Exact. The
// client projection (`PortalSettingsClientView`) drops `updatedBy`/`updatedAt`/`projectId` and has no
// web consumer yet — it is exempted in scripts/contracts-check.mjs.
type _portalSettings = Assert<Exact<ApiPortalSettingsView, WebPortalSettingsView>>;
type _portalFile = Assert<Exact<ApiPortalFileView, WebPortalFile>>;
type _portalPerson = Assert<Exact<ApiPortalPersonView, WebPortalPerson>>;
type _portalWorkItem = Assert<Exact<ApiPortalWorkItemView, WebPortalWorkItem>>;
// CONTRACT-001 (x114): the client portal's deliverables and their file lists. The screen reads
// exactly these responses, so both pairs are Exact.
type _portalDeliverable = Assert<Exact<ApiPortalDeliverableView, WebPortalDeliverable>>;
type _portalDeliverableFile = Assert<Exact<ApiPortalDeliverableFileView, WebPortalDeliverableFile>>;
type _projectMilestone = Assert<Exact<ApiProjectMilestoneView, WebProjectMilestone>>;
type _clientMilestone = Assert<Exact<ApiClientMilestoneView, WebClientMilestone>>;
// SEC / Portal milestone lifecycle (x202): PATCH/complete return the internal edit view (the full
// record plus `updatedAt` — the completion date). Exact against the web `MilestoneEdit`.
type _milestoneEdit = Assert<Exact<ApiMilestoneEditView, WebMilestoneEdit>>;
type _projectClient = Assert<Exact<ApiProjectClientView, WebProjectShare>>;
// Wave 4 (Q1 Clients screen, Q2 New project client picker): client-organization CRUD and
// client memberships now have web consumers in both lib/api/clients.ts and lib/api/project-client.ts.
type _clientOrganization = Assert<Exact<ApiClientOrganizationView, WebClientOrganization>>;
type _clientOrganizationView = Assert<Exact<ApiClientOrganizationView, WebClientOrganizationView>>;
type _clientMembership = Assert<Exact<ApiClientMembershipView, WebClientMembership>>;
type _clientMembershipView = Assert<Exact<ApiClientMembershipView, WebClientMembershipView>>;
type _project = Assert<Exact<ApiProjectView, WebProjectSummary>>;

/**
 * Public & trust site (module 1, x156). `GET /v1/public/site/home` — the marketing home content.
 * `MarketingHomeScreen` reads exactly this deterministic payload (hero, features, CTA targets), so
 * the pair is Exact.
 */
type _publicHome = Assert<Exact<ApiPublicHomeView, WebPublicHome>>;

/**
 * Public & trust site (module 1, x187). `GET /v1/public/site/resources` and `…/resources/:slug` —
 * the resources/guides index and one article. `MarketingResourcesScreen` reads the index projection
 * and `MarketingResourceScreen` reads one article, so both pairs are Exact.
 */
type _publicResourceList = Assert<Exact<ApiPublicResourceListView, WebPublicResourceListView>>;
type _publicResource = Assert<Exact<ApiPublicResourceView, WebPublicResourceView>>;

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
 * PROJ / module 8 (x209). `ProjectInternalRiskView` (`GET`/`POST …/projects/:id/risk-register` and the
 * `PATCH …/risk-register/:riskId` response) — a project's internal risk on a likelihood×impact matrix,
 * with a computed `severity`, a `mitigation` plan and a lifecycle `status`. Paired with a live web
 * consumer: `ProjectRiskRegisterScreen` reads exactly this response, so this is a real `Exact` pair.
 * Distinct from the client-facing `ProjectRiskView` (x140): this register is internal-only, never
 * projected to a client.
 */
type _projectInternalRisk = Assert<
  Exact<ApiProjectInternalRiskView, WebProjectInternalRiskSummary>
>;

/**
 * PROJ / module 8 (x235). `ProjectStatusUpdateView` (an item of `GET …/projects/:id/status-updates`
 * and the `POST` response) and its keyset `ProjectStatusUpdatePage` wrapper — a project's **internal**
 * status changelog entry (`status_band`, `body`, who posted it and when). Paired with a live web
 * consumer: `ProjectStatusUpdatesScreen` reads exactly these, so both are real `Exact` pairs. Distinct
 * from the client-facing x125 portal updates: this log is internal-only, never projected to a client.
 */
type _projectStatusUpdate = Assert<
  Exact<ApiProjectStatusUpdateView, WebProjectStatusUpdateSummary>
>;
type _projectStatusUpdatePage = Assert<
  Exact<ApiProjectStatusUpdatePageView, WebProjectStatusUpdatePage>
>;

/**
 * PROJ / module 8 (x234). `ProjectTemplateView` (`GET`/`POST …/organizations/:orgSlug/projects/templates`)
 * — a reusable project template: a `name`, an optional `description`, the `defaultObjectives` a project
 * made from it starts with, and its author/created instant. Org-scoped (no `projectId`). Paired with a
 * live web consumer: `ProjectTemplatesScreen` reads exactly this response, so this is a real `Exact`
 * pair; `instantiate` returns an ordinary project (`ProjectSummary`), covered by the projects pairing.
 */
type _projectTemplate = Assert<Exact<ApiProjectTemplateView, WebProjectTemplateView>>;

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
 * PROJ / module 8 (x208). `ProjectHealthView` (`GET …/projects/health` and
 * `GET …/projects/:projectId/health`) — one project's computed health: a fixed-weight 0..100 score, a
 * green/amber/red/neutral band, and the signal counts (overdue milestones, open/high risks, objective
 * tallies) it was derived from. Paired with a live web consumer: `ProjectHealthScreen` reads exactly
 * this response, so this is a real `Exact` pair, including the nested `signals` object, which is the
 * same shape on both sides.
 */
type _projectHealth = Assert<Exact<ApiProjectHealthView, WebProjectHealthSummary>>;

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
 * PROJ / module 8 (x236). `MilestoneLinkView` (`GET`/`POST …/projects/milestones/:id/links` response)
 * — the "depends-on" edge from one milestone to a prerequisite, with the prerequisite's title and
 * status. Paired with a live web consumer: `MilestoneDependenciesPanel` reads exactly this response,
 * so this is a real `Exact` pair.
 */
type _milestoneLink = Assert<Exact<ApiMilestoneLinkView, WebMilestoneLink>>;

/**
 * PROJ / module 8 (x207). `KeyResultView` (`GET`/`POST …/objectives/:id/key-results` and the
 * `PATCH …/key-results/:keyResultId` response) — an objective's measurable key result with its numeric
 * target/current value, unit, and the server-computed `progressPercent`. Paired with a live web
 * consumer: `KeyResultsScreen` reads exactly this response, so this is a real `Exact` pair.
 */
type _keyResult = Assert<Exact<ApiKeyResultView, WebKeyResult>>;

/**
 * DEC / module 12 (x149). `DecisionWorkLinkView` (`GET`/`POST …/decisions/:id/work-links` response) —
 * the edge from a decision to a work item, with the linked item's title and state. Paired with a live
 * web consumer: `DecisionWorkLinksPanel` reads exactly this response, so this is a real `Exact` pair.
 */
type _decisionWorkLink = Assert<Exact<ApiDecisionWorkLinkView, WebDecisionWorkLink>>;

/**
 * PEOPLE / module 14 (x171). `PersonAllocationView` (`GET`/`POST …/projects/:id/allocations` response)
 * — a member's allocation to a project: the membership, the percent, the optional start/end dates.
 * Paired with a live web consumer: `ProjectAllocationsScreen` reads exactly this response, so this is a
 * real `Exact` pair.
 */
type _personAllocation = Assert<Exact<ApiPersonAllocationView, WebPersonAllocationSummary>>;

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
 * DOC revision history (x241). `DocRevisionView` (`GET`/`POST …/documents/:id/revisions`,
 * `POST …/documents/:id/revisions/:revId/restore`) — one immutable revision of a document. The
 * `DocRevisionsScreen` reads exactly this response for its history/restore, so the pair is Exact.
 */
type _docRevision = Assert<Exact<ApiDocRevisionView, WebDocRevisionSummary>>;

/**
 * DOC bookmarks / favorites (x242). `DocBookmarkView` (`PUT …/documents/:id/bookmark`,
 * `GET …/document-bookmarks`) — one of the caller's bookmarked documents. The `MyBookmarksScreen` and
 * the bookmark toggle read exactly this response, so the pair is Exact.
 */
type _docBookmark = Assert<Exact<ApiDocBookmarkView, WebDocBookmarkSummary>>;

/**
 * DOC subscriptions (x312). `DocSubscriptionView` (`PUT/DELETE …/documents/:id/subscription`,
 * `GET …/me/doc-subscriptions`) — one of the caller's followed documents. The `DocSubscriptionsView`
 * list and the follow toggle read exactly this response, so the pair is Exact.
 */
type _docSubscription = Assert<Exact<ApiDocSubscriptionView, WebDocSubscriptionSummary>>;

/**
 * CH-07 saved messages / message bookmarks (x248). `SavedMessageView` (`PUT/DELETE
 * …/conversations/:cid/messages/:mid/bookmark`, `GET …/message-bookmarks`) — one of the caller's
 * privately saved messages. `SavedMessagesScreen` and the per-message Save toggle read exactly this
 * response (`body`/`bodyRich` withheld once moderated), so the pair is Exact. Distinct from the
 * document bookmark above.
 */
type _messageBookmark = Assert<Exact<ApiSavedMessageView, WebSavedMessageSummary>>;

/**
 * INBOX saved filters (IN-02, x261). `InboxSavedFilterView` (`POST`/`GET`/`DELETE
 * …/inbox/saved-filters`) — one of the caller's named inbox filter sets. The
 * `InboxSavedFiltersScreen` reads exactly this response, so the pair is Exact. `organizationId`/
 * `membershipId` are on neither side — the API never echoes the tenant id, and the membership is
 * always the caller's own.
 */
type _inboxSavedFilter = Assert<Exact<ApiInboxSavedFilterView, WebInboxSavedFilterView>>;

/**
 * Org glossary of terms (x263). `GlossaryTermView` (`GET/POST/PATCH/DELETE …/glossary/terms`) — one
 * glossary term and its definition. The `GlossaryScreen` reads exactly this response, so the pair is
 * Exact.
 */
type _glossaryTerm = Assert<Exact<ApiGlossaryTermView, WebGlossaryTermSummary>>;

/**
 * DOC collections (x264). `CollectionView` (`GET`/`POST …/doc-collections`) — one named collection —
 * and `CollectionDocumentView` (`GET …/doc-collections/:id`, `PUT …/:id/documents/:docId`) — one
 * document in a collection. The collections screen reads exactly these responses, so each pair is Exact.
 */
type _docCollection = Assert<Exact<ApiCollectionView, WebDocCollectionSummary>>;
type _collectionDocument = Assert<Exact<ApiCollectionDocumentView, WebCollectionDocumentSummary>>;

/**
 * PROJ project favorites (x268). `ProjectFavoriteView` (`PUT …/projects/:id/favorite`,
 * `GET …/projects/favorites`) — one of the caller's favorited projects. The `ProjectFavoritesSwitcher`
 * and the favorite star read exactly this response, so the pair is Exact.
 */
type _projectFavorite = Assert<Exact<ApiProjectFavoriteView, WebProjectFavoriteSummary>>;

/**
 * x269 document tags. `DocTagView` (`GET`/`POST …/doc-tags`) is a tag definition; `DocumentTagView`
 * (`GET`/`PUT`/`DELETE …/documents/:id/tags`) is a tag on a document. The `DocTagsScreen` and the
 * document tag helpers read exactly these responses, so both pairs are Exact.
 */
type _docTag = Assert<Exact<ApiDocTagView, WebDocTag>>;
type _documentTag = Assert<Exact<ApiDocumentTagView, WebDocumentTag>>;

/**
 * CH-06 composer attachments (x275). `MessageAttachmentView` (`POST`/`DELETE`/`GET
 * …/conversations/:cid/messages/:mid/attachments`) — one file attached to a message. The
 * `MessageAttachmentsView` chips and picker read exactly this response, so the pair is Exact.
 * `sizeBytes` is `null` before the file's first version; the internal object key is never echoed.
 */
type _messageAttachment = Assert<Exact<ApiMessageAttachmentView, WebMessageAttachmentSummary>>;

/**
 * DOC links + backlinks (x296). `DocLinkView` (`GET`/`POST …/documents/:id/links`, `DELETE
 * …/links/:targetDocId`, `GET …/documents/:id/backlinks`) — one linked document (the target of an
 * outgoing link or the source of a backlink). The `DocBacklinksPanel` reads exactly this response for
 * both directions, so the pair is Exact. The tenant id and the author are on neither side.
 */
type _docLink = Assert<Exact<ApiDocLinkView, WebDocLinkSummary>>;

/**
 * DOC read state (x297). `DocReadStateView` (`PUT …/documents/:id/read`, `GET
 * …/document-read-state?docIds=`) — the caller's read cursor for one document. The `DocReadStateScreen`
 * and the row badges read exactly this response, so the pair is Exact. `organizationId`/`membershipId`
 * are absent on both sides: the wire never echoes the tenant id, and the membership is the caller's own.
 */
type _docReadState = Assert<Exact<ApiDocReadStateView, WebDocReadStateSummary>>;

/**
 * INS metric favorites (x303). `MetricFavoriteView` (`PUT/DELETE …/insights/metric-favorites/:metricKey`,
 * `GET …/insights/metric-favorites`) — one of the caller's starred insight metrics. The
 * `MetricFavoritesView` screen reads exactly this response, so the pair is Exact.
 */
type _metricFavorite = Assert<Exact<ApiMetricFavoriteView, WebMetricFavoriteSummary>>;

/**
 * Docs "collaboration later" (x132). `DocumentCommentView` (`GET`/`POST
 * …/documents/:documentId/comments`) — one comment on a document. The `DocumentCommentsPanel` beside
 * `DocumentViewScreen` reads exactly this response, so the pair is Exact. `organizationId` is on
 * neither side — the API never echoes the tenant id into a response body.
 */
type _documentComment = Assert<Exact<ApiDocumentCommentView, WebDocumentCommentView>>;
// Docs review workflow (x313). `DocReviewView` (`GET`/`POST …/documents/:documentId/reviews`,
// `PUT …/reviews/:reviewId`) — one review request/decision on a document. The `DocReviewsView` beside
// the document view reads exactly this response, so the pair is Exact.
type _docReview = Assert<Exact<ApiDocReviewView, WebDocReviewView>>;

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
 * x317. `DecisionCommentView` (`GET`/`POST …/decisions/:id/comments` response) — one internal
 * comment on a decision. Paired with a live web consumer: `DecisionCommentsView` reads exactly this
 * response, so the pair is Exact. `organizationId` is absent on both sides — the wire projection
 * never echoes the tenant id.
 */
type _decisionComment = Assert<Exact<ApiDecisionCommentView, WebDecisionComment>>;

/**
 * FEAT: Billing invoice history (x179). `InvoiceView` (`GET …/billing/invoices`, the list row) and
 * `InvoiceDetailView` (`GET …/billing/invoices/:invoiceId`, the summary plus the bounded line-item
 * breakdown). Paired with a live web consumer — `BillingInvoicesScreen` reads exactly these to render
 * the history table and the detail drawer — so both are real `Exact` pairs. `amountCents` is integer
 * cents on both sides; the `status` union (`paid | open | void`) is the same on both.
 */
type _invoice = Assert<Exact<ApiInvoiceView, WebInvoiceSummary>>;
type _invoiceDetail = Assert<Exact<ApiInvoiceDetailView, WebInvoiceDetail>>;

/**
 * FEAT: Billing invoice line items (x225). `InvoiceLineItemView` (one billed line) and
 * `InvoiceLinesView` (`GET …/billing/invoices/:invoiceId/lines`, the bounded line array plus the
 * reconciliation between the summed lines and the stored header total). Paired with a live web
 * consumer — `InvoiceLineItemsScreen` reads exactly these to render the line table and its reconciled
 * total — so both are real `Exact` pairs. `amountCents`/`unitAmountCents` are integer minor units on
 * both sides.
 */
type _invoiceLineItem = Assert<Exact<ApiInvoiceLineItemView, WebInvoiceLineItem>>;
type _invoiceLines = Assert<Exact<ApiInvoiceLinesView, WebInvoiceLines>>;

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

/** A5 (BK5): the client people on a meeting and the project's addable client people, read by `MeetingDetailScreen`. */
type _meetingClientAttendee = Assert<
  Exact<ApiMeetingClientAttendeeView, WebMeetingClientAttendeeView>
>;
type _clientAttendeeCandidate = Assert<
  Exact<ApiClientAttendeeCandidateView, WebClientAttendeeCandidateView>
>;

/**
 * CAL / MTG-03 meeting action items (x266). `GET`/`POST .../meetings/:meetingId/action-items` and
 * `PATCH`/`DELETE .../action-items/:actionItemId` — a meeting's action items, read and driven by
 * `MeetingActionItemsScreen`. The owner is named by `ownerMembershipId` (or null); paired Exact, so
 * a rename or retype on either side fails the gate.
 */
type _meetingActionItem = Assert<Exact<ApiMeetingActionItemView, WebMeetingActionItemView>>;

/**
 * CAL meeting RSVP (x240). `GET`/`PUT .../meetings/:meetingId/rsvp` — a member's own response
 * (`accepted`/`declined`/`tentative`) and the meeting's response counts, read and driven by
 * `MeetingRsvpScreen`. The caller's own answer is `response` (`null` until they answer); paired
 * Exact, so a rename or retype on either side fails the gate. `organizationId` is on neither side —
 * the API never echoes the tenant id into a response body.
 */
type _meetingRsvp = Assert<Exact<ApiMeetingRsvpView, WebMeetingRsvpView>>;

/**
 * CAL meeting time-option poll (x298). `POST`/`GET .../meetings/:meetingId/time-poll` and
 * `PUT .../time-poll/options/:optionId/vote` — an organiser's candidate time slots, each invitee's
 * yes/maybe/no vote and the per-option tally, read and driven by `MeetingTimePollView`. The caller's
 * own vote per option is `ownVote` (`null` until they vote); paired Exact, so a rename or retype on
 * either side fails the gate. `organizationId` is on neither side — the API never echoes the tenant
 * id into a response body.
 */
type _meetingTimePoll = Assert<Exact<ApiMeetingTimePollView, WebMeetingTimePollView>>;

/**
 * CAL agenda / day view (x127). `GET .../meetings/agenda?from&to` — the tenant's meetings grouped by
 * their start day, read by `MeetingAgendaScreen`. A read-only composition over `meetings` with no
 * new table; the view lives on the controller (no service, like the shape it composes). Paired Exact
 * with the web `MeetingAgendaView`; the nested day/entry shapes are inlined on both sides.
 */
type _meetingAgenda = Assert<Exact<ApiMeetingAgendaView, WebMeetingAgendaView>>;

/**
 * CAL week/month grid (x212). `GET .../meetings/grid?range=week|month&anchor=` — the tenant's
 * meetings and recurrence occurrences laid out on a week or month window, every day a cell, read by
 * `CalendarGridScreen`. A read-only composition over `meetings` and `meeting_series` with no new
 * table; the view lives on the service. Paired Exact with the web `CalendarGridView`; the nested
 * day/meeting/occurrence shapes are inlined on both sides.
 */
type _calendarGrid = Assert<Exact<ApiCalendarGridView, WebCalendarGridView>>;

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
 * CAL agenda templates (x314). `GET`/`POST .../meetings/agenda-templates`, `PUT`/`DELETE
 * .../agenda-templates/:templateId`, and `POST .../meetings/:meetingId/apply-agenda-template` — a
 * tenant's reusable meeting agendas (name + ordered items), listed/created/edited/removed and applied
 * by `MeetingAgendaTemplatesView`. The template view is paired Exact from the start — the screen and
 * its `apps/web` shape ship in the same slice — so a renamed or retyped field on either side is a
 * compile error here. The apply response is a `{ meetingId, templateId, seeded, skipped }` shape with
 * no named `*View`, so nothing to pair there. The nested item shape is inlined on both sides.
 */
type _agendaTemplate = Assert<Exact<ApiAgendaTemplateView, WebAgendaTemplateView>>;

/**
 * CAL per-occurrence override (x213). `GET`/`POST`/`DELETE .../meeting-series/:seriesId/occurrences/
 * :date` — the exception for one occurrence of a recurring series, read/upserted/removed by
 * `OccurrenceOverrideControl`. The view is paired `Exact` from the start — the control and its
 * `apps/web` shape ship in the same slice — so a renamed or retyped field on either side is a compile
 * error here. `status` is the same `moved|cancelled` union and the `new*` move fields are the same
 * nullable shapes on both sides; `organizationId` is absent on both (the wire never echoes the tenant).
 */
type _occurrenceOverride = Assert<Exact<ApiOccurrenceOverrideView, WebOccurrenceOverrideView>>;

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
 * Billing / module 19 (x177) — `GET/POST …/billing/subscription`. The organization's current plan:
 * `{ planId, status: 'active' | 'pending_change', currentPeriodEnd }`. Paired with a live web
 * consumer — x177 ships `SubscriptionScreen` — so this is an `Exact` pair, not an exemption.
 */
type _subscription = Assert<Exact<ApiSubscriptionView, WebSubscriptionView>>;

/**
 * Billing / module 19 (x198) — `GET …/billing/plan-change/preview?target=&seats=`. A deterministic
 * cost estimate of moving to a target plan at a seat count: the new base and seat deltas and the
 * monthly change, all integer cents, against the tenant's current subscription. Read-only, no charge.
 * Paired with a live web consumer — x198 ships `PlanChangePreviewScreen` — so this is an `Exact` pair.
 */
type _planChangePreview = Assert<Exact<ApiPlanChangePreviewView, WebPlanChangePreviewView>>;

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
 * x211 — `POST/GET …/insights/snapshots`. One stored snapshot: `id`, `kind` (`portfolio` |
 * `workload`), the ISO `capturedAt`, and the opaque `payload` (the computed metrics stored whole).
 * Paired with a real web consumer — x211 ships `InsightSnapshotsScreen`, so this is a live `Exact`
 * pair, not an exemption. The list route returns `SnapshotView[]` and the by-id route one
 * `SnapshotView`, so the element shape is the one contract both sides hold.
 */
type _insightSnapshot = Assert<Exact<ApiSnapshotView, WebSnapshotView>>;

/**
 * x271 — `POST/GET/DELETE …/insights/snapshots/:snapshotId/annotations`. One annotation on a snapshot:
 * `id`, the `authorMembershipId` (so the screen marks the caller's own notes), the `note`, and the ISO
 * `createdAt`. Paired with a real web consumer — x271 ships `InsightAnnotationsScreen` — so this is a
 * live `Exact` pair, not an exemption. The list route returns `{ annotations: InsightAnnotationView[] }`
 * and the create route one `InsightAnnotationView`, so the element shape is the one contract both sides
 * hold; `organizationId`/`snapshotId` are absent on both sides (never echoed; the snapshot is in path).
 */
type _insightAnnotation = Assert<Exact<ApiInsightAnnotationView, WebInsightAnnotationView>>;

/**
 * x169 — `GET …/people/:membershipId`. One member's profile: the non-sensitive header (`displayName`,
 * `role`, `status`), the `projects` they belong to (element paired through this parent), and their
 * `openWorkCount`, plus `computedAt`. Paired with a real web consumer — `PersonProfileScreen` reads
 * it — so this is a live `Exact` pair, not an exemption.
 */
type _personProfile = Assert<Exact<ApiPersonProfileView, WebPersonProfileView>>;

/**
 * x230 — `PUT/GET …/insights/targets`. One org-wide target: the `metric` (a closed vocabulary), the
 * bounded `targetValue`, and the `period`. `GET …/targets/status` adds the live `currentValue`, the
 * `attainment` ratio (null on a zero target — no divide) and the `status` (`on_track` | `behind`).
 * Both are paired with the real web consumer the `InsightTargetsScreen` reads, live `Exact` pairs.
 */
type _insightTarget = Assert<Exact<ApiMetricTargetView, WebMetricTargetView>>;
type _insightTargetStatus = Assert<Exact<ApiMetricTargetStatusView, WebMetricTargetStatusView>>;

/**
 * x319 — `PUT/GET/DELETE …/insights/metric-alerts`. A member's own threshold alert per metric: the
 * `metricKey` (a closed vocabulary), the `comparator` (`gte` | `lte`) and the bounded `threshold`. The
 * `GET` read adds the live `currentValue` (null when no workload snapshot exists yet — no fabricated
 * number) and `breached`. Both are paired with the real web consumer the `InsightMetricAlertsScreen`
 * reads, live `Exact` pairs.
 */
type _insightMetricAlert = Assert<Exact<ApiMetricAlertView, WebMetricAlertView>>;
type _insightMetricAlertStatus = Assert<Exact<ApiMetricAlertStatusView, WebMetricAlertStatusView>>;

/**
 * x229 — `GET …/insights/compare?metric&periodA&periodB`. A metric compared across two windows:
 * `metric` (`work_items_created` | `meetings_held`), `a` and `b` (each window's `start`/`end`/`value`),
 * `delta` (`b − a`) and `pct` (the fractional change, `null` when the base is 0), plus `computedAt`.
 * Paired with a real web consumer — x229 ships `InsightComparisonScreen`, so this is a live `Exact`
 * pair, not an exemption.
 */
type _insightComparison = Assert<Exact<ApiPeriodComparisonView, WebPeriodComparisonView>>;

/**
 * x216 — `GET/PUT …/people/:membershipId/profile`. A member's tenant-local editable profile:
 * `membershipId` plus the four editable fields (`department`, `bio`, `contactEmail`, `contactPhone`,
 * each nullable). Distinct from x169's read-only `PersonProfileView` — it carries no global identity
 * field (never `displayName`). Paired with a real web consumer — `MemberProfileEditScreen` reads and
 * saves it — so this is a live `Exact` pair, not an exemption.
 */
type _memberProfile = Assert<Exact<ApiMemberProfileView, WebMemberProfileView>>;

/**
 * t2-b — `GET/PUT …/me/profile`. The signed-in member's own profile card: `displayName`, the
 * read-only sign-in `email`, and the tenant-local `jobTitle` (nullable). Paired with the real web
 * consumer — the Profile & preferences screen reads and saves it — so a live `Exact` pair.
 */
type _myProfile = Assert<Exact<ApiMyProfileView, WebMyProfileView>>;

/**
 * x262 — `…/people/teams`. People teams (module 14, planning PEO-03). `TeamView` (`GET`/`POST`
 * response) is the list row; `TeamDetailView` (`GET …/teams/:id`) carries the roster of
 * `TeamMemberView` (paired through its parent and on its own). All three pair Exact with the
 * `TeamsScreen`'s web consumer, so the API projections and the screen cannot drift.
 */
type _teamView = Assert<Exact<ApiTeamView, WebTeamView>>;
type _teamMemberView = Assert<Exact<ApiTeamMemberView, WebTeamMemberView>>;
type _teamDetailView = Assert<Exact<ApiTeamDetailView, WebTeamDetailView>>;

/**
 * x134 — `GET …/insights/workload-forecast?weeks`. The forward-looking workload forecast: `weeks`
 * (per upcoming week the committed open work and constant capacity, with an over-capacity flag),
 * `totals` (the aggregate across the horizon), and `computedAt`. The `InsightsForecastScreen` reads
 * exactly this response, so this is a live `Exact` pair, not an exemption.
 */
type _workloadForecast = Assert<Exact<ApiWorkloadForecastView, WebWorkloadForecastView>>;

/**
 * x302 — `GET`/`PUT …/insights/dashboard-layout`. The member's own arrangement of the insights-
 * dashboard metric tiles: `tiles` is an array of `{ key, position, visible }` over the fixed
 * known-metric allowlist. The `InsightDashboardLayoutScreen` reads and writes exactly this response,
 * so this is a live `Exact` pair, not an exemption.
 */
type _insightDashboardLayout = Assert<
  Exact<ApiInsightDashboardLayoutView, WebInsightDashboardLayoutView>
>;

/**
 * x154 — `GET …/client-requests/aging`. The request-aging roll-up: `thresholds` (the fixed day
 * boundaries), `counts` (fresh/aging/overdue plus the uncommitted tally and total), `requests` (the
 * bounded, oldest-first aged rows), and `computedAt`. The `RequestAgingScreen` reads exactly this
 * response, so this is a live `Exact` pair, not an exemption.
 */
type _requestAging = Assert<Exact<ApiRequestAgingView, WebRequestAgingView>>;

/**
 * x265 — `GET`/`PUT …/client-requests/:id/triage`. The internal request triage: `requestId`, the
 * `category` it is filed under (null until triaged), the `assigneeMembershipId` (null when unassigned
 * or untriaged), and `triaged`. The `RequestTriagePanelScreen` reads and writes exactly this shape,
 * so this is a live `Exact` pair, not an exemption.
 */
type _requestTriage = Assert<Exact<ApiRequestTriageView, WebRequestTriageView>>;

/**
 * x299 — `GET`/`POST`/`DELETE …/client-requests/:id/comments`. One internal comment on a client
 * request: `id`/`requestId`/`parentId`/`authorMembershipId`/`body`/`createdAt`, held identical on
 * both sides. `RequestCommentsPanel` reads exactly this shape. Append-with-retract: there is no edit
 * route, so no update shape to pair; `parentId` is `string | null` on both sides (one level of reply).
 */
type _requestComment = Assert<Exact<ApiRequestCommentView, WebRequestComment>>;

/**
 * x316 — `GET/POST/DELETE …/client-requests/:id/tags`. The free-text triage labels on a client
 * request: `clientRequestId` plus `tags` (each an id, its request, the label, who added it and when).
 * `RequestTagsView` reads exactly this response, so this is a live `Exact` pair, not an exemption.
 */
type _requestTags = Assert<Exact<ApiRequestTagsView, WebRequestTagsView>>;

// These three were `Narrows` — the API projection typed a lifecycle column as bare `string`
// while the web declared the union the column is actually constrained to (CONTRACT-001). The API
// side has since been tightened to the domain union at its projection, guarded where a raw
// `varchar` is read, so the pair is now `Exact`: a `state` the web's union does not contain can
// no longer be typed on the API view, and the gate catches it either way.

/** `WorkItemView.state` ↔ `WORK_ITEM_STATES` (`@tmanage/domain`). */
type _workItem = Assert<Exact<ApiWorkItemView, WebWorkItemSummary>>;

/**
 * x206 — the bulk status transition's per-id response. `targetStatus` and each result's
 * `outcome` union must line up on both sides; the nested per-id result is compared structurally.
 */
type _bulkTransition = Assert<Exact<ApiBulkTransitionView, WebBulkTransitionView>>;

/**
 * x145. `WorkChecklistItemView` ↔ `WorkChecklistItem` — one work-item checklist / sub-item
 * (`GET`/`POST …/work-items/:id/checklist`, `PATCH …/checklist/:itemId`). `WorkChecklistPanel`
 * reads exactly this shape, so the `id`/`workItemId`/`label`/`done`/`position`/`createdAt` pair is
 * held identical on both sides.
 */
type _workChecklistItem = Assert<Exact<ApiWorkChecklistItemView, WebWorkChecklistItem>>;

/**
 * x307. `WorkSubtaskView` ↔ `WorkSubtask` and `WorkSubtaskListView` ↔ `WorkSubtaskList` — one
 * work-item subtask and the list-plus-roll-up (`GET`/`POST …/work-items/:id/subtasks`,
 * `PUT`/`DELETE …/subtasks/:subtaskId`). `WorkSubtasksView` reads exactly these shapes, so the
 * `id`/`workItemId`/`title`/`done`/`position`/`createdAt` item pair and the `items`/`done`/`total`
 * list pair are held identical on both sides.
 */
type _workSubtask = Assert<Exact<ApiWorkSubtaskView, WebWorkSubtask>>;
type _workSubtaskList = Assert<Exact<ApiWorkSubtaskListView, WebWorkSubtaskList>>;

/**
 * x147. `WorkCommentView` ↔ `WorkComment` — one work-item comment / activity entry
 * (`GET`/`POST …/work-items/:id/comments`). `WorkCommentsPanel` reads exactly this shape, so the
 * `id`/`workItemId`/`authorMembershipId`/`body`/`createdAt` pair is held identical on both sides.
 * Append-only: there is no edit or delete route, so no update shape to pair.
 */
type _workComment = Assert<Exact<ApiWorkCommentView, WebWorkComment>>;

/**
 * x204. `WorkItemLinkView` ↔ `WorkItemLink` — one typed link authored on a work item
 * (`GET`/`POST …/work-items/:id/links`, `DELETE …/links/:linkId`). `WorkItemDependenciesScreen`
 * reads exactly this shape, so the `id`/`fromWorkItemId`/`toWorkItemId`/`toWorkItemTitle`/
 * `toWorkItemState`/`linkType`/`createdAt` pair is held identical on both sides, `linkType` the same
 * `blocks | blocked_by | relates` union. A link is immutable: there is no edit route, so no update
 * shape to pair.
 */
type _workItemLink = Assert<Exact<ApiWorkItemLinkView, WebWorkItemLink>>;

/**
 * x274. `WorkRelationsGraphView` ↔ `WorkRelationsGraph` — the read-only relations graph of a work
 * item (`GET …/work-items/:id/relations/graph?depth=`). `WorkRelationsGraphView` (the web panel)
 * reads exactly this shape, so the `rootId`/`depth`/`nodes`/`edges` pair is held identical on both
 * sides: each node's `workItemId`/`title`/`state`/`depth`/`isRoot` and each edge's
 * `fromWorkItemId`/`toWorkItemId`/`linkType` match, `linkType` the same `blocks | blocked_by |
 * relates` union. It is read-only — no write shape to pair.
 */
type _workRelationsGraph = Assert<Exact<ApiWorkRelationsGraphView, WebWorkRelationsGraph>>;

/**
 * x205. `ItemFileView` ↔ `ItemFile` — one work-item file attachment
 * (`GET`/`POST`/`DELETE …/work-items/:id/files`). `WorkItemFilesScreen` reads exactly this shape,
 * so the `id`/`workItemId`/`fileAssetId`/`fileName`/`attachedByMembershipId`/`createdAt` pair is
 * held identical on both sides. Attach/detach only: there is no edit route, so no update shape.
 */
type _itemFile = Assert<Exact<ApiItemFileView, WebItemFile>>;

/**
 * x231. `TimeLogView` ↔ `TimeLog` — one work-item logged-effort entry, and `TimeLogListView` ↔
 * `TimeLogList` — the list response with its summed total (`GET`/`POST`/`DELETE …/work-items/:id/
 * time-logs`). `WorkItemTimeLogScreen` reads exactly these shapes, so the entry's fields and the
 * `{ entries, totalMinutes }` envelope are held identical on both sides.
 */
type _timeLog = Assert<Exact<ApiTimeLogView, WebTimeLog>>;
type _timeLogList = Assert<Exact<ApiTimeLogListView, WebTimeLogList>>;

/**
 * x258. `WorkItemEstimateView` ↔ `WorkItemEstimate` — a work item's effort estimate read beside its
 * logged actual and the variance between them (`GET`/`PUT …/work-items/:id/estimate`).
 * `WorkItemEstimateScreen` reads exactly this shape, so `estimateMinutes`/`actualMinutes`/
 * `varianceMinutes`/`updatedAt` (and their nullability) are held identical on both sides.
 */
type _workItemEstimate = Assert<Exact<ApiWorkItemEstimateView, WebWorkItemEstimate>>;

/**
 * x232. `ItemWatcherView` ↔ `ItemWatcher` — one work-item watcher / subscriber
 * (`GET`/`PUT`/`DELETE …/work-items/:id/watchers`). `WorkWatchersPanel` reads exactly this shape,
 * so the `id`/`workItemId`/`memberId`/`createdAt` pair is held identical on both sides. The roster
 * carries a membership id, never an email: the pair keeps it that way on both sides.
 */
type _itemWatcher = Assert<Exact<ApiItemWatcherView, WebItemWatcher>>;

/**
 * x256. Personal work-item reminders (Work module 7). `WorkItemReminderView` ↔ `WorkItemReminder` —
 * the acting member's reminder on one item (`PUT`/`DELETE …/work-items/:id/reminder`);
 * `DueReminderView` ↔ `DueReminder` — one entry in the own "My Reminders" due list
 * (`GET …/work-items/reminders/due`). `WorkItemReminderView` reads exactly these shapes, and both
 * carry a membership id, never an email — the pair keeps it that way on both sides. No dispatch.
 */
type _workItemReminder = Assert<Exact<ApiWorkItemReminderView, WebWorkItemReminder>>;
type _dueReminder = Assert<Exact<ApiDueReminderView, WebDueReminder>>;

/**
 * x291. `WorkActivityEntryView` ↔ `WorkActivityEntry` — one entry in a work item's merged activity
 * timeline (`GET …/work-items/:id/activity`, read-only). `WorkItemActivityFeed` renders exactly
 * this shape — `id`/`kind`/`action`/`actorId`/`summary`/`occurredAt` — so the projection is held
 * identical on both sides. `actorId` is a display handle (never an email); `null` is a
 * system-initiated action.
 */
type _workActivityEntry = Assert<Exact<ApiWorkActivityEntryView, WebWorkActivityEntry>>;

/**
 * x233. Work item labels / tags (Work module 7). `WorkLabelView` ↔ `WorkLabel` — one org-scoped label
 * definition (`GET`/`POST …/work/labels`); `ItemLabelView` ↔ `ItemLabel` — one label assigned to a
 * work item (`GET`/`PUT …/work-items/:id/labels`, `DELETE …/labels/:labelId`). `WorkLabelsScreen`
 * reads the definitions and `WorkItemLabelChips` reads the assignments, so both pairs are held
 * identical on the two sides. `organizationId` is absent on all four.
 */
type _workLabel = Assert<Exact<ApiWorkLabelView, WebWorkLabel>>;
type _itemLabel = Assert<Exact<ApiItemLabelView, WebItemLabel>>;

/**
 * x306. Work item custom fields (Work module). `WorkCustomFieldDefinitionView` ↔
 * `WorkCustomFieldDefinition` — one org-scoped field definition (`GET`/`POST …/work/custom-fields`,
 * `DELETE …/work/custom-fields/:key`); `WorkCustomFieldValueView` ↔ `WorkCustomFieldValue` — one
 * field resolved against a work item's value (`GET`/`PUT …/work-items/:id/custom-fields`).
 * `WorkCustomFieldsView` reads both shapes, so both pairs are held identical on the two sides.
 * `organizationId` is absent on both.
 */
type _workCustomFieldDefinition = Assert<
  Exact<ApiWorkCustomFieldDefinitionView, WebWorkCustomFieldDefinition>
>;
type _workCustomFieldValue = Assert<Exact<ApiWorkCustomFieldValueView, WebWorkCustomFieldValue>>;

/**
 * x257. Work item recurrence (Work module 7). `WorkItemRecurrenceView` ↔ `WorkItemRecurrence` — a
 * work item's recurrence rule (`GET`/`PUT`/`DELETE …/work-items/:id/recurrence`); `NextOccurrenceView`
 * ↔ `NextOccurrence` — the computed next occurrence (`POST …/recurrence/generate-next`), which
 * creates no work item. `WorkItemRecurrencePanel` reads both shapes, so both pairs are held identical
 * on the two sides. `organizationId` is absent on both.
 */
type _workItemRecurrence = Assert<Exact<ApiWorkItemRecurrenceView, WebWorkItemRecurrence>>;
type _nextOccurrence = Assert<Exact<ApiNextOccurrenceView, WebNextOccurrence>>;

/**
 * x267. Project tags / labels (Projects / portfolio module). `ProjectTagView` ↔ `ProjectTag` — one
 * org-scoped tag definition (`GET`/`POST …/projects/tags`); `ProjectTagAssignmentView` ↔
 * `ProjectTagAssignment` — one tag assigned to a project (`GET …/projects/:id/tags`,
 * `PUT`/`DELETE …/projects/:id/tags/:tagId`). `ProjectTagsScreen` reads the definitions; the
 * assignment helpers in `lib/api/project-tags` consume the assignment shape. `organizationId` is
 * absent on all four — the wire projection never echoes the tenant id.
 */
type _projectTag = Assert<Exact<ApiProjectTagView, WebProjectTag>>;
type _projectTagAssignment = Assert<Exact<ApiProjectTagAssignmentView, WebProjectTagAssignment>>;

/**
 * x270. File tags (Files module). `FileTagView` ↔ `FileTag` — one org-scoped tag definition
 * (`GET`/`POST …/file-tags`); `FileTagAssignmentView` ↔ `FileTagAssignment` — one tag assigned to a
 * file (`GET`/`PUT …/files/:id/tags`, `DELETE …/files/:id/tags/:tagId`). `FileTagsScreen` reads the
 * definitions and the file detail surface reads the assignments, so both pairs are held identical on
 * the two sides. `organizationId` is absent on all four.
 */
type _fileTag = Assert<Exact<ApiFileTagView, WebFileTag>>;
type _fileTagAssignment = Assert<Exact<ApiFileTagAssignmentView, WebFileTagAssignment>>;

/**
 * x292. Reusable work-item checklist templates (Work module 7). `ChecklistTemplateView` ↔
 * `ChecklistTemplate` — one org-scoped template (`GET`/`POST …/work/checklist-templates`,
 * `DELETE …/:templateId`); `ApplyTemplateResultView` ↔ `ApplyTemplateResult` — the result of applying
 * one to a work item (`POST …/work-items/:id/apply-checklist-template/:templateId`).
 * `ChecklistTemplatesView` reads the definitions. `organizationId` is absent on both.
 */
type _checklistTemplate = Assert<Exact<ApiChecklistTemplateView, WebChecklistTemplate>>;
type _applyTemplateResult = Assert<Exact<ApiApplyTemplateResultView, WebApplyTemplateResult>>;

/**
 * x308. Work board columns (Work module 7). `BoardColumnView` ↔ `BoardColumn` — one org-scoped board
 * column (`GET`/`POST …/work/board-columns`, `PUT`/`DELETE …/work/board-columns/:id`), a display
 * grouping over the existing work states. `WorkBoardColumnsView` reads the list, so the pair is held
 * identical on the two sides. `organizationId` is absent on both.
 */
type _boardColumn = Assert<Exact<ApiBoardColumnView, WebBoardColumn>>;

/**
 * x332. File folders (Files module). `FileFolderView` ↔ `FileFolder` — one project-scoped folder
 * (`GET`/`POST …/projects/:id/folders`, `DELETE …/projects/:id/folders/:folderId`);
 * `FileFolderPlacementView` ↔ `FileFolderPlacement` — a file's folder or root
 * (`PUT …/files/:fileId/folder`, `GET …/projects/:id/folders/:folderId/files`). `FileFoldersView`
 * reads the folders and the move / contents helpers in `lib/api/file-folders` consume the placement,
 * so both pairs are held identical on the two sides. `organizationId` is absent on both.
 */
type _fileFolder = Assert<Exact<ApiFileFolderView, WebFileFolder>>;
type _fileFolderPlacement = Assert<Exact<ApiFileFolderPlacementView, WebFileFolderPlacement>>;

/**
 * x333. File comments (Files module). `FileCommentView` ↔ `FileComment` — one comment on a file
 * asset (`GET`/`POST …/files/:fileId/comments`, `DELETE …/files/:fileId/comments/:commentId`). The
 * `FileCommentsView` thread reads exactly this response, so the pair is Exact. `organizationId` is
 * absent, as on every wire projection.
 */
type _fileComment = Assert<Exact<ApiFileCommentView, WebFileComment>>;

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
 * Billing & entitlements (x200). `UsageAlertView` (`GET`/`POST`/`PATCH …/billing/usage-alerts`,
 * response) — one org-scoped usage-alert threshold rule — and `UsageAlertStatusView`
 * (`GET …/billing/usage-alerts/status`) — one rule's current evaluation. Paired with the live web
 * consumer `UsageAlertsScreen` (via `lib/api/billing`): `metric` is `string` on both sides (the closed
 * set is enforced server-side), `breached` is the server's decision, and `organizationId` is absent on
 * both.
 */
type _usageAlert = Assert<Exact<ApiUsageAlertView, WebUsageAlertSummary>>;
type _usageAlertStatus = Assert<Exact<ApiUsageAlertStatusView, WebUsageAlertStatus>>;

/**
 * Billing & entitlements (x227). `UsageExportView` — one row of the date-windowed usage CSV export
 * (`GET …/billing/usage/export.csv`, behind `org.manage`). The transport is CSV, so there is no JSON
 * payload to parse; the pairing keeps the emitted column set and the web client's `UsageExportColumns`
 * documentation in step. `organizationId` and the counter's storage internals are absent on both.
 */
type _usageExport = Assert<Exact<ApiUsageExportView, WebUsageExportColumns>>;

/**
 * Billing & entitlements (x281). `CostCenterView` (`GET`/`POST …/billing/cost-centers`, response) — one
 * org-scoped cost center: its id, code, display name, and the ids of the projects assigned to it.
 * Paired with the live web consumer `CostCentersView` (via `lib/api/billing-cost-centers`);
 * `organizationId` is absent on both, and `projectIds` is a readonly string array on both sides. The
 * assign / unassign / delete routes answer `204` with no body, so they need no pairing here.
 */
type _costCenter = Assert<Exact<ApiCostCenterView, WebCostCenterSummary>>;

/**
 * Billing & entitlements (x331). `CostCenterReportRowView` (`GET …/billing/cost-center-report`,
 * response) — one cost centre's read-only roll-up: its id, code, display name, the count of assigned
 * projects and their summed budget (hours and amount). Paired with the live web consumer
 * `CostCenterReportView` (via `lib/api/cost-center-report`); `organizationId` is absent on both, the
 * numeric fields are `number` on both, and `currency` is `string | null` on both (null when no amount
 * is budgeted or currencies are mixed).
 */
type _costCenterReport = Assert<Exact<ApiCostCenterReportRowView, WebCostCenterReportRow>>;

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
 * Automations connection health (x220). `ConnectionHealthView` (`GET
 * …/automations/connections/:id/health` and the roll-up `…/connections/health`) — the deterministic,
 * in-app validity verdict for one recorded connection. Paired Exact with the web consumer
 * (`ConnectionHealthScreen` via `lib/api/connection-health`): the `status` and `issues` unions and
 * the `missingConfigKeys` array are identical on both sides. No config value is projected on either.
 */
type _connectionHealth = Assert<Exact<ApiConnectionHealthView, WebConnectionHealthView>>;

/**
 * Automations webhooks (x166). `WebhookEndpointView` (`GET`/`POST …/automations/webhooks` and the
 * `PATCH …/webhooks/:id` response) — one org-scoped outbound webhook endpoint. Paired with a live web
 * consumer: `WebhookEndpointsScreen` reads exactly this response to list endpoints and toggle one.
 * Neither side carries `organizationId` or any secret field — the signing secret is stored hashed and
 * never projected — so this is a real `Exact` pair.
 */
type _webhookEndpoint = Assert<Exact<ApiWebhookEndpointView, WebWebhookEndpointSummary>>;

/**
 * Automations webhook delivery log (x221). `WebhookDeliveryView` (`GET
 * …/automations/webhooks/:endpointId/deliveries`, list element) — one recorded delivery attempt in
 * the org-scoped, newest-first delivery log. Paired with a live web consumer: `WebhookDeliveryScreen`
 * (via `lib/api/webhook-deliveries`) reads exactly this response to render the attempt table.
 * `organizationId` is absent on both sides, and there is no secret or body field — a delivery record
 * carries the outcome only — so this is a real `Exact` pair.
 */
type _webhookDelivery = Assert<Exact<ApiWebhookDeliveryView, WebWebhookDeliveryView>>;

/**
 * Automations & integrations (x164). `WorkflowRunHistoryView` (`GET …/automations/runs`, list element)
 * — one run in the org-scoped, newest-first run history. Paired with a live web consumer:
 * `AutomationRunHistoryScreen` reads exactly this response to list runs. `detail` is deliberately absent
 * on both sides — the list is bounded and a run's detail is read one at a time from the detail route.
 * `status` is `string` on both (the closed set is enforced server-side), and `organizationId` is absent
 * on both.
 */
type _workflowRunHistory = Assert<Exact<ApiWorkflowRunHistoryView, WebWorkflowRunHistoryItem>>;

/**
 * Automations & integrations (x164). `WorkflowRunDetailView` (`GET …/automations/runs/:runId`,
 * response) — one run in detail. Paired with a live web consumer: `AutomationRunHistoryScreen` reads
 * exactly this response to fill the detail drawer. `detail` is an arbitrary object on both, `status` is
 * `string` on both, and `organizationId` is absent on both.
 */
type _workflowRunDetail = Assert<Exact<ApiWorkflowRunDetailView, WebWorkflowRunDetail>>;

/**
 * Automations & integrations edit (x189). `WorkflowTemplateEditView` (`PATCH …/automations/templates/:id`,
 * response) — the full updated template the editor returns. Paired Exact with the web
 * `WorkflowTemplateEditView` that `updateWorkflowTemplate` returns and `AutomationTemplateEditScreen`
 * consumes. Structurally the same eight fields as the define/list pair; `organizationId` is absent on
 * both, and `triggerKind`/`actionKind` are `string` on both (the closed set is enforced server-side).
 */
type _workflowTemplateEdit = Assert<
  Exact<ApiWorkflowTemplateEditView, WebWorkflowTemplateEditView>
>;

/**
 * Automations & integrations clone (x219). `TemplateCloneView` (`POST …/automations/templates/:id/clone`,
 * response) — the full new template the clone returns. Paired Exact with the web `TemplateCloneView`
 * that `cloneWorkflowTemplate` returns and `AutomationTemplateCloneControl` consumes. Structurally the
 * same eight fields as the define/list and edit pairs; `organizationId` is absent on both, and
 * `triggerKind`/`actionKind` are `string` on both (the closed set is enforced server-side). The clone
 * always comes back `enabled: false`.
 */
type _templateClone = Assert<Exact<ApiTemplateCloneView, WebTemplateCloneView>>;

/**
 * Automations & integrations (x190). `WorkflowConditionView` (`GET`/`POST
 * …/automations/templates/:id/conditions`, response) — the org-scoped per-step condition that gates a
 * template's actions. Paired with a live web consumer: `AutomationConditionsScreen` reads exactly this
 * response to list conditions and drive the add form. `op` is `string` on both sides (the closed set is
 * enforced server-side), `targetStep` is `number` on both, and `organizationId` is absent on both.
 */
type _workflowCondition = Assert<Exact<ApiWorkflowConditionView, WebWorkflowConditionSummary>>;

/**
 * Automations & integrations (x305). `AutomationVariableView` (`GET …/automations/variables`, `PUT
 * …/automations/variables/:key`, response) — one org-level, non-secret `(key -> value)` variable.
 * Paired with a live web consumer: `AutomationVariablesView` reads exactly this response to list
 * variables and drive the add/remove form. Neither side echoes the row id or `organizationId`: a
 * variable is addressed by its `key` within the acting organization.
 */
type _automationVariable = Assert<Exact<ApiAutomationVariableView, WebAutomationVariableSummary>>;

/**
 * Automations & integrations (x335). `AutomationTemplateTagView` (`GET`/`POST
 * …/automations/templates/:id/tags`, response) — one free-text tag on a workflow template. Paired with
 * a live web consumer: `AutomationTemplateTagsView` reads exactly this response to list tags and drive
 * the add form. `label`/`templateId`/`createdBy`/`createdAt` are held identical and `organizationId` is
 * absent on both, so a rename or retype on either side fails the gate.
 */
type _automationTemplateTag = Assert<
  Exact<ApiAutomationTemplateTagView, WebAutomationTemplateTagSummary>
>;

/**
 * Automations & integrations (x335). `AutomationTaggedTemplateView` (`GET …/automations/template-tags`,
 * list element) — one template in the tag-filter result. Paired with a live web consumer:
 * `AutomationTemplateTagsView` reads exactly this response to render the filtered template list. Just
 * `id` and `name`; `organizationId` is absent on both sides.
 */
type _automationTaggedTemplate = Assert<
  Exact<ApiAutomationTaggedTemplateView, WebAutomationTaggedTemplateSummary>
>;

/**
 * People capacity (module 14, x170). `PersonCapacityView` (`GET`/`PUT …/people/:membershipId/capacity`,
 * response) — one member's weekly capacity. Paired Exact with its live web consumer:
 * `PersonCapacitySection` reads exactly this response to show and edit the figure. `organizationId` is
 * absent on both sides; `membershipId`/`weeklyHours`/`effectiveFrom`/`updatedAt` are held identical, so
 * a rename or retype on either side fails the gate.
 */
type _personCapacity = Assert<Exact<ApiPersonCapacityView, WebPersonCapacity>>;

/**
 * People reporting lines / org chart (module 14, x217). `ReportingLineView` (`PUT`/`GET
 * …/people/:membershipId/manager` and each edge of `GET …/people/org-chart`, response) — one member
 * and who they report to. Paired Exact with its live web consumer: `OrgChartScreen` reads exactly this
 * response to set a manager and draw the tree. `managerMembershipId` is `string | null` on both sides
 * (null = a root), `membershipId` is held identical, and `organizationId` is absent on both — so a
 * rename or retype on either side fails the gate.
 */
type _reportingLine = Assert<Exact<ApiReportingLineView, WebReportingLine>>;

/**
 * Member availability / out-of-office (module 14, x218). `AvailabilityView` (POST/GET/DELETE
 * `…/people/availability` and GET `…/people/:membershipId/availability`, response element) — one
 * out-of-office window. Paired Exact with its live web consumer: `AvailabilityScreen` reads exactly
 * this shape to list and remove windows. `organizationId` is absent on both sides;
 * `id`/`membershipId`/`startDate`/`endDate`/`kind`/`note`/`createdAt` are held identical, so a rename
 * or retype on either side fails the gate.
 */
type _availability = Assert<Exact<ApiAvailabilityView, WebAvailabilityView>>;
/**
 * Person time-off (module 14, x325). `PersonTimeOffView` (POST/GET/DELETE `…/people/:userId/time-off`,
 * response element) — one dated absence a manager filed against a person. Paired Exact with its live
 * web consumer: `PersonTimeOffView` (the person-detail panel) reads exactly this shape to list and
 * remove entries. `organizationId` is absent on both sides;
 * `id`/`personUserId`/`startsOn`/`endsOn`/`kind`/`note`/`createdByUserId`/`createdAt` are held
 * identical, so a rename or retype on either side fails the gate.
 */
type _personTimeOff = Assert<Exact<ApiPersonTimeOffView, WebPersonTimeOffView>>;

/**
 * Team capacity heatmap (module 14, x193). `CapacityHeatmapView` (`GET …/people/capacity/heatmap`,
 * response) — the org-level member × week utilisation grid folded from the x170 capacity and x171
 * allocation facts. Paired Exact with its live web consumer: `TeamCapacityHeatmapScreen` reads exactly
 * this response to render the grid and legend. `organizationId` is absent throughout; the nested
 * member/cell shapes are held identical, so a rename or retype on either side fails the gate.
 */
type _capacityHeatmap = Assert<Exact<ApiCapacityHeatmapView, WebCapacityHeatmapView>>;

/**
 * People member skills (x172). `PersonSkillView` (`GET`/`POST …/people/:membershipId/skills`,
 * response) — one member skill. Paired Exact with a live web consumer: `PersonSkillsPanel` reads
 * exactly this response to list and add skills. The `level` union (`basic | proficient | expert`) is
 * identical on both sides, and `organizationId` is absent on both — the wire never echoes the tenant.
 */
type _personSkill = Assert<Exact<ApiPersonSkillView, WebPersonSkillSummary>>;

/**
 * Person certifications (x326). `PersonCertificationView` (`GET`/`POST …/people/:userId/certifications`,
 * response) — one dated credential. Paired Exact with a live web consumer: `PersonCertificationsView`
 * reads exactly this response to list and record certifications. `expired` is computed by the API
 * read-side (`expires_on < today`) and is identical on both sides; `organizationId` is absent on both
 * — the wire never echoes the tenant id. Distinct from `PersonSkillView` (proficiency tags).
 */
type _personCertification = Assert<
  Exact<ApiPersonCertificationView, WebPersonCertificationSummary>
>;

/**
 * Skill directory search (x194). `SkillSearchView` (`GET …/people/skills/search?skill=&level=`,
 * response) — one directory hit: a member and the requested skills they matched. Paired Exact with a
 * live web consumer: `SkillSearchScreen` reads exactly this response to list matching members. The
 * `matched` element (`{ label, level }`) and the `level`/`status` unions are identical on both sides,
 * and `organizationId` is absent on both — the wire never echoes the tenant.
 */
type _skillSearch = Assert<Exact<ApiSkillSearchView, WebSkillSearchResult>>;

/**
 * Billing profile (module 19, x180). `BillingProfileView` (`GET`/`PUT …/billing/profile`, response) —
 * the org-scoped billing metadata. Paired with a live web consumer: `BillingProfileScreen` reads
 * exactly this response to seed and save the billing-settings form. The nested `address` object
 * (`{ line1, line2, city, region, postalCode, country }`, each `string | null`) is identical on both
 * sides; there is deliberately no card or bank field on either side.
 */
type _billingProfile = Assert<Exact<ApiBillingProfileView, WebBillingProfileView>>;

/**
 * Billing tax / legal-entity details (module 19, x283). `TaxDetailsView`
 * (`GET`/`PUT …/billing/tax-details`, response) — one org-scoped tax/legal-entity row (`legalName`,
 * `taxId`, `registrationNo`, `taxCountry`, each `string | null`, plus `updatedAt: string | null`).
 * Paired with a live web consumer: `TaxDetailsView` (the screen) reads exactly this shape to seed and
 * save the form. `organizationId` is deliberately absent on both sides, and there is no card or bank
 * field on either — legal/tax metadata only.
 */
type _billingTaxDetails = Assert<Exact<ApiTaxDetailsView, WebTaxDetailsView>>;

/**
 * Billing contacts (module 19, x199). `BillingContactView` (`GET`/`POST`/`DELETE …/billing/contacts`,
 * response) — one org-scoped billing contact (`id`, `name`, `email`, `role: string | null`,
 * `createdAt`). Paired with a live web consumer: `BillingContactsScreen` reads exactly this shape to
 * list, add and remove contacts. `organizationId` is deliberately absent on both sides, and there is no
 * card or bank field on either — contacts carry non-secret metadata only.
 */
type _billingContact = Assert<Exact<ApiBillingContactView, WebBillingContactView>>;

/**
 * Billing seats (x178). `BillingSeatView` ↔ `BillingSeat` — one billing seat (`GET`/`POST`
 * `…/billing/seats`, `DELETE …/billing/seats/:seatId`). `BillingSeatsScreen` reads exactly this
 * shape, so the `id`/`membershipId`/`assignedAt`/`releasedAt` pair is held identical on both sides.
 * `organizationId` is absent on both — the wire projection never echoes the tenant id.
 */
type _billingSeat = Assert<Exact<ApiBillingSeatView, WebBillingSeat>>;

/**
 * Billing credits (module 19, x226). `BillingCreditView` (`GET`/`POST …/billing/credits`, response) —
 * one org-scoped manual credit / adjustment ledger entry (`id`, signed integer-minor-units `amount`,
 * `reason`, `createdBy`, `createdAt`). Paired with a live web consumer: `BillingCreditsScreen` reads
 * exactly this shape to list the ledger and post a credit. `organizationId` is deliberately absent on
 * both sides. The list envelope's running `balance` is an inline `number`, not a projection, so only the
 * element shape is paired here; the ledger is append-only and moves no money.
 */
type _billingCredit = Assert<Exact<ApiBillingCreditView, WebBillingCreditView>>;

/**
 * Billing discounts (module 19, x330). `BillingDiscountView` (`GET`/`POST`/`DELETE …/billing/discounts`,
 * response) — one org-scoped discount / adjustment record (`id`, `label`, `kind` percent|fixed, integer
 * `amount`, optional `expiresOn`, read-side `active`, `createdBy`, `createdAt`). Paired with a live web
 * consumer: `BillingDiscountsScreen` reads exactly this shape to list the register and record a
 * discount. `organizationId` is deliberately absent on both sides; `active` is computed by the API
 * against its process clock. The list envelope wraps this one element shape; the register moves no money.
 */
type _billingDiscount = Assert<Exact<ApiBillingDiscountView, WebBillingDiscountView>>;

/**
 * SRCH-01 (x111). `SearchResultView` ↔ `SearchResult` — the unified global-search hit
 * (`GET …/search?q=`). Paired Exact, not exempt: SRCH-01 ships `SearchScreen`, a real web consumer,
 * so the `kind`/`id`/`title`/`projectId`/`snippet` shape and the `SearchResultKind` union are held
 * identical on both sides.
 */
type _searchResult = Assert<Exact<ApiSearchResultView, WebSearchResult>>;

/**
 * SRCH saved/recent searches (x214). `SavedSearchView` ↔ `SavedSearch` (`GET/POST/DELETE
 * …/search/saved`) and `RecentSearchView` ↔ `RecentSearch` (`GET …/search/recent`). Paired Exact
 * with a live web consumer: `SavedSearchesScreen` reads both. `filters` is a `{ field, value }[]` on
 * both, dates are ISO strings on both, and `organizationId`/`userId` are absent on both.
 */
type _savedSearch = Assert<Exact<ApiSavedSearchView, WebSavedSearch>>;
type _recentSearch = Assert<Exact<ApiRecentSearchView, WebRecentSearch>>;

/**
 * SRCH saved-search sharing (x272). `SharedSavedSearchView` ↔ `SharedSavedSearch` (`GET
 * …/search/shared`, `PUT/DELETE …/search/saved/:id/share`). Paired Exact with a live web consumer:
 * `SavedSearchShareScreen` reads the shared list. `filters` is a `{ field, value }[]` on both,
 * `sharedAt` is an ISO string on both, and `organizationId` is absent on both.
 */
type _sharedSavedSearch = Assert<Exact<ApiSharedSavedSearchView, WebSharedSavedSearch>>;

/**
 * Search recent history (x288). `SearchHistoryEntryView` ↔ `SearchHistoryEntry`
 * (`POST/GET/DELETE …/search/history`). Paired Exact with a live web consumer: `SearchHistoryList`
 * reads the list. Both are `{ query, recordedAt }` — `recordedAt` an ISO string on both, and no
 * `id`/`organizationId`/`membershipId` on either.
 */
type _searchHistoryEntry = Assert<Exact<ApiSearchHistoryEntryView, WebSearchHistoryEntry>>;

/**
 * SRCH quick-access pins (x290). `SearchPinView` ↔ `SearchPin` (`GET/PUT …/search/pins`, `DELETE
 * …/search/pins/:id`). Paired Exact — the screen reads exactly this response.
 */
type _searchPin = Assert<Exact<ApiSearchPinView, WebSearchPin>>;

/**
 * SRCH saved scopes (x334). `SearchScopeView` ↔ `SearchScope` (`GET/POST …/search/scopes`,
 * `PUT/DELETE …/search/scopes/:id`). Paired Exact with a live web consumer: `SearchSavedScopesView`
 * reads the scope list, applies a scope and saves the current one. `filters` is the same
 * `{ objectTypes[], projectId?, from?, to? }` object on both, `createdAt`/`updatedAt` are ISO strings
 * on both, and `organizationId` is absent on both.
 */
type _searchScope = Assert<Exact<ApiSearchScopeView, WebSearchScope>>;

/**
 * SRCH command palette (x181). `CommandView` ↔ `Command` — one palette command
 * (`GET …/search/commands?q=`). Paired Exact, not exempt: x181 ships `CommandPalette`, a real web
 * consumer, so the `id`/`title`/`section`/`kind`/`href`/`action` shape and the `CommandKind` union
 * (`navigate | action`) are held identical on both sides. Distinct from `SearchResult`: a command is
 * a fixed navigation or allowlisted quick action, never a row.
 */
type _command = Assert<Exact<ApiCommandView, WebCommand>>;

/**
 * Module 16 AI copilot (slice 05). `CopilotAnswerView` ↔ `CopilotAnswerView` — the answer view
 * `POST …/copilot/ask` returns. Paired Exact, not exempt: slice 05 ships `CopilotAnswerView`, a real
 * web consumer, so the `answer`/`evidence`/`permissionBoundary`/`nextSafeAction`/`provider` shape,
 * the nested evidence `{source, link}`, and the permission-boundary `scope` union
 * (`organization | assigned-projects | client-projection`) are held identical on both sides.
 */
type _copilotAnswer = Assert<Exact<ApiCopilotAnswerView, WebCopilotAnswerView>>;

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

/** A11. `OrganizationProfileView` (`GET …/profile`, `PATCH`, `PUT/DELETE …/logo`) — name + logo id. */
type _organizationProfile = Assert<Exact<ApiOrganizationProfileView, WebOrganizationProfileView>>;

/**
 * B3. `DownloadScanPolicyView` (`GET/PATCH …/file-download-policy`). No web consumer yet (the screen
 * is Figma-first, lane B5), so the API shape is pinned here; B5 swaps the literal for its web type.
 */
type _downloadScanPolicy = Assert<
  Exact<
    ApiDownloadScanPolicyView,
    {
      readonly downloadsBeforeScan: 'allow_labeled' | 'block';
      readonly effective: 'allow_labeled' | 'block';
      readonly scannerConfigured: boolean;
    }
  >
>;

/**
 * Custom roles (x173). `CustomRoleView` (`GET/POST …/admin/roles`, response) — the organization's custom
 * roles, each with its capability subset. Paired with a live web consumer: `AdminRolesScreen` reads
 * exactly this response to render the role list and the capability picker. One projection; its per-role
 * item (`{ id, name, capabilities, createdAt }`) is inlined on both sides, so this pair covers it
 * structurally. The wire projection never echoes the tenant id.
 */
type _customRoles = Assert<Exact<ApiCustomRoleView, WebCustomRoleView>>;

/**
 * Admin pending-invitation management (x328). `AdminInvitationsView` (`GET …/admin/invitations`,
 * response) — the tenant's pending invitations, metadata only. Paired with a live web consumer:
 * `AdminInvitationsView` reads exactly this response to render the list and the per-row Revoke action.
 * The per-invitation item (`{ id, email, role, invitedByUserId, invitedByName, invitedByEmail,
 * expiresAt, createdAt, isExpired }`) is inlined on both sides, so this pair covers it structurally. The
 * token hash is never on the wire.
 */
type _adminInvitations = Assert<Exact<ApiAdminInvitationsView, WebAdminInvitationsView>>;

/**
 * Admin data-export requests (x224). `DataExportRequestView` (`GET/POST …/admin/export-requests`,
 * response) — the organization's recorded, GDPR-style data-export requests, each with its scope,
 * status and who asked when. Paired with a live web consumer: `AdminExportRequestsScreen` reads exactly
 * this response to render the request list and the new-request form. One projection; its per-request
 * item (`{ id, scope, status, requestedBy, requestedAt }`) is inlined on both sides, so this pair
 * covers it structurally. The wire projection never echoes the tenant id.
 */
type _dataExportRequests = Assert<Exact<ApiDataExportRequestView, WebDataExportRequestView>>;

/**
 * Custom role clone + edit (x195). `RoleEditView` (`POST …/admin/roles/:id/clone` and
 * `PATCH …/admin/roles/:id`, response) — the single role a clone or an edit affects, with its capability
 * subset. Paired with a live web consumer: `RoleEditScreen` reads exactly this response after a clone or a
 * save. One projection; its `role` item (`{ id, name, capabilities, createdAt }`) is inlined on both
 * sides, so this pair covers it structurally. The wire projection never echoes the tenant id.
 */
type _roleEdit = Assert<Exact<ApiRoleEditView, WebRoleEditView>>;

/**
 * Admin bulk role assignment (x222). `MemberBulkRoleView` (`POST …/admin/members/bulk-role`, response) —
 * the per-id outcome of assigning one custom role to a batch of memberships. Paired with a live web
 * consumer: `BulkRoleAssignBar` reads exactly this response to report how many assignments landed and how
 * many ids resolved to no member. One projection; its per-id item (`{ membershipId, outcome }`) is inlined
 * on both sides, so this pair covers it structurally. The wire projection never echoes the tenant id.
 */
type _memberBulkRole = Assert<Exact<ApiMemberBulkRoleView, WebMemberBulkRoleView>>;

/**
 * Admin active sessions + revocation (x223). `ActiveSessionView` (`GET …/admin/sessions`, response row)
 * — one live session of an organization member, metadata only: the member, the device label, and the
 * start/last-seen times, never any token or refresh material. Paired with a live web consumer:
 * `AdminSessionsScreen` renders exactly this row and posts a revoke by its `sessionId`.
 */
type _activeSession = Assert<Exact<ApiActiveSessionView, WebActiveSessionView>>;

/**
 * Organization access policies (x174). `OrgPolicyView` (`GET/PUT …/policies`, response) — the
 * organization's typed, bounded access policy (session lifetime, invite-domain allowlist, guest access).
 * Paired with a live web consumer: `AdminPoliciesScreen` reads exactly this response to render one
 * labelled control per policy. One projection; its `policy` document is inlined identically on both
 * sides, so this pair covers it structurally. Distinct from x153's `OrgSettingsView`. The wire
 * projection never echoes the tenant id.
 */
type _orgPolicies = Assert<Exact<ApiOrgPolicyView, WebOrgPolicyView>>;

/**
 * Access-policy simulation (x196). `PolicySimulationView` (`POST …/policies/simulate`, response) — the
 * read-only decision the live evaluator reaches for a member/capability/context, with the deciding rule
 * made explicit. Paired with a live web consumer: `PolicySimulationScreen` reads exactly this response
 * to render the allow/deny panel. One projection; its `result` object is inlined identically on both
 * sides, so this pair covers it structurally. Distinct from x174's stored-document `OrgPolicyView`. The
 * wire projection never echoes the tenant id.
 */
type _policySimulation = Assert<Exact<ApiPolicySimulationView, WebPolicySimulationView>>;

/**
 * Organization security settings (x176). `SecuritySettingsView` (`GET/PUT …/admin/security`, response)
 * — the org-wide security posture (2FA enforcement + IP allowlist). Paired with a live web consumer:
 * `AdminSecurityScreen` reads exactly this response to render the 2FA toggle and the allowlist editor.
 * One projection; `ipAllowlist` is a `readonly string[]` on both sides. The wire projection never
 * echoes the tenant id.
 */
type _securitySettings = Assert<Exact<ApiSecuritySettingsView, WebSecuritySettingsView>>;
// Admin security-event alerts (x329). `SecurityAlertsView` (`GET/PUT/DELETE …/admin/security-alerts`,
// response) — the allowlist, the tenant's per-key config, and a read-only preview of recent matching
// audit events. `AdminSecurityAlertsView` reads exactly this response; dates are ISO strings on both
// sides and the wire projection never echoes the tenant id.
type _securityAlerts = Assert<Exact<ApiSecurityAlertsView, WebSecurityAlertsView>>;

/**
 * Organization IP allowlist (x277). `IpAllowlistEntryView` (`GET`/`POST …/admin/ip-allowlist`,
 * `DELETE …/admin/ip-allowlist/:entryId`) — one advisory allowed range (`id`, `cidr`, `label: string |
 * null`, `createdAt`). Paired with a live web consumer: `IpAllowlistView` reads exactly this shape to
 * list, add and remove ranges. `organizationId` is deliberately absent on both sides; the surface is
 * distinct from the security-settings blob (x176). The wire projection never echoes the tenant id.
 */
type _ipAllowlistEntry = Assert<Exact<ApiIpAllowlistEntryView, WebIpAllowlistEntryView>>;

/**
 * Audit-log retention policy (x279). `AuditRetentionView` (`GET/PUT …/admin/audit-retention`, response)
 * — the stored retention window in days (null if never set), when it was last set, and a read-only
 * preview count of audit events older than the window. Paired with a live web consumer:
 * `AuditRetentionView` (the screen) reads exactly this to render the window field and the "N events
 * older than the window" preview. One projection; the wire projection never echoes the tenant id or the
 * actor.
 */
type _auditRetention = Assert<Exact<ApiAuditRetentionView, WebAuditRetentionView>>;

/**
 * ON-10 guided-tour progress (x155). `GET .../onboarding/tour` and
 * `POST .../onboarding/tour/:step/complete` — the acting member's fixed guided tour, each step with
 * its completed flag. One projection; its per-step item is inlined on both sides, so this pair covers
 * it structurally, and the `step` union (`welcome|create_project|invite_team|explore_work|
 * share_portal`) must match exactly. The `OnboardingTourScreen` reads exactly this response.
 */
type _onboardingTour = Assert<Exact<ApiOnboardingTourView, WebOnboardingTourView>>;

/**
 * PREF-001 (x182). `GET/PUT .../me/preferences` — the acting member's own appearance/locale settings.
 * One projection, three closed unions (`theme`, `locale`, `density`) that must match exactly on both
 * sides; the `PreferencesScreen` reads and writes exactly this shape.
 */
type _userPreferences = Assert<Exact<ApiUserPreferencesView, WebUserPreferencesView>>;

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
 * B4: `PATCH .../documents/:documentId` (rename, `renameDocument`) answers this same shape.
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
 * Administration overview (x175). `GET .../admin/overview` — the org-health roll-up behind
 * `org.manage`: active members, seats used, storage bytes used, audit events over a fixed 30-day
 * window and offboardings in progress, plus the window and a `computedAt`. Computed, never stored.
 * `AdminOverviewScreen` reads exactly this shape, so the pair is Exact.
 */
type _adminOverview = Assert<Exact<ApiAdminOverviewView, WebAdminOverviewView>>;
// ADM org branding (x327): `GET .../branding` (work.read) and `PUT .../admin/branding` (org.manage) —
// the org-wide internal chrome branding. Both routes return exactly this shape, so the pair is Exact.
type _orgBranding = Assert<Exact<ApiOrgBrandingView, WebOrgBrandingView>>;

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
type _passwordResetRequested = Assert<
  Exact<ApiPasswordResetRequestedView, WebPasswordResetRequestedView>
>;
type _invitationRegistration = Assert<
  Exact<ApiInvitationRegistrationView, WebInvitationRegistration>
>;

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
 * `GET …/people` — module 14 / audit #4 (x168). One People & capacity directory row:
 * `PeopleDirectoryScreen` reads exactly this projection (name, email, role, status, project
 * count, version, last active, PEO-01 columns), so it pairs Exact; `membershipId` (the keyset cursor) is on neither side.
 */
type _person = Assert<Exact<ApiPersonDirectoryView, WebPersonSummary>>;

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

/**
 * Platform states (x185). `GET /public/site/maintenance` — the public maintenance / degraded-mode
 * banner read, and the `MaintenanceWindowView` the admin schedule (`POST …/admin/maintenance`)
 * returns. ISO-string dates and the `active` flag on the wire; the `severity` union is the same on
 * both sides, so both pairs are Exact. The admin write body (`ScheduleMaintenanceInput`) is
 * request-side and dropped by `contracts-check`'s `Input` suffix rule.
 */
type _maintenanceWindow = Assert<Exact<ApiMaintenanceWindowView, WebMaintenanceWindowView>>;
type _publicMaintenance = Assert<Exact<ApiPublicMaintenanceView, WebPublicMaintenanceView>>;

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
 * `GET /v1/public/site/faq` — the public FAQ page (x186, module 1).
 *
 * Public and tenant-less: deterministic code-defined grouped Q&A copy. The `PublicFaqView` pair keeps
 * the copy the API serves and the copy the screen renders from drifting apart.
 */
type _publicFaq = Assert<Exact<ApiPublicFaqView, WebPublicFaqView>>;

/**
 * `GET /v1/public/site/legal/:doc` — the public legal documents, terms and privacy (x188, module 1).
 *
 * Public and tenant-less: deterministic code-defined copy (title, a frozen effective date, and the
 * long-form sections). The `PublicLegalView` pair keeps the terms the API serves and the terms the
 * screen renders from drifting. The `doc` field's union (`terms | privacy`) is the same allowlist on
 * both sides.
 */
type _publicLegal = Assert<Exact<ApiPublicLegalView, WebPublicLegalView>>;
/**
 * `POST /public/site/contact` — the public site's contact / lead intake (module 1, x161).
 *
 * The only unauthenticated write in the public site. Its response is a bare acknowledgement that
 * reflects nothing stored — `{ status: 'received' }` — so the API `ContactSubmitView` and the web
 * `ContactSubmitView` pair Exact. The request body (`ContactSubmitInput`) is request-side and is
 * dropped by `contracts-check`'s `Input` suffix rule.
 */
type _contactSubmit = Assert<Exact<ApiContactSubmitView, WebContactSubmitView>>;
/**
 * `GET/POST /public/setup` — first-owner setup on an empty install (registered only while
 * `SETUP_TOKEN` is set). The availability probe and the issued-session view pair Exact; the
 * request body (`FirstOwnerSetupInput`) is request-side.
 */
type _firstOwnerAvailability = Assert<
  Exact<ApiFirstOwnerAvailabilityView, WebFirstOwnerAvailabilityView>
>;
type _firstOwnerSetup = Assert<Exact<ApiFirstOwnerSetupView, WebFirstOwnerSetupView>>;
/** `GET/POST /v1/public/sign-up` — public sign-up (registered only while `PUBLIC_SIGNUP` is on). */
type _publicSignupAvailability = Assert<
  Exact<ApiPublicSignupAvailabilityView, WebPublicSignupAvailabilityView>
>;
type _publicSignup = Assert<Exact<ApiPublicSignupView, WebPublicSignupView>>;
/** `/v1/auth/google/*` — "Continue with Google" (registered only with a Google client). */
type _googleAvailability = Assert<Exact<ApiGoogleAvailabilityView, WebGoogleAvailabilityView>>;
type _googleStart = Assert<Exact<ApiGoogleStartView, WebGoogleStartView>>;
type _googlePendingMfa = Assert<Exact<ApiGooglePendingMfaView, WebGooglePendingMfaView>>;

/** x255 - calendar focus blocks (personal protected time). Paired Exact. */
type _focusBlock = Assert<Exact<ApiFocusBlockView, WebFocusBlockView>>;

/** x252 - conversation mute own-preference. Paired Exact. */
type _conversationMute = Assert<Exact<ApiConversationMuteView, WebConversationMuteView>>;

/** x253 - in-conversation message search match. Paired Exact (API MessageSearchMatchView / web MessageSearchMatch). */
type _messageSearchMatch = Assert<Exact<ApiMessageSearchMatchView, WebMessageSearchMatch>>;

/** x251 - composer draft. Paired Exact. */
type _messageDraft = Assert<Exact<ApiMessageDraftView, WebMessageDraftView>>;

/** x250 - conversation read-state and unread count. Paired Exact. */
type _conversationReadState = Assert<
  Exact<ApiConversationReadStateView, WebConversationReadStateView>
>;
type _conversationUnread = Assert<Exact<ApiConversationUnreadView, WebConversationUnreadView>>;

/** x259 - inbox snooze list. Paired Exact (the inlined snooze item matches web InboxSnooze). */
type _inboxSnooze = Assert<Exact<ApiInboxSnoozeView, WebInboxSnoozeView>>;
// INBOX source mutes (x318). `InboxSourceMutesView` (PUT/DELETE/GET .../inbox/source-mutes) — the
// caller's own muted sources. The screen reads exactly this response, so the pair is Exact; the
// inlined mute item matches web InboxSourceMute (exempt, covered here).
type _inboxSourceMutes = Assert<Exact<ApiInboxSourceMutesView, WebInboxSourceMutesView>>;
// INBOX important flags (IN-01, x260). `InboxFlagView` (PUT/DELETE a bundle's flag) and
// `InboxFlaggedView` (GET the caller's flagged ids). The screen reads exactly these, so both Exact.
type _inboxFlag = Assert<Exact<ApiInboxFlagView, WebInboxFlagView>>;
type _inboxFlagged = Assert<Exact<ApiInboxFlaggedView, WebInboxFlaggedView>>;
// HOME quick links (module 4 My Day, x273). `HomeQuickLinksView` wraps the caller's ordered links;
// the screen reads exactly this response, so the pair is Exact. Its element (web `HomeQuickLink`,
// API `HomeQuickLinkItem`) is covered transitively through this pair — see WEB_EXEMPT.
type _homeQuickLinks = Assert<Exact<ApiHomeQuickLinksView, WebHomeQuickLinksView>>;

// ── pass25 pairings (x276–x301), added by integrator 25 ─────────────────────
// These APPROVED slices shipped without their contract pairing; each web shape mirrors the API view
// it reads, so every pair is Exact. The request-body web shapes (NewInboxRule, NewMeetingTimePollOption)
// are WEB_EXEMPT in scripts/contracts-check.mjs.
// Admin announcements (module 18, x276). `AnnouncementView` ↔ web `AnnouncementSummary`.
type _orgAnnouncement = Assert<Exact<ApiAnnouncementView, WebAnnouncementSummary>>;
// Admin optional-module feature flags (x278): one flag, the admin list, and the resolved map.
type _featureFlagAdmin = Assert<Exact<ApiFeatureFlagAdminView, WebFeatureFlagAdminView>>;
type _featureFlagsAdmin = Assert<Exact<ApiFeatureFlagsAdminView, WebFeatureFlagsAdminView>>;
type _featureFlagsResolved = Assert<
  Exact<ApiFeatureFlagsResolvedView, WebFeatureFlagsResolvedView>
>;
// Admin private member notes (x280).
type _memberAdminNote = Assert<Exact<ApiMemberAdminNoteView, WebMemberAdminNoteView>>;
// Billing plan-change requests (x284).
type _planChangeRequest = Assert<Exact<ApiPlanChangeRequestView, WebPlanChangeRequestView>>;
// Billing purchase-order references (x282). API `PurchaseOrderView` ↔ web `PurchaseOrderSummary`.
type _purchaseOrder = Assert<Exact<ApiPurchaseOrderView, WebPurchaseOrderSummary>>;
// CAL meeting time-option poll (x298): one candidate slot (its inlined tally is covered here, and the
// web `MeetingTimePollTally` element is WEB_EXEMPT since the API has no standalone …View for it).
type _meetingTimePollOption = Assert<
  Exact<ApiMeetingTimePollOptionView, WebMeetingTimePollOptionView>
>;
// INBOX routing rules (x301): one rule. The resolve response (`ResolvedCategory`) is WEB_EXEMPT — the
// API names it `ResolvedCategory`, not a `…View`, so it is not an enumerated API projection to assert.
type _inboxRule = Assert<Exact<ApiInboxRuleView, WebInboxRuleView>>;
// PREF startup landing (x287).
type _startupPref = Assert<Exact<ApiStartupPrefView, WebStartupPrefView>>;
// PROJ milestone-plan baseline (x295): the snapshot and the variance. The variance row
// (`ProjectBaselineVarianceRow`) is WEB_EXEMPT — it is the element of `ProjectBaselineVariance`, which
// is paired Exact here, so the row shape is covered transitively.
type _projectBaseline = Assert<Exact<ApiProjectBaselineView, WebProjectBaselineSummary>>;
type _projectBaselineVariance = Assert<
  Exact<ApiProjectBaselineVarianceView, WebProjectBaselineVariance>
>;
// PROJ budget vs tracked effort (x293).
type _projectBudget = Assert<Exact<ApiProjectBudgetView, WebProjectBudgetSummary>>;
// PROJ timeline phases (x294): a phase and a milestone→phase assignment.
type _projectPhase = Assert<Exact<ApiProjectPhaseView, WebProjectPhaseSummary>>;
type _milestonePhaseAssignment = Assert<
  Exact<ApiMilestonePhaseAssignmentView, WebMilestonePhaseAssignment>
>;

// ── Pass-26 pairings (x313–x335) ────────────────────────────────────────────
// SEC admin security-event alerts (x329): the parent `SecurityAlertsView` is paired above; its
// elements `SecurityAlertConfig`/`SecurityAlertMatch` are WEB_EXEMPT (the API names them without a
// `…View` suffix, so they are not enumerated API projections to assert).
// CAL agenda templates (x314): `ApplyAgendaTemplateResult` and the item `MeetingAgendaTemplateItem`
// are WEB_EXEMPT (the API sources/names them without a `…View` suffix; the item is covered by the
// paired `AgendaTemplateView`).
// APPROVAL steps (x315): a step and the chain. `DefineApprovalStep` is the request body and is
// WEB_EXEMPT.
type _approvalStep = Assert<Exact<ApiApprovalStepView, WebApprovalStep>>;
type _approvalChain = Assert<Exact<ApiApprovalChainView, WebApprovalChain>>;
// HOME recent items (x324): the bounded recent-items read.
type _recentItems = Assert<Exact<ApiRecentItemsView, WebRecentItemsView>>;
// PORTAL branding (x323): the staff view and the client projection.
type _portalBranding = Assert<Exact<ApiPortalBrandingView, WebPortalBranding>>;
type _portalBrandingClient = Assert<
  Exact<ApiPortalBrandingClientView, WebPortalBrandingClientView>
>;
// PORTAL deliverable feedback (x321): the client's own feedback and the staff-read entry.
type _portalDeliverableFeedback = Assert<
  Exact<ApiPortalFeedbackClientView, WebPortalDeliverableFeedback>
>;
type _portalDeliverableFeedbackStaff = Assert<
  Exact<ApiPortalFeedbackStaffView, WebPortalDeliverableFeedbackStaffEntry>
>;
// PROJ custom fields (x310): the org-scoped definition and a project's resolved value.
type _projectCustomFieldDefinition = Assert<
  Exact<ApiProjectCustomFieldDefinitionView, WebProjectCustomFieldDefinition>
>;
type _projectCustomFieldValue = Assert<
  Exact<ApiProjectCustomFieldValueView, WebProjectCustomFieldValue>
>;
// PROJ dependencies (x309): one dependency. The graph wrapper `ProjectDependencyGraph` is
// WEB_EXEMPT (the API names it without a `…View` suffix; its element is paired Exact here).
type _projectDependency = Assert<Exact<ApiProjectDependencyView, WebProjectDependency>>;
// PROJ retro notes (x311): one note and the grouped board.
type _projectRetroNote = Assert<Exact<ApiProjectRetroNoteView, WebProjectRetroNoteSummary>>;
type _projectRetroBoard = Assert<Exact<ApiProjectRetroBoardView, WebProjectRetroBoard>>;
/** `GET /v1/organizations/address-availability` — ON-02's live "available" tick. */
type _addressAvailability = Assert<Exact<ApiAddressAvailabilityView, WebAddressAvailability>>;
// Design-gaps pass (2026-10-18): docs audience, adoption gaps, portfolio
// timeline + capacity, and the MCP personal access tokens.
type _documentPerson = Assert<Exact<ApiDocumentPersonView, WebDocumentPerson>>;
type _documentSharing = Assert<Exact<ApiDocumentSharingView, WebDocumentSharing>>;
type _recentDocument = Assert<Exact<ApiRecentDocumentView, WebRecentDocumentSummary>>;
type _recentDocuments = Assert<Exact<ApiRecentDocumentsView, WebRecentDocumentsResult>>;
type _adoptionGap = Assert<Exact<ApiInsightsAdoptionGapView, WebInsightsAdoptionGapView>>;
type _personalAccessToken = Assert<Exact<ApiPersonalAccessTokenView, WebPersonalAccessTokenView>>;
type _createdPersonalAccessToken = Assert<
  Exact<ApiCreatedPersonalAccessTokenView, WebCreatedPersonalAccessTokenView>
>;
type _portfolioMilestone = Assert<Exact<ApiPortfolioMilestoneView, WebPortfolioMilestone>>;
type _portfolioCapacity = Assert<Exact<ApiPortfolioCapacityView, WebPortfolioCapacity>>;

// Platform admin (`/v1/platform/*`, 0206): the operator's views, paired one for one.
type _platformMeView = Assert<Exact<ApiPlatformMeView, WebPlatformMeView>>;
type _platformOverviewView = Assert<Exact<ApiPlatformOverviewView, WebPlatformOverviewView>>;
type _platformCompanyView = Assert<Exact<ApiPlatformCompanyView, WebPlatformCompanyView>>;
type _platformCompanyAuditView = Assert<
  Exact<ApiPlatformCompanyAuditView, WebPlatformCompanyAuditView>
>;
type _platformCompanyDetailView = Assert<
  Exact<ApiPlatformCompanyDetailView, WebPlatformCompanyDetailView>
>;
type _platformPersonView = Assert<Exact<ApiPlatformPersonView, WebPlatformPersonView>>;
type _platformSettingsView = Assert<Exact<ApiPlatformSettingsView, WebPlatformSettingsView>>;
type _platformAuditEventView = Assert<Exact<ApiPlatformAuditEventView, WebPlatformAuditEventView>>;

// Google Drive storage (0210): the Storage screen and "Attach from Google Drive".
type _storageStatus = Assert<Exact<ApiStorageStatusView, WebStorageStatusView>>;
type _driveAttachment = Assert<Exact<ApiDriveAttachmentView, WebDriveAttachmentView>>;
type _pickerSession = Assert<Exact<ApiPickerSessionView, WebPickerSessionView>>;
// MCP connector S9–S11: the consent page, Connected apps and the AI approve page. Their element
// shapes (`ConsentClient`, `AiApprovalSummary`, `AiApprovalField`) are covered through these.
type _consent = Assert<Exact<ApiConsentView, WebConsentView>>;
type _connectedApp = Assert<Exact<ApiConnectedAppView, WebConnectedApp>>;
type _connectedApps = Assert<Exact<ApiConnectedAppsView, WebConnectedAppsView>>;
type _aiApproval = Assert<Exact<ApiPendingAiActionView, WebAiApprovalView>>;

// P7 / BG2 (0211): team deliverables and Send for approval — the five views leave EXEMPT now that
// `apps/web/src/lib/api/deliverables.ts` consumes them.
import type {
  ApproverView as ApiApproverView,
  DeliverableDetailView as ApiDeliverableDetailView,
  DeliverableVersionView as ApiDeliverableVersionView,
  DeliverableView as ApiDeliverableView,
  SendForApprovalView as ApiSendForApprovalView,
} from '../../apps/api/src/modules/approvals/deliverables.service.js';
import type {
  ApproverView as WebApproverView,
  DeliverableDetailView as WebDeliverableDetailView,
  DeliverableVersionView as WebDeliverableVersionView,
  DeliverableView as WebDeliverableView,
  SendForApprovalView as WebSendForApprovalView,
} from '../../apps/web/src/lib/api/deliverables';
type _deliverable = Assert<Exact<ApiDeliverableView, WebDeliverableView>>;
type _deliverableVersion = Assert<Exact<ApiDeliverableVersionView, WebDeliverableVersionView>>;
type _deliverableDetail = Assert<Exact<ApiDeliverableDetailView, WebDeliverableDetailView>>;
type _approver = Assert<Exact<ApiApproverView, WebApproverView>>;
type _sendForApproval = Assert<Exact<ApiSendForApprovalView, WebSendForApprovalView>>;

// P8 / BG3 (0212): the request conversation — both views leave EXEMPT now that
// `apps/web/src/lib/api/request-messages.ts` consumes them.
import type {
  RequestMessageClientView as ApiRequestMessageClientView,
  RequestMessageView as ApiRequestMessageView,
} from '../../apps/api/src/modules/requests/request-messages.service.js';
import type {
  RequestMessageClientView as WebRequestMessageClientView,
  RequestMessageView as WebRequestMessageView,
} from '../../apps/web/src/lib/api/request-messages';
type _requestMessage = Assert<Exact<ApiRequestMessageView, WebRequestMessageView>>;
type _requestMessageClient = Assert<
  Exact<ApiRequestMessageClientView, WebRequestMessageClientView>
>;

// A4 (BK3 + 0dece203): direct messages and the @ picker — all four leave EXEMPT now that
// `apps/web/src/lib/api/direct-conversations.ts` and `mention-candidates.ts` consume them.
import type {
  DirectConversationView as ApiDirectConversationView,
  DirectMessageView as ApiDirectMessageView,
  DirectReadStateView as ApiDirectReadStateView,
} from '../../apps/api/src/modules/conversations/direct-conversations.service.js';
import type { MentionCandidateView as ApiMentionCandidateView } from '../../apps/api/src/modules/conversations/mention-candidates.controller.js';
import type {
  DirectConversationSummary as WebDirectConversationSummary,
  DirectMessageSummary as WebDirectMessageSummary,
  DirectReadState as WebDirectReadState,
} from '../../apps/web/src/lib/api/direct-conversations';
import type { MentionCandidate as WebMentionCandidate } from '../../apps/web/src/lib/api/mention-candidates';
type _directConversation = Assert<Exact<ApiDirectConversationView, WebDirectConversationSummary>>;
type _directMessage = Assert<Exact<ApiDirectMessageView, WebDirectMessageSummary>>;
type _directReadState = Assert<Exact<ApiDirectReadStateView, WebDirectReadState>>;
type _mentionCandidate = Assert<Exact<ApiMentionCandidateView, WebMentionCandidate>>;

// A1 (BK2): the built-in role catalogue and the change-role response, read by the People screen's
// Change role and Invite member dialogs (`apps/web/src/lib/api/member-role.ts`). `BuiltInRole`
// narrows: the web types `role`/`capabilities` as plain strings, the API as the domain unions.
import type {
  BuiltInRoleView as ApiBuiltInRoleView,
  MemberRoleChangeView as ApiMemberRoleChangeView,
} from '../../apps/api/src/modules/tenancy/member-role.controller.js';
import type {
  BuiltInRole as WebBuiltInRole,
  MemberRoleChange as WebMemberRoleChange,
} from '../../apps/web/src/lib/api/member-role';
type _builtInRole = Assert<Narrows<ApiBuiltInRoleView, WebBuiltInRole>>;
type _memberRoleChange = Assert<Exact<ApiMemberRoleChangeView, WebMemberRoleChange>>;

// A9 — the project Milestones list and Edit milestone (`GET …/projects/:projectId/milestone-plan`).
import type {
  MilestoneDetailView as ApiMilestoneDetailView,
  MilestonePlanView as ApiMilestonePlanView,
} from '../../apps/api/src/modules/clients/milestone-lifecycle.controller.js';
import type {
  MilestoneDetail as WebMilestoneDetail,
  MilestonePlan as WebMilestonePlan,
} from '../../apps/web/src/lib/api/project-milestones';
type _a9MilestoneDetail = Assert<Exact<ApiMilestoneDetailView, WebMilestoneDetail>>;
type _a9MilestonePlan = Assert<Exact<ApiMilestonePlanView, WebMilestonePlan>>;
