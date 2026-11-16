import { translate, type MessageKey } from './i18n/t';

/**
 * Every route's tab title, in English and in the active locale (live check f30af1d0, lane E1).
 *
 * The live site showed a bare `TManage` tab on `/sign-in` and `/recover` in both languages, while
 * `/pricing` read `Pricing · TManage` / `الأسعار · TManage`. Most routes are client pages, which
 * cannot export `metadata`, so this table is the one place a route's page name lives: server
 * pages and route layouts take their English `metadata.title` from it (`routeTitle`), and
 * `RouteDocumentTitle` writes the active locale's name in the browser. `route-titles.test.ts`
 * walks `src/app` and fails on a route with no row, or with a bare or untranslated name.
 */

/** A route whose page sets its own title (a dynamic article title, the home page's hero line). */
export const PAGE_OWNS_TITLE = 'page-owns-title';

export interface RouteTitleRow {
  /** the English page name, the route's `metadata.title` */
  readonly en: string;
  /** the catalog key of the page name */
  readonly key: string;
}

export type RouteTitleEntry = RouteTitleRow | typeof PAGE_OWNS_TITLE;

/** The suffix the root layout's title template adds. */
export const TITLE_SUFFIX = ' · TManage';

/** Route pattern (as the folders under `src/app` spell it, route groups dropped) → page name. */
export const ROUTE_TITLES: Readonly<Record<string, RouteTitleEntry>> = {
  '/about': { en: 'About', key: 'WebsiteTitle.about' },
  '/changelog': { en: 'Changelog', key: 'WebsiteTitle.changelog' },
  '/client-portal': { en: 'Client portal', key: 'WebsiteTitle.clientPortal' },
  '/contact': { en: 'Book a demo', key: 'WebsiteTitle.contact' },
  '/customers': { en: 'Customers & stories', key: 'WebsiteTitle.customers' },
  '/developers': { en: 'Developers', key: 'WebsiteTitle.developers' },
  '/download': { en: 'Download', key: 'WebsiteTitle.download' },
  '/faq': { en: 'FAQ', key: 'WebsiteTitle.faq' },
  '/help': { en: 'Help centre', key: 'WebsiteTitle.help' },
  '/features/communication': { en: 'Chat & calendar', key: 'WebsiteTitle.featuresCommunication' },
  '/features/insights': { en: 'Insights & automations', key: 'WebsiteTitle.featuresInsights' },
  '/features/knowledge': {
    en: 'Docs, decisions & approvals',
    key: 'WebsiteTitle.featuresKnowledge',
  },
  '/features/work': { en: 'Work, requests & projects', key: 'WebsiteTitle.featuresWork' },
  '/integrations': { en: 'Integrations', key: 'WebsiteTitle.integrations' },
  '/legal/privacy': { en: 'Privacy Policy', key: 'WebsiteTitle.privacy' },
  '/legal/terms': { en: 'Terms of Service', key: 'WebsiteTitle.terms' },
  '/platform/incidents': { en: 'Incidents', key: 'RouteTitle.platformIncidents' },
  '/platform/support': { en: 'Support', key: 'RouteTitle.platformSupport' },
  '/pricing': { en: 'Pricing', key: 'WebsiteTitle.pricing' },
  '/product': { en: 'Product overview', key: 'WebsiteTitle.product' },
  '/a/[token]': { en: 'Approval request', key: 'RouteTitle.approverLink' },
  '/portal-sign-in/[token]': { en: 'Portal sign-in', key: 'RouteTitle.portalSignInLink' },
  '/q/[token]': { en: 'Quote', key: 'RouteTitle.quotePublic' },
  '/resources': { en: 'Resources', key: 'WebsiteTitle.resources' },
  '/accessibility': { en: 'Accessibility', key: 'WebsiteTitle.accessibility' },
  '/security': { en: 'Security & trust', key: 'WebsiteTitle.security' },
  '/security/data-location': { en: 'Where your data lives', key: 'WebsiteTitle.dataLocation' },
  '/security/disclosure': {
    en: 'Report a security problem',
    key: 'WebsiteTitle.securityDisclosure',
  },
  '/solutions/agencies': { en: 'Agencies & studios', key: 'WebsiteTitle.solutionsAgencies' },
  '/solutions/consultancies': { en: 'Consultancies', key: 'WebsiteTitle.solutionsConsultancies' },
  '/solutions/in-house': { en: 'In-house teams', key: 'WebsiteTitle.solutionsInHouse' },
  '/status': { en: 'Service status', key: 'WebsiteTitle.status' },
  '/forbidden': { en: 'Access denied', key: 'WebsiteTitle.forbidden' },
  '/offline': { en: 'Offline', key: 'WebsiteTitle.offline' },
  '/sign-in': { en: 'Sign in', key: 'RouteTitle.signIn' },
  '/sign-in/verify': { en: 'Two-step verification', key: 'RouteTitle.signInVerify' },
  '/sign-up': { en: 'Create your TManage account', key: 'RouteTitle.signUp' },
  '/recover': { en: 'Recover your account', key: 'RouteTitle.recover' },
  '/recover/[token]': { en: 'Choose a new password', key: 'RouteTitle.recoverToken' },
  '/setup': { en: 'Set up TManage', key: 'RouteTitle.setup' },
  '/sessions': { en: 'Your sessions', key: 'RouteTitle.sessions' },
  '/sessions/[sessionId]/trail': { en: 'Session sign-in trail', key: 'RouteTitle.sessionTrail' },
  '/organizations': { en: 'Choose a workspace', key: 'RouteTitle.organizations' },
  // `/app` only redirects to the workspace chooser, so it carries that page's name.
  '/app/[[...rest]]': { en: 'Choose a workspace', key: 'RouteTitle.organizations' },
  '/onboarding/organization': {
    en: 'Create your workspace',
    key: 'RouteTitle.onboardingOrganization',
  },
  '/f/[slug]': { en: 'Request form', key: 'RouteTitle.publicForm' },
  '/invitations/[token]': { en: 'Invitation', key: 'RouteTitle.invitation' },
  '/connect/authorize': { en: 'Authorize access', key: 'RouteTitle.connectAuthorize' },
  '/platform': { en: 'Platform', key: 'RouteTitle.platform' },
  '/platform/ai-access': { en: 'AI access', key: 'RouteTitle.platformAiAccess' },
  '/platform/audit': { en: 'Platform audit', key: 'RouteTitle.platformAudit' },
  '/platform/companies': { en: 'Companies', key: 'RouteTitle.platformCompanies' },
  '/platform/companies/[organizationId]': { en: 'Company', key: 'RouteTitle.platformCompany' },
  '/platform/people': { en: 'People', key: 'RouteTitle.platformPeople' },
  '/platform/settings': { en: 'Platform settings', key: 'RouteTitle.platformSettings' },
  '/[orgSlug]': { en: 'Home', key: 'RouteTitle.home' },
  '/[orgSlug]/home': { en: 'Home', key: 'RouteTitle.home' },
  '/[orgSlug]/admin': { en: 'Admin', key: 'RouteTitle.admin' },
  '/[orgSlug]/admin/audit': { en: 'Audit log', key: 'RouteTitle.adminAudit' },
  '/[orgSlug]/admin/audit/export': { en: 'Export audit log', key: 'RouteTitle.adminAuditExport' },
  '/[orgSlug]/admin/automations/webhooks': { en: 'Webhooks', key: 'RouteTitle.adminWebhooks' },
  '/[orgSlug]/admin/automations/webhooks/[endpointId]/deliveries': {
    en: 'Webhook deliveries',
    key: 'RouteTitle.adminWebhookDeliveries',
  },
  '/[orgSlug]/admin/feature-flags': { en: 'Feature flags', key: 'RouteTitle.adminFeatureFlags' },
  '/[orgSlug]/admin/file-safety': { en: 'Blocked files', key: 'BlockedFiles.title' },
  '/[orgSlug]/admin/incidents': { en: 'Incidents', key: 'RouteTitle.adminIncidents' },
  '/[orgSlug]/admin/ip-allowlist': { en: 'IP allowlist', key: 'RouteTitle.adminIpAllowlist' },
  '/[orgSlug]/admin/privacy': { en: 'Privacy', key: 'RouteTitle.adminPrivacy' },
  '/[orgSlug]/admin/public-links': { en: 'Public links', key: 'RouteTitle.adminPublicLinks' },
  '/[orgSlug]/admin/roles': { en: 'Roles', key: 'RouteTitle.adminRoles' },
  '/[orgSlug]/admin/roles/edit': { en: 'Edit role', key: 'RouteTitle.adminRoleEdit' },
  '/[orgSlug]/admin/security': { en: 'Security', key: 'RouteTitle.adminSecurity' },
  '/[orgSlug]/admin/security-signals': { en: 'Security signals', key: 'SecuritySignals.title' },
  '/[orgSlug]/admin/working-calendar': {
    en: 'Working calendar',
    key: 'RouteTitle.adminWorkingCalendar',
  },
  '/[orgSlug]/admin/sessions': { en: 'Sessions', key: 'RouteTitle.adminSessions' },
  '/[orgSlug]/admin/sessions/[sessionId]/trail': {
    en: 'Session sign-in trail',
    key: 'RouteTitle.adminSessionTrail',
  },
  '/[orgSlug]/admin/storage': { en: 'Storage', key: 'RouteTitle.adminStorage' },
  '/[orgSlug]/ai/approve/[id]': { en: 'AI approval', key: 'RouteTitle.aiApprove' },
  '/[orgSlug]/automations': { en: 'Automations', key: 'RouteTitle.automations' },
  '/[orgSlug]/automations/apps': { en: 'Integrations', key: 'RouteTitle.automationApps' },
  '/[orgSlug]/automations/builder': {
    en: 'New automation',
    key: 'RouteTitle.automationBuilderStart',
  },
  '/[orgSlug]/automations/runs': { en: 'Automation runs', key: 'RouteTitle.automationRuns' },
  '/[orgSlug]/automations/schedules': { en: 'Schedules', key: 'RouteTitle.automationSchedules' },
  '/[orgSlug]/automations/templates/[templateId]': {
    en: 'Automation template',
    key: 'RouteTitle.automationTemplate',
  },
  '/[orgSlug]/automations/templates/[templateId]/builder': {
    en: 'Automation builder',
    key: 'RouteTitle.automationBuilder',
  },
  '/[orgSlug]/billing': { en: 'Billing', key: 'RouteTitle.billing' },
  '/[orgSlug]/billing/contacts': { en: 'Billing contacts', key: 'RouteTitle.billingContacts' },
  '/[orgSlug]/billing/cost-center-report': {
    en: 'Cost center report',
    key: 'RouteTitle.billingCostCenterReport',
  },
  '/[orgSlug]/billing/cost-centers': { en: 'Cost centers', key: 'RouteTitle.billingCostCenters' },
  '/[orgSlug]/billing/credits': { en: 'Credits', key: 'RouteTitle.billingCredits' },
  '/[orgSlug]/billing/discounts': { en: 'Discounts', key: 'RouteTitle.billingDiscounts' },
  '/[orgSlug]/billing/invoices': { en: 'Invoices', key: 'RouteTitle.billingInvoices' },
  '/[orgSlug]/billing/invoices/[invoiceId]/lines': {
    en: 'Invoice lines',
    key: 'RouteTitle.billingInvoiceLines',
  },
  '/[orgSlug]/billing/plan-change/preview': {
    en: 'Plan change preview',
    key: 'RouteTitle.billingPlanChangePreview',
  },
  '/[orgSlug]/billing/plan-change/request': {
    en: 'Request a plan change',
    key: 'RouteTitle.billingPlanChangeRequest',
  },
  '/[orgSlug]/billing/purchase-orders': {
    en: 'Purchase orders',
    key: 'RouteTitle.billingPurchaseOrders',
  },
  '/[orgSlug]/billing/seats': { en: 'Seats', key: 'RouteTitle.billingSeats' },
  '/[orgSlug]/billing/settings': { en: 'Billing settings', key: 'RouteTitle.billingSettings' },
  '/[orgSlug]/billing/subscription': { en: 'Subscription', key: 'RouteTitle.billingSubscription' },
  '/[orgSlug]/billing/tax-details': { en: 'Tax details', key: 'RouteTitle.billingTaxDetails' },
  '/[orgSlug]/billing/usage-alerts': { en: 'Usage alerts', key: 'RouteTitle.billingUsageAlerts' },
  '/[orgSlug]/billing/usage/export': { en: 'Export usage', key: 'RouteTitle.billingUsageExport' },
  '/[orgSlug]/calendar': { en: 'Calendar', key: 'RouteTitle.calendar' },
  '/[orgSlug]/calendar/agenda': { en: 'Agenda', key: 'RouteTitle.calendarAgenda' },
  '/[orgSlug]/calendar/agenda-templates': {
    en: 'Agenda templates',
    key: 'RouteTitle.calendarAgendaTemplates',
  },
  '/[orgSlug]/calendar/focus-blocks': { en: 'Focus blocks', key: 'RouteTitle.calendarFocusBlocks' },
  '/[orgSlug]/calendar/grid': { en: 'Calendar grid', key: 'RouteTitle.calendarGrid' },
  '/[orgSlug]/calendar/meetings/[meetingId]': { en: 'Meeting', key: 'RouteTitle.meeting' },
  '/[orgSlug]/calendar/meetings/[meetingId]/edit': {
    en: 'Edit meeting',
    key: 'RouteTitle.meetingEdit',
  },
  '/[orgSlug]/calendar/meetings/[meetingId]/action-items': {
    en: 'Action items',
    key: 'RouteTitle.meetingActionItems',
  },
  '/[orgSlug]/calendar/meetings/[meetingId]/attendees': {
    en: 'Attendees',
    key: 'RouteTitle.meetingAttendees',
  },
  '/[orgSlug]/calendar/meetings/[meetingId]/notes': {
    en: 'Meeting notes',
    key: 'RouteTitle.meetingNotes',
  },
  '/[orgSlug]/calendar/meetings/[meetingId]/rsvp': { en: 'RSVP', key: 'RouteTitle.meetingRsvp' },
  '/[orgSlug]/calendar/meetings/[meetingId]/time-poll': {
    en: 'Time poll',
    key: 'RouteTitle.meetingTimePoll',
  },
  '/[orgSlug]/calendar/new': { en: 'New meeting', key: 'RouteTitle.calendarNew' },
  '/[orgSlug]/calendar/series': { en: 'Meeting series', key: 'RouteTitle.calendarSeries' },
  '/[orgSlug]/capture': { en: 'Quick capture', key: 'RouteTitle.capture' },
  '/[orgSlug]/chat': { en: 'Chat', key: 'RouteTitle.chat' },
  '/[orgSlug]/chat/[conversationId]': { en: 'Conversation', key: 'RouteTitle.chatConversation' },
  '/[orgSlug]/chat/[conversationId]/search': {
    en: 'Search conversation',
    key: 'RouteTitle.chatSearch',
  },
  '/[orgSlug]/chat/dm/[directConversationId]': {
    en: 'Direct message',
    key: 'RouteTitle.chatDirect',
  },
  '/[orgSlug]/chat/invite/[token]': { en: 'Group invite', key: 'RouteTitle.chatInvite' },
  '/[orgSlug]/chat/mentions': { en: 'Mentions', key: 'RouteTitle.chatMentions' },
  '/[orgSlug]/clients': { en: 'Clients', key: 'RouteTitle.clients' },
  '/[orgSlug]/clients/[clientOrganizationId]': {
    en: 'Client company',
    key: 'RouteTitle.clientCompany',
  },
  '/[orgSlug]/clients/import': { en: 'Import contacts', key: 'RouteTitle.clientsImport' },
  '/[orgSlug]/copilot': { en: 'Copilot', key: 'RouteTitle.copilot' },
  '/[orgSlug]/decisions': { en: 'Decisions', key: 'RouteTitle.decisions' },
  '/[orgSlug]/decisions/[decisionId]': { en: 'Decision', key: 'RouteTitle.decision' },
  '/[orgSlug]/docs': { en: 'Docs', key: 'RouteTitle.docs' },
  '/[orgSlug]/docs/[documentId]': { en: 'Document', key: 'RouteTitle.document' },
  '/[orgSlug]/figma/[linkId]': { en: 'Figma review', key: 'RouteTitle.figmaReview' },
  '/[orgSlug]/files': { en: 'Files', key: 'RouteTitle.files' },
  '/[orgSlug]/files/[fileId]': { en: 'File review', key: 'RouteTitle.fileReview' },
  '/[orgSlug]/docs/[documentId]/print': { en: 'Print document', key: 'RouteTitle.documentPrint' },
  '/[orgSlug]/docs/[documentId]/edit': { en: 'Edit document', key: 'RouteTitle.documentEdit' },
  '/[orgSlug]/docs/collections': { en: 'Collections', key: 'RouteTitle.docCollections' },
  '/[orgSlug]/docs/templates': { en: 'Document templates', key: 'RouteTitle.docTemplates' },
  '/[orgSlug]/docs/templates/[templateId]/variables': {
    en: 'Template variables',
    key: 'RouteTitle.docTemplateVariables',
  },
  '/[orgSlug]/forms': { en: 'Intake forms', key: 'RouteTitle.workForms' },
  '/[orgSlug]/help': { en: 'Get help', key: 'RouteTitle.getHelp' },
  '/[orgSlug]/help/connect-ai': { en: 'Connect your AI', key: 'RouteTitle.helpConnectAi' },
  '/[orgSlug]/inbox': { en: 'Inbox', key: 'RouteTitle.inbox' },
  '/[orgSlug]/inbox/notification-preferences': {
    en: 'Notification preferences',
    key: 'RouteTitle.inboxNotificationPreferences',
  },
  '/[orgSlug]/inbox/rules': { en: 'Inbox rules', key: 'RouteTitle.inboxRules' },
  '/[orgSlug]/insights': { en: 'Insights', key: 'RouteTitle.insights' },
  '/[orgSlug]/insights/adoption': { en: 'Adoption', key: 'RouteTitle.insightsAdoption' },
  '/[orgSlug]/insights/custom-reports': {
    en: 'Custom reports',
    key: 'RouteTitle.insightsCustomReports',
  },
  '/[orgSlug]/insights/dashboard-layout': {
    en: 'Dashboard layout',
    key: 'RouteTitle.insightsDashboardLayout',
  },
  '/[orgSlug]/insights/favorites': { en: 'Favorites', key: 'RouteTitle.insightsFavorites' },
  '/[orgSlug]/insights/forecast': { en: 'Forecast', key: 'RouteTitle.insightsForecast' },
  '/[orgSlug]/insights/metric-alerts': {
    en: 'Metric alerts',
    key: 'RouteTitle.insightsMetricAlerts',
  },
  '/[orgSlug]/insights/projects/[projectId]': {
    en: 'Project insights',
    key: 'RouteTitle.insightsProject',
  },
  '/[orgSlug]/insights/projects/[projectId]/approval-cycle': {
    en: 'Approval cycle',
    key: 'RouteTitle.insightsApprovalCycle',
  },
  '/[orgSlug]/insights/report-schedules': {
    en: 'Report schedules',
    key: 'RouteTitle.insightsReportSchedules',
  },
  '/[orgSlug]/insights/saved-views': { en: 'Saved views', key: 'RouteTitle.insightsSavedViews' },
  '/[orgSlug]/insights/targets': { en: 'Targets', key: 'RouteTitle.insightsTargets' },
  '/[orgSlug]/notifications': { en: 'Notifications', key: 'RouteTitle.notifications' },
  '/[orgSlug]/objectives': { en: 'Objectives', key: 'RouteTitle.objectives' },
  '/[orgSlug]/onboarding': { en: 'Set up TManage', key: 'RouteTitle.setup' },
  '/[orgSlug]/onboarding/import': { en: 'Import', key: 'RouteTitle.onboardingImport' },
  '/[orgSlug]/onboarding/import/[jobId]': { en: 'Import', key: 'RouteTitle.onboardingImport' },
  '/[orgSlug]/onboarding/import/from-app': { en: 'Import', key: 'RouteTitle.onboardingImport' },
  '/[orgSlug]/onboarding/project': { en: 'Set up a project', key: 'RouteTitle.onboardingProject' },
  '/[orgSlug]/onboarding/team': { en: 'Invite your team', key: 'RouteTitle.onboardingTeam' },
  '/[orgSlug]/onboarding/template': {
    en: 'Choose a template',
    key: 'RouteTitle.onboardingTemplate',
  },
  '/[orgSlug]/onboarding/tour': { en: 'Product tour', key: 'RouteTitle.onboardingTour' },
  '/[orgSlug]/people': { en: 'People', key: 'RouteTitle.people' },
  '/[orgSlug]/people/[membershipId]': { en: 'Profile', key: 'RouteTitle.person' },
  '/[orgSlug]/people/allocations': { en: 'Allocations', key: 'RouteTitle.peopleAllocations' },
  '/[orgSlug]/people/availability': { en: 'Availability', key: 'RouteTitle.peopleAvailability' },
  '/[orgSlug]/people/capacity': { en: 'Capacity', key: 'RouteTitle.peopleCapacity' },
  '/[orgSlug]/people/capacity/heatmap': {
    en: 'Capacity heatmap',
    key: 'RouteTitle.peopleCapacityHeatmap',
  },
  '/[orgSlug]/people/offboarding': { en: 'Offboarding', key: 'RouteTitle.peopleOffboarding' },
  '/[orgSlug]/people/org-chart': { en: 'Org chart', key: 'RouteTitle.peopleOrgChart' },
  '/[orgSlug]/people/teams': { en: 'Teams', key: 'RouteTitle.peopleTeams' },
  '/[orgSlug]/people/time-off': { en: 'Time off', key: 'RouteTitle.peopleTimeOff' },
  '/[orgSlug]/signatures/[requestId]': {
    en: 'Signature request',
    key: 'RouteTitle.signatureRequest',
  },
  '/[orgSlug]/policies': { en: 'Policies', key: 'RouteTitle.policies' },
  '/[orgSlug]/policies/simulate': { en: 'Policy simulator', key: 'RouteTitle.policiesSimulate' },
  '/[orgSlug]/portal': { en: 'Client portal', key: 'RouteTitle.portal' },
  '/[orgSlug]/portal/sign-in': { en: 'Portal sign-in', key: 'RouteTitle.portalSignIn' },
  '/[orgSlug]/portal/accessibility': {
    en: 'Display and accessibility',
    key: 'RouteTitle.portalAccessibility',
  },
  '/[orgSlug]/portal/actions': { en: 'Actions', key: 'RouteTitle.portalActions' },
  '/[orgSlug]/portal/deliverables': { en: 'Deliverables', key: 'RouteTitle.portalDeliverables' },
  '/[orgSlug]/portal/deliverables/[deliverableVersionId]': {
    en: 'Deliverable',
    key: 'RouteTitle.portalDeliverable',
  },
  '/[orgSlug]/portal/deliverables/[deliverableVersionId]/record': {
    en: 'Approval record',
    key: 'RouteTitle.portalApprovalRecord',
  },
  '/[orgSlug]/portal/sign/[requestId]': { en: 'Sign a document', key: 'RouteTitle.portalSign' },
  '/[orgSlug]/portal/chat': { en: 'Chat', key: 'RouteTitle.portalChat' },
  '/[orgSlug]/portal/chat/[conversationId]': {
    en: 'Conversation',
    key: 'RouteTitle.portalChatConversation',
  },
  '/[orgSlug]/portal/figma/[linkId]': { en: 'Figma review', key: 'RouteTitle.portalFigmaReview' },
  '/[orgSlug]/portal/files': { en: 'Files', key: 'RouteTitle.portalFiles' },
  '/[orgSlug]/portal/files/[fileId]': {
    en: 'File review',
    key: 'RouteTitle.portalFileReview',
  },
  '/[orgSlug]/portal/inbox': { en: 'Portal inbox', key: 'RouteTitle.portalInbox' },
  '/[orgSlug]/portal/people': { en: 'People', key: 'RouteTitle.portalPeople' },
  '/[orgSlug]/portal/requests': { en: 'Requests', key: 'RouteTitle.portalRequests' },
  '/[orgSlug]/portal/requests/[requestId]': { en: 'Request', key: 'RouteTitle.portalRequest' },
  '/[orgSlug]/portal/requests/new': { en: 'New request', key: 'RouteTitle.portalRequestNew' },
  '/[orgSlug]/portal/risks': { en: 'Risks', key: 'RouteTitle.portalRisks' },
  '/[orgSlug]/portal/timeline': { en: 'Timeline', key: 'RouteTitle.portalTimeline' },
  // 53-12: a client person's meeting with one-tap Join.
  '/[orgSlug]/portal/meetings/[meetingId]': { en: 'Meeting', key: 'RouteTitle.meeting' },
  '/[orgSlug]/portal/updates': { en: 'Updates', key: 'RouteTitle.portalUpdates' },
  '/[orgSlug]/preferences': { en: 'Preferences', key: 'RouteTitle.preferences' },
  '/[orgSlug]/projects/[projectId]': { en: 'Project', key: 'RouteTitle.project' },
  '/[orgSlug]/projects/[projectId]/allocations': {
    en: 'Allocations',
    key: 'RouteTitle.projectAllocations',
  },
  '/[orgSlug]/projects/[projectId]/baselines': {
    en: 'Baselines',
    key: 'RouteTitle.projectBaselines',
  },
  '/[orgSlug]/projects/[projectId]/github': { en: 'Settings', key: 'RouteTitle.settings' },
  '/[orgSlug]/projects/[projectId]/deliverables': {
    en: 'Deliverables',
    key: 'RouteTitle.projectDeliverables',
  },
  '/[orgSlug]/projects/[projectId]/deliverables/[deliverableId]': {
    en: 'Deliverable',
    key: 'RouteTitle.projectDeliverable',
  },
  '/[orgSlug]/projects/[projectId]/deliverables/[deliverableId]/approvals/[approvalId]/record': {
    en: 'Approval record',
    key: 'RouteTitle.projectApprovalRecord',
  },
  '/[orgSlug]/projects/[projectId]/members': {
    en: 'Project members',
    key: 'RouteTitle.projectMembers',
  },
  '/[orgSlug]/projects/[projectId]/milestones': {
    en: 'Milestones',
    key: 'RouteTitle.projectMilestones',
  },
  '/[orgSlug]/projects/[projectId]/iterations': {
    en: 'Iterations',
    key: 'RouteTitle.projectIterations',
  },
  '/[orgSlug]/projects/[projectId]/objectives': {
    en: 'Project objectives',
    key: 'RouteTitle.projectObjectives',
  },
  '/[orgSlug]/projects/[projectId]/portal-access-log': {
    en: 'Portal access log',
    key: 'RouteTitle.projectPortalAccessLog',
  },
  '/[orgSlug]/projects/[projectId]/risk-register': {
    en: 'Risk register',
    key: 'RouteTitle.projectRiskRegister',
  },
  '/[orgSlug]/projects/[projectId]/risks': { en: 'Risks', key: 'RouteTitle.projectRisks' },
  '/[orgSlug]/projects/new': { en: 'New project', key: 'RouteTitle.projectNew' },
  '/[orgSlug]/projects/portfolio': { en: 'Portfolio', key: 'RouteTitle.projectsPortfolio' },
  '/[orgSlug]/projects/tags': { en: 'Project tags', key: 'RouteTitle.projectsTags' },
  '/[orgSlug]/projects/templates': { en: 'Project templates', key: 'RouteTitle.projectsTemplates' },
  '/[orgSlug]/search': { en: 'Search', key: 'RouteTitle.search' },
  '/[orgSlug]/search/pins': { en: 'Pinned results', key: 'RouteTitle.searchPins' },
  '/[orgSlug]/search/saved': { en: 'Saved searches', key: 'RouteTitle.searchSaved' },
  '/[orgSlug]/settings': { en: 'Settings', key: 'RouteTitle.settings' },
  '/[orgSlug]/settings/accessibility': {
    en: 'Accessibility',
    key: 'RouteTitle.settingsAccessibility',
  },
  '/[orgSlug]/settings/ai-assistant': { en: 'AI assistant', key: 'RouteTitle.settingsAiAssistant' },
  '/[orgSlug]/settings/calendar-connections': {
    en: 'Calendar connections',
    key: 'RouteTitle.settingsCalendarConnections',
  },
  '/[orgSlug]/settings/connected-apps': {
    en: 'Connected apps',
    key: 'RouteTitle.settingsConnectedApps',
  },
  '/[orgSlug]/settings/digest': { en: 'Email digest', key: 'RouteTitle.settingsDigest' },
  '/[orgSlug]/settings/display': { en: 'Display', key: 'RouteTitle.settingsDisplay' },
  '/[orgSlug]/settings/inbound-mail': {
    en: 'Inbound mail',
    key: 'RouteTitle.settingsInboundMail',
  },
  '/[orgSlug]/settings/my-data': { en: 'My data', key: 'RouteTitle.settingsMyData' },
  '/[orgSlug]/settings/organization': {
    en: 'Organization policy',
    key: 'RouteTitle.settingsOrganization',
  },
  '/[orgSlug]/settings/quiet-hours': { en: 'Quiet hours', key: 'RouteTitle.settingsQuietHours' },
  '/[orgSlug]/settings/security': { en: 'Security', key: 'RouteTitle.settingsSecurity' },
  '/[orgSlug]/settings/sign-in-security': {
    en: 'Sign-in security',
    key: 'RouteTitle.settingsSignInSecurity',
  },
  '/[orgSlug]/settings/startup': { en: 'Startup', key: 'RouteTitle.settingsStartup' },
  '/[orgSlug]/settings/two-step': {
    en: 'Two-step verification',
    key: 'RouteTitle.settingsTwoStep',
  },
  '/[orgSlug]/work': { en: 'Work', key: 'RouteTitle.work' },
  '/[orgSlug]/work/[workItemId]': { en: 'Work item', key: 'RouteTitle.workItem' },
  '/[orgSlug]/work/[workItemId]/activity': { en: 'Activity', key: 'RouteTitle.workItemActivity' },
  '/[orgSlug]/work/[workItemId]/estimate': { en: 'Estimate', key: 'RouteTitle.workItemEstimate' },
  '/[orgSlug]/work/[workItemId]/links': { en: 'Links', key: 'RouteTitle.workItemLinks' },
  '/[orgSlug]/work/[workItemId]/time-logs': { en: 'Time logs', key: 'RouteTitle.workItemTimeLogs' },
  '/[orgSlug]/work/calendar': { en: 'Work calendar', key: 'RouteTitle.workCalendar' },
  '/[orgSlug]/work/forms': { en: 'Intake forms', key: 'RouteTitle.workForms' },
  '/[orgSlug]/work/requests': { en: 'Requests', key: 'RouteTitle.workRequests' },
  '/[orgSlug]/work/requests/[requestId]': { en: 'Request', key: 'RouteTitle.workRequest' },
  '/[orgSlug]/work/requests/[requestId]/triage': {
    en: 'Triage',
    key: 'RouteTitle.workRequestTriage',
  },
  '/[orgSlug]/work/requests/aging': { en: 'Request aging', key: 'RouteTitle.workRequestsAging' },
  '/[orgSlug]/work/saved-views': { en: 'Saved views', key: 'RouteTitle.workSavedViews' },
  '/[orgSlug]/work/timeline': { en: 'Timeline', key: 'RouteTitle.workTimeline' },
  '/[orgSlug]/work/workload': { en: 'Workload', key: 'RouteTitle.workWorkload' },
  // ---- platform-admin v2 · PA-07 ----
  '/platform/organizations': { en: 'Organizations', key: 'PlatformOrgs.routeList' },
  '/platform/organizations/deleted': {
    en: 'Deleted organizations',
    key: 'PlatformOrgs.routeDeleted',
  },
  '/platform/organizations/[organizationId]': {
    en: 'Organization',
    key: 'PlatformOrgs.routeDetail',
  },
  '/platform/organizations/[organizationId]/settings': {
    en: 'Organization settings',
    key: 'PlatformOrgs.routeSettings',
  },
  '/platform/organizations/[organizationId]/plan': {
    en: 'Organization plan',
    key: 'PlatformOrgs.routePlan',
  },
  '/platform/organizations/[organizationId]/members': {
    en: 'Organization members',
    key: 'PlatformOrgs.routeMembers',
  },
  '/platform/organizations/[organizationId]/lifecycle': {
    en: 'Organization lifecycle',
    key: 'PlatformOrgs.routeLifecycle',
  },
  // ---- platform-admin v2 · verifier: pages of PA-02/04/06/08/09/10 ----
  '/[orgSlug]/admin/roles/[roleId]': { en: 'Edit role', key: 'RouteTitle.orgRoleEdit' },
  '/[orgSlug]/finance': { en: 'Finance', key: 'RouteTitle.finance' },
  '/[orgSlug]/finance/expenses': { en: 'Expenses', key: 'RouteTitle.financeExpenses' },
  '/[orgSlug]/finance/invoices': { en: 'Invoices', key: 'RouteTitle.financeInvoices' },
  '/[orgSlug]/finance/invoices/[invoiceId]': { en: 'Invoice', key: 'RouteTitle.financeInvoice' },
  '/[orgSlug]/finance/invoices/[invoiceId]/edit': {
    en: 'Edit invoice',
    key: 'RouteTitle.financeInvoiceEdit',
  },
  '/[orgSlug]/finance/invoices/new': { en: 'New invoice', key: 'RouteTitle.financeInvoiceNew' },
  '/[orgSlug]/finance/period-locks': { en: 'Period locks', key: 'RouteTitle.financePeriodLocks' },
  '/[orgSlug]/finance/profile': { en: 'Finance profile', key: 'RouteTitle.financeProfile' },
  '/[orgSlug]/finance/rates': { en: 'Rate cards', key: 'RouteTitle.financeRates' },
  '/[orgSlug]/finance/reports': { en: 'Finance reports', key: 'RouteTitle.financeReports' },
  '/[orgSlug]/finance/retainers': { en: 'Retainers', key: 'RouteTitle.financeRetainers' },
  '/[orgSlug]/finance/timesheets': { en: 'Timesheets', key: 'RouteTitle.financeTimesheets' },
  '/[orgSlug]/finance/team-time': { en: 'Team time', key: 'RouteTitle.financeTeamTime' },
  '/[orgSlug]/insights/workload': { en: 'Workload', key: 'RouteTitle.insightsWorkload' },
  '/[orgSlug]/people/[membershipId]/permissions': {
    en: 'Member permissions',
    key: 'RouteTitle.orgMemberPermissions',
  },
  '/[orgSlug]/quotes': { en: 'Quotes', key: 'RouteTitle.quotes' },
  '/[orgSlug]/quotes/[quoteId]': { en: 'Quote', key: 'RouteTitle.quote' },
  '/[orgSlug]/quotes/new': { en: 'New quote', key: 'RouteTitle.quoteNew' },
  '/platform/activity': { en: 'Action log', key: 'RouteTitle.platformActivity' },
  '/platform/content': { en: 'Content', key: 'RouteTitle.platformContent' },
  '/platform/activity/access': { en: 'Access log', key: 'RouteTitle.platformActivityAccess' },
  '/platform/activity/ease-scoreboard': { en: 'Ease scoreboard', key: 'EaseScoreboard.title' },
  '/platform/activity/exports': { en: 'Exports', key: 'RouteTitle.platformActivityExports' },
  '/platform/activity/growth': { en: 'Growth', key: 'PlatformGrowth.title' },
  '/platform/activity/platform': {
    en: 'Platform admins activity',
    key: 'RouteTitle.platformActivityAdmins',
  },
  '/platform/activity/support-sessions': {
    en: 'Support sessions',
    key: 'RouteTitle.platformSupportSessions',
  },
  '/platform/organizations/[organizationId]/content': {
    en: 'Organization content',
    key: 'RouteTitle.platformOrgContent',
  },
  '/platform/organizations/[organizationId]/content/[kind]/[itemId]': {
    en: 'Content item',
    key: 'RouteTitle.platformOrgContentItem',
  },
  '/platform/organizations/[organizationId]/content/trash': {
    en: 'Organization trash',
    key: 'RouteTitle.platformOrgTrash',
  },
  '/platform/organizations/[organizationId]/members/[membershipId]/permissions': {
    en: 'Member permissions',
    key: 'RouteTitle.platformOrgMemberPermissions',
  },
  '/platform/organizations/[organizationId]/roles': {
    en: 'Organization roles',
    key: 'RouteTitle.platformOrgRoles',
  },
  '/platform/organizations/[organizationId]/roles/[roleId]': {
    en: 'Edit role',
    key: 'RouteTitle.platformOrgRoleEdit',
  },
  '/platform/people/[userId]': { en: 'Person', key: 'RouteTitle.platformPerson' },
  '/platform/people/[userId]/organizations': {
    en: 'Person organizations',
    key: 'RouteTitle.platformPersonOrganizations',
  },
  '/platform/people/[userId]/security': {
    en: 'Person security',
    key: 'RouteTitle.platformPersonSecurity',
  },
  '/platform/people/[userId]/sign-in-trail': {
    en: 'Sign-in trail',
    key: 'RouteTitle.platformPersonSignInTrail',
  },
  '/platform/settings/announcements': {
    en: 'Announcements',
    key: 'RouteTitle.platformAnnouncements',
  },
  '/platform/settings/flags': { en: 'Feature flags', key: 'RouteTitle.platformFlags' },
  '/platform/settings/keys': { en: 'Keys', key: 'PlatformKeys.title' },
  '/platform/settings/maintenance': { en: 'Maintenance', key: 'RouteTitle.platformMaintenance' },
  '/platform/team': { en: 'Platform team', key: 'RouteTitle.platformTeam' },
  '/platform/team/presets': { en: 'Permission presets', key: 'RouteTitle.platformTeamPresets' },
  // R46 L2 · 56-21
  '/platform/approvals': { en: 'Approvals', key: 'RouteTitle.platformApprovals' },
  '/platform/owner-notices': { en: 'Owner notices', key: 'RouteTitle.platformOwnerNotices' },
  '/platform/team/access-review': {
    en: 'Access review',
    key: 'RouteTitle.platformAccessReview',
  },
  '/': PAGE_OWNS_TITLE,
  // The Arabic public pages set their Arabic titles themselves (`public-locale-routes.ts`).
  '/ar/[[...path]]': PAGE_OWNS_TITLE,
  '/ar/compare': PAGE_OWNS_TITLE,
  '/ar/compare/[slug]': PAGE_OWNS_TITLE,
  '/ar/help': PAGE_OWNS_TITLE,
  '/ar/help/[slug]': PAGE_OWNS_TITLE,
  '/ar/resources/[slug]': PAGE_OWNS_TITLE,
  '/ar/sign-in': PAGE_OWNS_TITLE,
  '/ar/sign-up': PAGE_OWNS_TITLE,
  '/compare': PAGE_OWNS_TITLE,
  '/compare/[slug]': PAGE_OWNS_TITLE,
  '/help/[slug]': PAGE_OWNS_TITLE,
  '/resources/[slug]': PAGE_OWNS_TITLE,
  '/website-kit': PAGE_OWNS_TITLE,
};

