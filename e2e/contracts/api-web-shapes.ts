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
import type { DocumentCommentView as ApiDocumentCommentView } from '../../apps/api/src/modules/docs/document-comments.service.js';
import type { DecisionView as ApiDecisionView } from '../../apps/api/src/modules/decisions/decisions.service.js';
import type { DecisionDetailView as ApiDecisionDetailView } from '../../apps/api/src/modules/decisions/decisions.service.js';
import type { DecisionLockView as ApiDecisionLockView } from '../../apps/api/src/modules/decisions/decisions.service.js';
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
import type { UserPreferencesView as ApiUserPreferencesView } from '../../apps/api/src/modules/preferences/preferences.controller.js';
import type { HomeWidgetPrefsView as ApiHomeWidgetPrefsView } from '../../apps/api/src/modules/home/widget-prefs.controller.js';
import type { InvitationPreviewView as ApiInvitationPreviewView } from '../../apps/api/src/modules/tenancy/invitations.service.js';
import type { InvitationView as ApiInvitationView } from '../../apps/api/src/modules/tenancy/invitations.service.js';
import type { IssuedInvitationView as ApiIssuedInvitationView } from '../../apps/api/src/modules/tenancy/invitations.service.js';
import type { MeetingNoteView as ApiMeetingNoteView } from '../../apps/api/src/modules/calendar/meetings.service.js';
import type { MeetingView as ApiMeetingView } from '../../apps/api/src/modules/calendar/meetings.service.js';
import type { MeetingAttendeeView as ApiMeetingAttendeeView } from '../../apps/api/src/modules/calendar/meeting-attendees.service.js';
import type { MeetingActionItemView as ApiMeetingActionItemView } from '../../apps/api/src/modules/calendar/meeting-action-items.service.js';
import type { MeetingRsvpView as ApiMeetingRsvpView } from '../../apps/api/src/modules/calendar/rsvp.service.js';
import type { MeetingAgendaView as ApiMeetingAgendaView } from '../../apps/api/src/modules/calendar/meeting-agenda.controller.js';
import type { CalendarGridView as ApiCalendarGridView } from '../../apps/api/src/modules/calendar/grid.service.js';
import type {
  NotificationView as ApiNotificationView,
  NotificationFeedView as ApiNotificationFeedView,
} from '../../apps/api/src/modules/notifications/notifications-feed.controller.js';
import type { MeetingSeriesView as ApiMeetingSeriesView } from '../../apps/api/src/modules/calendar/meeting-series.service.js';
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
import type { PortalPersonView as ApiPortalPersonView } from '../../apps/api/src/modules/clients/portal-people.repository.js';
import type { PortalWorkItemView as ApiPortalWorkItemView } from '../../apps/api/src/modules/clients/portal.service.js';
import type { PortalDeliverableView as ApiPortalDeliverableView } from '../../apps/api/src/modules/clients/portal.service.js';
import type { PortalDeliverableFileView as ApiPortalDeliverableFileView } from '../../apps/api/src/modules/clients/portal.service.js';
import type { UpdateCommentView as ApiUpdateCommentView } from '../../apps/api/src/modules/clients/update-comments.service.js';
import type { ClientUpdateCommentView as ApiClientUpdateCommentView } from '../../apps/api/src/modules/clients/update-comments.service.js';
import type { ProjectMilestoneView as ApiProjectMilestoneView } from '../../apps/api/src/modules/clients/project-milestones.projection.js';
import type { ClientMilestoneView as ApiClientMilestoneView } from '../../apps/api/src/modules/clients/project-milestones.projection.js';
import type { MilestoneEditView as ApiMilestoneEditView } from '../../apps/api/src/modules/clients/milestone-lifecycle.controller.js';
import type { ProjectRiskView as ApiProjectRiskView } from '../../apps/api/src/modules/clients/project-risks.controller.js';
import type { PortalAccessLogView as ApiPortalAccessLogView } from '../../apps/api/src/modules/clients/portal-access-log.controller.js';
import type { ClientRiskView as ApiClientRiskView } from '../../apps/api/src/modules/clients/project-risks.controller.js';
import type { PortalSettingsView as ApiPortalSettingsView } from '../../apps/api/src/modules/clients/portal-settings.controller.js';
import type { ProjectClientView as ApiProjectClientView } from '../../apps/api/src/modules/clients/clients.service.js';
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
import type { WorkloadForecastView as ApiWorkloadForecastView } from '../../apps/api/src/modules/insights/workload-forecast.service.js';
import type { RequestAgingView as ApiRequestAgingView } from '../../apps/api/src/modules/requests/request-aging.controller.js';
import type { RequestTriageView as ApiRequestTriageView } from '../../apps/api/src/modules/requests/request-triage.controller.js';
import type { PublicChangelogView as ApiPublicChangelogView } from '../../apps/api/src/modules/public-site/changelog.controller.js';
import type { PersonProfileView as ApiPersonProfileView } from '../../apps/api/src/modules/people/profile.controller.js';
import type { MemberProfileView as ApiMemberProfileView } from '../../apps/api/src/modules/people/member-profile.controller.js';
import type {
  TeamView as ApiTeamView,
  TeamMemberView as ApiTeamMemberView,
  TeamDetailView as ApiTeamDetailView,
} from '../../apps/api/src/modules/people/teams.controller.js';
import type { WorkItemView as ApiWorkItemView } from '../../apps/api/src/modules/work/work-items.service.js';
import type { BulkTransitionView as ApiBulkTransitionView } from '../../apps/api/src/modules/work/bulk-transition.service.js';
import type { WorkChecklistItemView as ApiWorkChecklistItemView } from '../../apps/api/src/modules/work/work-checklist.service.js';
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
import type { PersonCapacityView as ApiPersonCapacityView } from '../../apps/api/src/modules/people/capacity.controller.js';
import type { ReportingLineView as ApiReportingLineView } from '../../apps/api/src/modules/people/reporting-lines.controller.js';
import type { AvailabilityView as ApiAvailabilityView } from '../../apps/api/src/modules/people/availability.controller.js';
import type { CapacityHeatmapView as ApiCapacityHeatmapView } from '../../apps/api/src/modules/people/capacity-heatmap.service.js';
import type { BillingProfileView as ApiBillingProfileView } from '../../apps/api/src/modules/billing/profile.controller.js';
import type { TaxDetailsView as ApiTaxDetailsView } from '../../apps/api/src/modules/billing/tax-details.service.js';
import type { BillingContactView as ApiBillingContactView } from '../../apps/api/src/modules/billing/contacts.service.js';
import type { BillingSeatView as ApiBillingSeatView } from '../../apps/api/src/modules/billing/seats.controller.js';
import type { BillingCreditView as ApiBillingCreditView } from '../../apps/api/src/modules/billing/credits.service.js';
import type { WorkTimelineView as ApiWorkTimelineView } from '../../apps/api/src/modules/work-views/work-views.service.js';
import type { WorkloadView as ApiWorkloadView } from '../../apps/api/src/modules/work-views/work-views.service.js';
import type { WorkCalendarView as ApiWorkCalendarView } from '../../apps/api/src/modules/work-views/work-views.service.js';
import type { SavedViewView as ApiSavedViewView } from '../../apps/api/src/modules/work-views/work-views.service.js';
import type { SavedSearchView as ApiSavedSearchView } from '../../apps/api/src/modules/search/saved-searches.service.js';
import type { RecentSearchView as ApiRecentSearchView } from '../../apps/api/src/modules/search/saved-searches.service.js';
import type { SharedSavedSearchView as ApiSharedSavedSearchView } from '../../apps/api/src/modules/search/saved-search-shares.service.js';
import type { SearchHistoryEntryView as ApiSearchHistoryEntryView } from '../../apps/api/src/modules/search/search-history.service.js';
import type { SearchPinView as ApiSearchPinView } from '../../apps/api/src/modules/search/search-pins.service.js';
import type { WorkspaceView as ApiWorkspaceView } from '../../apps/api/src/modules/tenancy/workspaces.controller.js';
import type { OrgSettingsView as ApiOrgSettingsView } from '../../apps/api/src/modules/tenancy/org-settings.controller.js';
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
import type { RoleEditView as ApiRoleEditView } from '../../apps/api/src/modules/admin/role-edit.controller.js';
import type { MemberBulkRoleView as ApiMemberBulkRoleView } from '../../apps/api/src/modules/tenancy/member-bulk-role.controller.js';
import type { ActiveSessionView as ApiActiveSessionView } from '../../apps/api/src/modules/identity/admin-sessions.controller.js';
import type { OrgPolicyView as ApiOrgPolicyView } from '../../apps/api/src/modules/admin/policies.controller.js';
import type { PolicySimulationView as ApiPolicySimulationView } from '../../apps/api/src/modules/admin/policy-simulate.service.js';
import type { SecuritySettingsView as ApiSecuritySettingsView } from '../../apps/api/src/modules/admin/security.controller.js';
import type { IpAllowlistEntryView as ApiIpAllowlistEntryView } from '../../apps/api/src/modules/admin/ip-allowlist.service.js';
import type { AuditRetentionView as ApiAuditRetentionView } from '../../apps/api/src/modules/admin/audit-retention.service.js';

// ── The shapes `apps/web` declares for them ─────────────────────────────────
import type {
  ClientApprovalView as WebClientApprovalView,
  ClientDecideResult as WebClientDecideResult,
} from '../../apps/web/src/lib/api/approvals';
import type { EnrolledFactor as WebEnrolledFactor } from '../../apps/web/src/lib/api/auth';
import type { A11yPreferencesView as WebA11yPreferencesView } from '../../apps/web/src/lib/api/a11y-preferences';
import type { DisplayPreferencesView as WebDisplayPreferencesView } from '../../apps/web/src/lib/api/display-preferences';
import type { InsightSavedViewView as WebInsightSavedViewView } from '../../apps/web/src/lib/api/insight-saved-views';
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
import type { CustomRoleView as WebCustomRoleView } from '../../apps/web/src/lib/api/admin-roles';
import type { DataExportRequestView as WebDataExportRequestView } from '../../apps/web/src/lib/api/admin-export-requests';
import type { RoleEditView as WebRoleEditView } from '../../apps/web/src/lib/api/admin-role-edit';
import type { MemberBulkRoleView as WebMemberBulkRoleView } from '../../apps/web/src/lib/api/admin-member-bulk-role';
import type { ActiveSessionView as WebActiveSessionView } from '../../apps/web/src/lib/api/admin-sessions';
import type { OrgPolicyView as WebOrgPolicyView } from '../../apps/web/src/lib/api/policies';
import type { PolicySimulationView as WebPolicySimulationView } from '../../apps/web/src/lib/api/policy-simulate';
import type { SecuritySettingsView as WebSecuritySettingsView } from '../../apps/web/src/lib/api/admin-security';
import type { IpAllowlistEntryView as WebIpAllowlistEntryView } from '../../apps/web/src/lib/api/admin-ip-allowlist';
import type { AuditRetentionView as WebAuditRetentionView } from '../../apps/web/src/lib/api/admin-audit-retention';
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
import type { ProjectShare as WebProjectShare } from '../../apps/web/src/lib/api/clients';
import type { DocumentVersionSummary as WebDocumentVersionSummary } from '../../apps/web/src/lib/api/documents';
import type { DocRevisionSummary as WebDocRevisionSummary } from '../../apps/web/src/lib/api/doc-revisions';
import type { DocBookmarkSummary as WebDocBookmarkSummary } from '../../apps/web/src/lib/api/doc-bookmarks';
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
import type { PersonCapacity as WebPersonCapacity } from '../../apps/web/src/lib/api/person-capacity';
import type { ReportingLine as WebReportingLine } from '../../apps/web/src/lib/api/reporting-lines';
import type { AvailabilityView as WebAvailabilityView } from '../../apps/web/src/lib/api/people-availability';
import type { CapacityHeatmapView as WebCapacityHeatmapView } from '../../apps/web/src/lib/api/team-capacity-heatmap';
import type { PersonSkillView as ApiPersonSkillView } from '../../apps/api/src/modules/people/skills.controller.js';
import type { PersonSkillSummary as WebPersonSkillSummary } from '../../apps/web/src/lib/api/people-skills';
import type { SkillSearchView as ApiSkillSearchView } from '../../apps/api/src/modules/people/skill-search.controller.js';
import type { FocusBlockView as ApiFocusBlockView } from '../../apps/api/src/modules/calendar/focus-blocks.service.js';
import type { ConversationMuteView as ApiConversationMuteView } from '../../apps/api/src/modules/conversations/conversation-mute.controller.js';
import type { MessageSearchMatchView as ApiMessageSearchMatchView } from '../../apps/api/src/modules/conversations/conversation-search.service.js';
import type { MessageDraftView as ApiMessageDraftView } from '../../apps/api/src/modules/conversations/message-drafts.service.js';
import type { ConversationReadStateView as ApiConversationReadStateView } from '../../apps/api/src/modules/conversations/read-state.service.js';
import type { ConversationUnreadView as ApiConversationUnreadView } from '../../apps/api/src/modules/conversations/read-state.service.js';
import type { InboxSnoozeView as ApiInboxSnoozeView } from '../../apps/api/src/modules/inbox/inbox-snooze.service.js';
import type { SkillSearchResult as WebSkillSearchResult } from '../../apps/web/src/lib/api/people-skill-search';
import type { BillingProfileView as WebBillingProfileView } from '../../apps/web/src/lib/api/billing';
import type { TaxDetailsView as WebTaxDetailsView } from '../../apps/web/src/lib/api/billing-tax-details';
import type { BillingContactView as WebBillingContactView } from '../../apps/web/src/lib/api/billing-contacts';
import type { BillingSeat as WebBillingSeat } from '../../apps/web/src/lib/api/billing-seats';
import type { BillingCreditView as WebBillingCreditView } from '../../apps/web/src/lib/api/billing-credits';
import type { DecisionDetail as WebDecisionDetail } from '../../apps/web/src/lib/api/decisions';
import type { DecisionLock as WebDecisionLock } from '../../apps/web/src/lib/api/decisions';
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
  InvitationSummary as WebInvitationSummary,
  IssuedInvitation as WebIssuedInvitation,
} from '../../apps/web/src/lib/api/invitations';
import type { MeetingNoteView as WebMeetingNoteView } from '../../apps/web/src/lib/api/meetings';
import type { MeetingView as WebMeetingView } from '../../apps/web/src/lib/api/meetings';
import type { MeetingAttendeeView as WebMeetingAttendeeView } from '../../apps/web/src/lib/api/meeting-attendees';
import type { MeetingActionItemView as WebMeetingActionItemView } from '../../apps/web/src/lib/api/meeting-action-items';
import type { MeetingRsvpView as WebMeetingRsvpView } from '../../apps/web/src/lib/api/meeting-rsvp';
import type { MeetingAgendaView as WebMeetingAgendaView } from '../../apps/web/src/lib/api/meeting-agenda';
import type { CalendarGridView as WebCalendarGridView } from '../../apps/web/src/lib/api/calendar-grid';
import type {
  NotificationView as WebNotificationView,
  NotificationFeedView as WebNotificationFeedView,
} from '../../apps/web/src/lib/api/notifications-feed';
import type { MeetingSeriesView as WebMeetingSeriesView } from '../../apps/web/src/lib/api/meeting-series';
import type { OccurrenceOverrideView as WebOccurrenceOverrideView } from '../../apps/web/src/lib/api/meeting-occurrence-override';
import type { MemberSummary as WebMemberSummary } from '../../apps/web/src/lib/api/members';
import type { PersonSummary as WebPersonSummary } from '../../apps/web/src/lib/api/people';
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
  UpdateEdit as WebUpdateEdit,
  UpdateComment as WebUpdateComment,
  ClientUpdateComment as WebClientUpdateComment,
  PortalWorkItem as WebPortalWorkItem,
  ProjectMilestone as WebProjectMilestone,
  ClientMilestone as WebClientMilestone,
  MilestoneEdit as WebMilestoneEdit,
  ProjectRisk as WebProjectRisk,
  ClientRisk as WebClientRisk,
} from '../../apps/web/src/lib/api/portal';
import type { PortalAccessLogEvent as WebPortalAccessLogEvent } from '../../apps/web/src/lib/api/portal-access-log';
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
import type { Command as WebCommand } from '../../apps/web/src/lib/api/commands';
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
import type { AdminAuditEvent as WebAdminAuditEvent } from '../../apps/web/src/lib/api/admin-audit';
import type { AdminOverviewView as WebAdminOverviewView } from '../../apps/web/src/lib/api/admin-overview';
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
import type { WorkloadForecastView as WebWorkloadForecastView } from '../../apps/web/src/lib/api/workload-forecast';
import type { RequestAgingView as WebRequestAgingView } from '../../apps/web/src/lib/api/request-aging';
import type { RequestTriageView as WebRequestTriageView } from '../../apps/web/src/lib/api/request-triage';
import type { PublicChangelogView as WebPublicChangelogView } from '../../apps/web/src/lib/api/public-changelog';
import type { PersonProfileView as WebPersonProfileView } from '../../apps/web/src/lib/api/person-profile';
import type { MemberProfileView as WebMemberProfileView } from '../../apps/web/src/lib/api/member-profile';
import type {
  TeamView as WebTeamView,
  TeamMemberView as WebTeamMemberView,
  TeamDetailView as WebTeamDetailView,
} from '../../apps/web/src/lib/api/people-teams';
import type { WorkItemSummary as WebWorkItemSummary } from '../../apps/web/src/lib/api/work-items';
import type { BulkTransitionView as WebBulkTransitionView } from '../../apps/web/src/lib/api/work-bulk-transition';
import type { WorkChecklistItem as WebWorkChecklistItem } from '../../apps/web/src/lib/api/work-items';
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
import type { WorkItemRecurrence as WebWorkItemRecurrence } from '../../apps/web/src/lib/api/work-item-recurrence';
import type { NextOccurrence as WebNextOccurrence } from '../../apps/web/src/lib/api/work-item-recurrence';
import type { ProjectTag as WebProjectTag } from '../../apps/web/src/lib/api/project-tags';
import type { ProjectTagAssignment as WebProjectTagAssignment } from '../../apps/web/src/lib/api/project-tags';
import type { FileTag as WebFileTag } from '../../apps/web/src/lib/api/file-tags';
import type { FileTagAssignment as WebFileTagAssignment } from '../../apps/web/src/lib/api/file-tags';
import type { ChecklistTemplate as WebChecklistTemplate } from '../../apps/web/src/lib/api/work-checklist-templates';
import type { ApplyTemplateResult as WebApplyTemplateResult } from '../../apps/web/src/lib/api/work-checklist-templates';
import type { WorkTimelineView as WebWorkTimelineView } from '../../apps/web/src/lib/api/work-views';
import type { WorkloadView as WebWorkloadView } from '../../apps/web/src/lib/api/work-views';
import type { WorkCalendarView as WebWorkCalendarView } from '../../apps/web/src/lib/api/work-views';
import type { SavedViewView as WebSavedViewView } from '../../apps/web/src/lib/api/work-views';
import type { SavedSearch as WebSavedSearch } from '../../apps/web/src/lib/api/saved-searches';
import type { RecentSearch as WebRecentSearch } from '../../apps/web/src/lib/api/saved-searches';
import type { SharedSavedSearch as WebSharedSavedSearch } from '../../apps/web/src/lib/api/saved-search-shares';
import type { SearchHistoryEntry as WebSearchHistoryEntry } from '../../apps/web/src/lib/api/search-history';
import type { SearchPin as WebSearchPin } from '../../apps/web/src/lib/api/search-pins';
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
// SEC / Portal update comments (x203): the internal thread and the client projection. The panel
// reads exactly these responses, so both pairs are Exact; the client view drops the staff author.
type _updateComment = Assert<Exact<ApiUpdateCommentView, WebUpdateComment>>;
type _clientUpdateComment = Assert<Exact<ApiClientUpdateCommentView, WebClientUpdateComment>>;
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
 * SRCH command palette (x181). `CommandView` ↔ `Command` — one palette command
 * (`GET …/search/commands?q=`). Paired Exact, not exempt: x181 ships `CommandPalette`, a real web
 * consumer, so the `id`/`title`/`section`/`kind`/`href`/`action` shape and the `CommandKind` union
 * (`navigate | action`) are held identical on both sides. Distinct from `SearchResult`: a command is
 * a fixed navigation or allowlisted quick action, never a row.
 */