function isDynamic(segment: string): boolean {
  return segment.startsWith('[') && segment.endsWith(']');
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/**
 * The table pattern `pathname` belongs to, or `undefined`. As in Next's router a static segment
 * beats a dynamic one at the same depth, so `/features/work` is the website page and never
 * `/[orgSlug]/work`.
 */
export function matchRoutePattern(pathname: string): string | undefined {
  const parts = segmentsOf(pathname.split(/[?#]/)[0] ?? '');
  let best: { pattern: string; rank: string } | undefined;
  for (const pattern of Object.keys(ROUTE_TITLES)) {
    const segments = segmentsOf(pattern);
    if (segments.length !== parts.length) continue;
    let rank = '';
    let matches = true;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] as string;
      if (isDynamic(segment)) {
        rank += '1';
      } else if (segment === parts[index]) {
        rank += '0';
      } else {
        matches = false;
        break;
      }
    }
    if (matches && (best === undefined || rank < best.rank)) best = { pattern, rank };
  }
  return best?.pattern;
}

function rowFor(pattern: string): RouteTitleRow | undefined {
  const entry = ROUTE_TITLES[pattern];
  return entry === undefined || entry === PAGE_OWNS_TITLE ? undefined : entry;
}

/** The English page name for a route's `metadata.title`. Throws for a pattern with no row. */
export function routeTitle(pattern: string): string {
  const row = rowFor(pattern);
  if (row === undefined) throw new Error(`No page name for route ${pattern}`);
  return row.en;
}

/** The page name in `locale`, falling back to English while the catalog lacks the key. */
function nameIn(row: RouteTitleRow, locale: string): string {
  const value = translate(locale, row.key as MessageKey);
  return value === row.key ? row.en : value;
}

/** The route's full tab title in `locale`, or `undefined` when the page sets its own. */
export function localizedRouteTitle(pathname: string, locale: string): string | undefined {
  const pattern = matchRoutePattern(pathname);
  const row = pattern === undefined ? undefined : rowFor(pattern);
  return row === undefined ? undefined : `${nameIn(row, locale)}${TITLE_SUFFIX}`;
}

/** The route's English tab title, the one the server sends, or `undefined`. */
export function englishRouteTitle(pathname: string): string | undefined {
  const pattern = matchRoutePattern(pathname);
  const row = pattern === undefined ? undefined : rowFor(pattern);
  return row === undefined ? undefined : `${row.en}${TITLE_SUFFIX}`;
}