type _command = Assert<Exact<ApiCommandView, WebCommand>>;

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
 * Custom roles (x173). `CustomRoleView` (`GET/POST …/admin/roles`, response) — the organization's custom
 * roles, each with its capability subset. Paired with a live web consumer: `AdminRolesScreen` reads
 * exactly this response to render the role list and the capability picker. One projection; its per-role
 * item (`{ id, name, capabilities, createdAt }`) is inlined on both sides, so this pair covers it
 * structurally. The wire projection never echoes the tenant id.
 */
type _customRoles = Assert<Exact<ApiCustomRoleView, WebCustomRoleView>>;

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
 * `GET …/people` — module 14 / audit #4 (x168). One People & capacity directory row:
 * `PeopleDirectoryScreen` reads exactly this projection (name, role, status, project count),
 * so it pairs Exact; `membershipId` (the keyset cursor) is on neither side.
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
// INBOX important flags (IN-01, x260). `InboxFlagView` (PUT/DELETE a bundle's flag) and
// `InboxFlaggedView` (GET the caller's flagged ids). The screen reads exactly these, so both Exact.
type _inboxFlag = Assert<Exact<ApiInboxFlagView, WebInboxFlagView>>;
type _inboxFlagged = Assert<Exact<ApiInboxFlaggedView, WebInboxFlaggedView>>;
// HOME quick links (module 4 My Day, x273). `HomeQuickLinksView` wraps the caller's ordered links;
// the screen reads exactly this response, so the pair is Exact. Its element (web `HomeQuickLink`,
// API `HomeQuickLinkItem`) is covered transitively through this pair — see WEB_EXEMPT.
type _homeQuickLinks = Assert<Exact<ApiHomeQuickLinksView, WebHomeQuickLinksView>>;
