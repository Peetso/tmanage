#!/usr/bin/env node
/**
 * Contracts check — D10.
 *
 * What this replaces. `package.json` carried `contracts:validate` =
 * `pnpm --filter @tmanage/contracts validate` from the initial commit, and `pnpm verify` ran it
 * as its fourth step. `packages/contracts` was never authored — not removed, never written — so
 * the filter matched no project, pnpm printed `No projects matched the filters` and exited 0.
 * The gate has therefore been vacuous for the whole life of the repository.
 *
 * What this checks instead, and why it is two things rather than one:
 *
 *   1. **Coverage — both directions.** The check is no longer one-directional. It enumerates
 *      response projections on *both* sides and asserts each is paired or explicitly exempt:
 *
 *        (a) API side. Every `export interface …View` under `apps/api/src/modules/**` in a
 *            `*.service.ts`, `*.controller.ts` or `*.repository.ts` file (a view lifted into a
 *            controller or repository counts, not only the service layer) must be asserted
 *            against a web type in `e2e/contracts/api-web-shapes.ts` or listed in EXEMPT.
 *
 *        (b) Web side. Every web *response projection* declared in `apps/web/src/lib/api/**`
 *            must be asserted here (Exact or Narrows) or listed in WEB_EXEMPT with a reason.
 *            This closes the reverse gap: a web shape whose endpoint the API never paired can
 *            no longer hide. A "response projection" is every `export interface`/`export type`
 *            EXCEPT the ones the WEB_EXCLUDE rules below drop — request-side shapes (name ends
 *            `Input|Query|Body|Options`), the `client.ts`/`errors.ts` transport and error
 *            plumbing, and literal `type` aliases (string-literal enums like `InboxMode` and
 *            inline object-literal command unions like `TriageMove`). A `type` alias that is a
 *            union of *named* interfaces (e.g. `SignInResponse`) is kept — it is a real response
 *            shape — and paired or exempted like any other.
 *
 *            `Request` is deliberately NOT a dropped suffix (it was until x79). It is an ordinary
 *            domain noun here — `ClientRequest` and `AcceptedClientRequest` are a client's request
 *            *for work*, response shapes, not HTTP request bodies — so a blanket suffix drop hid
 *            real response projections and, worse, would silently omit any future `*Request`
 *            response with no API pair. Genuine request-side `*Request` shapes are instead named
 *            explicitly in WEB_REQUEST_SHAPES, so excluding one is a reviewed act, not a suffix
 *            accident. (`client.ts`'s `ApiRequest` is already dropped by the file rule above.)
 *
 *      A new response projection on either side therefore cannot appear unpaired and unnoticed —
 *      the failure mode a type-level file alone cannot catch, because a type that nobody wrote
 *      an assertion for compiles perfectly.
 *
 *   2. **Agreement.** `tsc --noEmit -p e2e/tsconfig.json` compiles those assertions. A field
 *      renamed on either side, or retyped from `string` to `number`, fails here.
 *
 * Neither half can succeed silently: (1) fails if the pairing file shrinks on either side, (2)
 * fails if the pairing file stops being true, and both fail loudly if their target is missing.
 *
 * Usage: node scripts/contracts-check.mjs [--json]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const apiModulesDir = join(repoRoot, 'apps/api/src/modules');
const webApiDir = join(repoRoot, 'apps/web/src/lib/api');
const pairingFile = join(repoRoot, 'e2e/contracts/api-web-shapes.ts');
const e2eTsconfig = join(repoRoot, 'e2e/tsconfig.json');
const asJson = process.argv.includes('--json');

/**
 * API views with no counterpart in `apps/web/src/lib/api/**`, each with the reason there is
 * none. An entry here is a claim that the web client does not consume the endpoint at all —
 * not that the shapes were hard to line up. The check fails if an entry names a view that no
 * longer exists, so this list cannot rot into a blanket.
 */
const EXEMPT = new Map([
  [
    'PlanVersionView',
    'No web consumer yet: 57-02 plan ladder is backend only (GET|POST /v1/platform/plan-versions); no platform screen or apps/web client is built.',
  ],
  [
    'WorkspacePlanView',
    'No web consumer yet: 57-02 GET …/billing/plan has no apps/web client; the ladder is off in the beta (PLAN_LADDER).',
  ],
  [
    'OrgCredentialView',
    'No web consumer yet: the owner credential overview (GET …/security/tokens) has no apps/web/src/lib/api client; the admin screen for it is not built.',
  ],
  [
    'ConversationMemberView',
    'No web consumer: membership is never fetched by apps/web; the channel screen reads messages only.',
  ],
  [
    'UploadSessionView',
    'Not mirrored: apps/web/src/lib/api/uploads.ts (New work attachments) reads only id, fileAssetId, partSizeBytes and uploadUrls through an unexported partial type; no screen renders the session.',
  ],
  [
    'FileAssetView',
    'Not mirrored: apps/web/src/lib/api/uploads.ts reads only the completed asset id through an unexported partial type; no screen renders a file asset.',
  ],
  [
    'WorkItemDependencyView',
    'No web consumer: the work-graph endpoints (dependencies) have no screen; WEB work-items.ts wraps list/get/create/update/transition only.',
  ],
  ['WorkBlockerView', 'No web consumer: same as WorkItemDependencyView.'],
  ['WorkItemHealthView', 'No web consumer: health is computed but no screen reads it yet.'],
  [
    'ProjectHealthView',
    'No web consumer: UNIT-12 project health roll-up is authored ready for the screen; no screen reads it yet (x86 follow-up).',
  ],
  [
    'ApprovalDecisionView',
    'No web consumer: the internal reviewer decide record. x101 ships only the client decide (its response is the separate client-safe ClientDecideView, paired); the internal reviewer decide screen is unbuilt, so this pairs when it lands.',
  ],
  [
    'PortalSettingsClientView',
    'No web consumer: SEC / Client portal settings (x238) client projection (welcome/accent/toggles only, no updatedBy). The internal PortalSettingsView is the paired one (PortalSettingsScreen); the client-portal render that reads this projection is a later slice. Pair it when that render lands.',
  ],
  [
    'GrantView',
    'Not a wire shape: the oauth-tokens repository row (revokedAt is a Date) read only inside the token and revoke paths; no route serialises it. The Connected apps response is ConnectedAppsView, paired.',
  ],
  // Wave 2026-10-22 backend lanes: API-only until their screens land after Figma approval.
  [
    'PortalMeetingView',
    'No web consumer yet: BK5 portal meetings list is API-only; the portal meetings screen is a follow-up.',
  ],
  [
    'PortalMeetingAttendeeView',
    'No web consumer yet: BK5 portal meeting detail is API-only; the portal meetings screen is a follow-up.',
  ],
  [
    'PortalMeetingDetailView',
    'No web consumer yet: BK5 portal meeting detail is API-only; the portal meetings screen is a follow-up.',
  ],
  // R4 closing (2026-11-01): API views from earlier waves with no web screen yet.
  [
    'EmailDeliverabilityView',
    'No web consumer yet: the platform email-deliverability read (`GET v1/platform/email-deliverability`) has no Control Center screen; it pairs when that screen lands.',
  ],
  [
    'MailHealthView',
    'No web consumer yet: the platform mail-health read and lane pause (`v1/platform/mail`) have no Control Center screen; it pairs when that screen lands.',
  ],
  [
    'TaxRateView',
    'No web consumer yet: finance tax rates are API-only; the finance settings screen is a follow-up.',
  ],
  [
    'ExchangeRateView',
    'No web consumer yet: finance exchange rates are API-only; the finance settings screen is a follow-up.',
  ],
  [
    'CapacityReadingView',
    'No web consumer yet: the platform capacity reading (`GET v1/platform/health/capacity`) has no Control Center tile yet; covered by CapacityView when it pairs.',
  ],
  [
    'CapacityView',
    'No web consumer yet: the platform capacity read (`GET v1/platform/health/capacity`) has no Control Center tile yet.',
  ],
  [
    'ProductEventsIngestView',
    'The web event queue (lib/api/product-events.ts) posts batches and ignores the acknowledgement body, so there is no web shape to pair.',
  ],
  [
    'BlockRuleView',
    'No web consumer yet: admin block rules (`admin/block-rules`) are API-only; the abuse-rules screen is a follow-up.',
  ],
  [
    'SubmissionView',
    'No web consumer yet: the work-form submissions list and spam mark are API-only; the submissions screen is a follow-up.',
  ],
  [
    'PublicLinkView',
    'No web consumer yet: public links for deliverables (`public-links`) are API-only; the share-link screen is a follow-up.',
  ],
  [
    'QuoteView',
    'No web consumer yet: quotes (`v1/organizations/:orgSlug/quotes`) are API-only; the quotes screen is a follow-up.',
  ],
  [
    'AlertRuleView',
    'No web consumer yet: platform alert rules (`v1/platform/alerts`) are API-only; the alert-rules screen is a follow-up.',
  ],
  [
    'ActiveTimerView',
    'No web consumer yet: active timers for presence are API-only; the timer control in the web is a follow-up.',
  ],
]);

/**
 * Web response projections in `apps/web/src/lib/api/**` with no counterpart assertion yet, each
 * with the reason there is none. Same contract as EXEMPT: an entry is a claim that the shape
 * cannot be paired right now, not that lining it up was fiddly, and the check fails if an entry
 * names a shape that no longer exists — so this list cannot rot into a blanket either.
 *
 * The class-3/class-4 shapes (NEXT-SCOPES §Scope B): their API response is an inline object
 * literal that slice x78 lifts into a named `*View`, at which point each moves from here to a
 * pair; `SignInResponse` is a union alias of two arms that pair individually, not a single
 * projection to `Assert`.
 *
 * The class-1-lift shapes carry a *different* reason: a named API interface for each already
 * exists in a controller but is not `export`ed (`MemberView`, `WorkspaceView`, `EstablishedBody`,
 * `ChallengeResponseBody`), so it cannot be imported and paired until that source `export` lands
 * (NEXT-SCOPES §Scope B "class (1-lift)", x69-report §Deferred). This gate now *sees* them —
 * broadening the API enumeration to controllers means the pair can be added the moment the
 * `export` does — but authoring that source `export` is out of this test-only slice, so they are
 * exempted with a truthful, self-expiring reason rather than left to fail the gate.
 */
const WEB_EXEMPT = new Map([
  // Wave 8 H6: the per-screen error wording in describe-error.ts. It is web-only display config
  // (catalog keys + English fallbacks), never a response body, so it has no API pair.
  [
    'ApiErrorLines',
    'web-only error wording (catalog keys) in describe-error.ts, not a response body; no API counterpart exists.',
  ],
  // C5: the direct-conversation list wrapper. The API returns it as an inline type on
  // DirectConversationsController.list (no named …View to import); its rows are paired Exact as
  // DirectConversationView / DirectConversationSummary, and viewerUserId is the caller's own id.
  [
    'DirectConversationsOverview',
    'inline API return type of direct-conversations.controller.ts list(); its rows DirectConversationView and DirectConversationSummary are paired Exact.',
  ],
  // A5 (BK5): the attendee list wrapper. The API returns it as an inline type on
  // MeetingAttendeesController.list (no named …View to import); both arms, MeetingAttendeeView and
  // MeetingClientAttendeeView, are paired Exact, so the wrapper adds no unchecked field.
  [
    'MeetingAttendeeList',
    'inline API return type of meeting-attendees.controller.ts list(); its arms MeetingAttendeeView and MeetingClientAttendeeView are paired Exact.',
  ],
  // Wave 4 (Q2 New project client picker): the API side is ClientOrganizationOption in
  // apps/api/src/modules/clients/clients.service.ts — not a …View name, so the checker cannot pair it.
  [
    'ClientOrganizationOption',
    'paired by hand with apps/api/src/modules/clients/clients.service.ts ClientOrganizationOption {id, name} (not a …View).',
  ],
  // Design-gaps pass (2026-10-18): the CH-01 channel browser. The API side is the pure projection in
  // apps/api/src/modules/conversations/channel-directory.ts (same names, not a …View in a *.service.ts),
  // so the checker cannot pair it; the shapes are built field-for-field from that file.
  [
    'ChannelMemberPreview',
    'paired by hand with apps/api/src/modules/conversations/channel-directory.ts ChannelMemberPreview (not a *.service.ts …View).',
  ],
  [
    'ChannelDirectoryEntry',
    'paired by hand with apps/api/src/modules/conversations/channel-directory.ts ChannelDirectoryEntry (not a *.service.ts …View).',
  ],
  // class-4 — union alias of AuthenticatedResponse | MfaRequiredResponse; the arms pair
  // individually (class-1-lift), so the union itself is never a single projection to Assert.
  [
    'SignInResponse',
    'union alias of AuthenticatedResponse | MfaRequiredResponse — not a single response projection; the two arms pair individually.',
  ],
  [
    'InboxItem',
    'union alias of InboxBundle | InboxUsageNotice — not a single response projection; the two arms pair individually.',
  ],
  [
    'InboxSnooze',
    'x259 — the single snooze item. The API inlines it inside `InboxSnoozeView` (there is no standalone API item type), and that wrapper is paired Exact, so the item shape is covered there.',
  ],
  [
    'InboxSourceMute',
    'x318 — the single muted-source item. The API inlines it inside `InboxSourceMutesView` (there is no standalone API item type), and that wrapper is paired Exact, so the item shape is covered there.',
  ],
  [
    'WebhookDeliveryPage',
    'x221 — the keyset page wrapper (deliveries + nextCursor). The API returns the page inline with no named page view; its element `WebhookDeliveryView` is paired Exact.',
  ],
  [
    'HomeQuickLink',
    'x273 — the single quick link. The API names its element `HomeQuickLinkItem` (not a standalone …View), and the wrapper `HomeQuickLinksView` is paired Exact, so the item shape is covered there.',
  ],
  [
    'NewInboxRule',
    'x301 — the request body POST accepts to add an inbox rule (name ends in `Rule`, not a dropped request suffix); a request shape, not a response projection. The response rule `InboxRuleView` is paired Exact.',
  ],
  [
    'NewMeetingTimePollOption',
    'x298 — a candidate slot the organiser proposes in the create-poll request body; a request shape, not a response projection. The response slot `MeetingTimePollOptionView` is paired Exact.',
  ],
  [
    'MeetingTimePollTally',
    'x298 — the per-answer tally. The API inlines it inside `MeetingTimePollOptionView` (there is no standalone …View), and that slot is paired Exact, so the tally shape is covered there.',
  ],
  [
    'ResolvedCategory',
    'x301 — the resolve-endpoint response for one notification. The API names it `ResolvedCategory` (not a …View), so it is not an enumerated API response projection to assert; the two shapes are hand-kept identical, and its `InboxRuleView` sibling is paired Exact.',
  ],
  [
    'ProjectBaselineVarianceRow',
    'x295 — one variance row. It is the element of `ProjectBaselineVariance`, which is paired Exact, so the row shape is covered transitively (the API names it `ProjectBaselineVarianceRow`, not a …View).',
  ],
  [
    'SecurityAlertConfig',
    'x329 — one alert-source config. The API names it `SecurityAlertConfig` (not a …View), so it is not an enumerated API projection to assert; it is an element of `SecurityAlertsView`, which is paired Exact, so the shape is covered transitively.',
  ],
  [
    'SecurityAlertMatch',
    'x329 — one matched audit event. The API names it `SecurityAlertMatch` (not a …View), so it is not an enumerated API projection to assert; it is an element of `SecurityAlertsView`, which is paired Exact, so the shape is covered transitively.',
  ],
  [
    'ApplyAgendaTemplateResult',
    'x314 — the apply outcome (meeting/template ids + seeded/skipped counts). The API names it `ApplyAgendaTemplateResult` (not a …View), so it is not an enumerated API projection to assert; the two shapes are hand-kept identical, and its `AgendaTemplateView` sibling is paired Exact.',
  ],
  [
    'MeetingAgendaTemplateItem',
    'x314 — one template item (title + position). It is the element of `AgendaTemplateView`, which is paired Exact, so the item shape is covered transitively (the API sources it from schema, not a standalone …View).',
  ],
  [
    'ProjectDependencyGraph',
    'x309 — the dependencies graph wrapper. The API names it `ProjectDependencyGraph` (not a …View), so it is not an enumerated API projection to assert; its element `ProjectDependency` is paired Exact, so the shape is covered transitively.',
  ],
  [
    'DefineApprovalStep',
    'x315 — the request body a caller submits to define a step (name ends in `Step`, not a dropped request suffix); a request shape, not a response projection. The response step `ApprovalStepView` is paired Exact.',
  ],
  [
    'PersonTimeOffRange',
    'x325 — the optional from/to filter passed as query params on the list read (name ends in `Range`, not a dropped request suffix); a request shape, not a response projection. The response `PersonTimeOffView` is paired Exact.',
  ],
  [
    'ConsentClient',
    'MCP S9 — the consent client element. The API names it `ConsentClientView` in consent.ts (not a *.service/controller/repository file), and the wrapper `ConsentView` is paired Exact, so the shape is covered there.',
  ],
  [
    'AiApprovalSummary',
    'MCP S10 — the server-built summary. The API names it `ApprovalSummary` (not a …View), and the wrapper `AiApprovalView` is paired Exact with `PendingAiActionView`, so the shape is covered there.',
  ],
  [
    'AiApprovalField',
    'MCP S10 — one summary field, the element of `AiApprovalSummary`; covered transitively by the paired `AiApprovalView`.',
  ],
  // class-1-lift (MemberSummary, WorkspaceSummary, AuthenticatedResponse, MfaRequiredResponse)
  // was exempted here while its API interface was unexported. x79 exported each interface
  // (members.controller `MemberView`, workspaces.controller `WorkspaceView`, authentication.controller
  // `EstablishedView`/`ChallengeResponseView`) and paired all four Exact in the pairing file, so the
  // entries were retired — the shapes are now paired, not exempt.
  // R4 closing (2026-11-01): web shapes from earlier waves that are not response bodies, or whose API twin has no `…View` name.
  [
    'DisplayTimezone',
    'A `string` alias (any IANA zone) used as a field of DisplayPreferencesView, which is paired Exact; not a response body of its own.',
  ],
  [
    'WeekMeasures',
    'Computed in the browser from the ease scoreboard rows (pure functions in ease-scoreboard.ts); not a response body, so no API pair.',
  ],
  [
    'FunnelStep',
    'Computed in the browser from the ease scoreboard rows (pure functions in ease-scoreboard.ts); not a response body, so no API pair.',
  ],
  [
    'ProductEventQueue',
    'The browser-side batching object (emit/flush) in product-events.ts; not a response body, so no API pair.',
  ],
  [
    'ScoreboardCountRowView',
    'The API names it `ScoreboardCountRow` (repository row, no `…View` suffix); compiled Exact in the pairing file and covered by the paired EaseScoreboardView.',
  ],
  [
    'ScoreboardTimerRowView',
    'The API names it `ScoreboardTimerRow` (repository row, no `…View` suffix); compiled Exact in the pairing file and covered by the paired EaseScoreboardView.',
  ],
  [
    'PublicFormField',
    'The API names it `PublicFormField` in public-forms.validate.ts (no `…View` suffix); compiled Exact in the pairing file through a named pair.',
  ],
  [
    'PublicFormDefinition',
    'The API names it `PublicFormDefinition` in public-forms.validate.ts (no `…View` suffix); compiled Exact in the pairing file through a named pair.',
  ],
  [
    'SignalFilters',
    'FLAKES 2026-11-15 — the list filters signalQuery() turns into query params on the signals read; a request shape, not a response. The response page `SecuritySignalPage` is paired Exact.',
  ],
  [
    'SignInClientSignals',
    'FLAKES 2026-11-15 — the optional device facts the browser sends inside the sign-in request body; a request shape, not a response.',
  ],
  [
    'CoachMarksPatch',
    'FLAKES 2026-11-15 — the PATCH body for the coach-marks read state; a request shape, not a response. The response `CoachMarksView` is paired Exact.',
  ],
  [
    'DocumentCommentAnchor',
    'FLAKES 2026-11-15 — the optional text anchor addDocumentComment() sends in the request body; a request shape. The response carries it as anchorId/anchorQuote on the paired comment.',
  ],
  [
    'NewExpense',
    'FLAKES 2026-11-15 — the POST body for a new expense; a request shape, not a response. The response `Expense` is paired (Narrows) with `ExpenseView`.',
  ],
  [
    'AuditChainBreak',
    'FLAKES 2026-11-15 — the first-break element of `AuditIntegrityReport`, which is paired (Narrows) with the API report, so the element shape is covered there.',
  ],
  [
    'ChatLastMessage',
    'FLAKES 2026-11-15 — the last-message element of `ChatListRowData`, which is paired Exact with `ChatListRowView`, so the element shape is covered there.',
  ],
  [
    'ChatListResult',
    'FLAKES 2026-11-15 — inline API return type of chat-list.controller.ts list() ({ rows, viewerUserId }); its rows `ChatListRowData` are paired Exact with `ChatListRowView`.',
  ],
  [
    'ContactErrorRecord',
    'FLAKES 2026-11-15 — the error element of `ContactImportResult`, which is paired (Narrows) with `ContactImportView`, so the element shape is covered there.',
  ],
  [
    'BurndownPoint',
    'FLAKES 2026-11-15 — the point element of `Burndown`, which is paired Exact with `BurndownView`, so the element shape is covered there.',
  ],
  [
    'PlatformAccessReviewRow',
    'FLAKES 2026-11-15 — the admin row element of `PlatformAccessReviewView`, which is paired (Narrows) with the API `AccessReviewView`, so the element shape is covered there.',
  ],
  [
    'WorkItemRecurrenceOccurrence',
    'FLAKES 2026-11-15 — the occurrence element of `WorkItemRecurrence` and `RecurrencePreview`, both paired Exact, so the element shape is covered there.',
  ],
  [
    'BurnUpBar',
    'FLAKES 2026-11-15 — computed in the browser by burnUpBars() from the burndown points; not a response body, so no API pair.',
  ],
  [
    'ReplyMeta',
    'FLAKES 2026-11-15 — decoded in the browser by replyMetaOf() from a message `meta` JSON object; the API types `meta` as an open record, so there is no named API shape to pair.',
  ],
  [
    'GroupSystemMeta',
    'FLAKES 2026-11-15 — the decoded `meta` JSON of a system message; the API types `meta` as an open record, so there is no named API shape to pair.',
  ],
  [
    'PublicFormState',
    'The API names it `PublicFormState` in public-forms.service.ts (no `…View` suffix); compiled Exact in the pairing file through a named pair.',
  ],
  // 57-10 support screens. The member list wrapper is inline on SupportController.list; its rows
  // (SupportThread) and its policy (SupportPolicy) are paired Exact in the pairing file.
  [
    'SupportOverview',
    '57-10 — inline `{ threads, policy }` wrapper on SupportController.list (no named …View); both members are paired Exact.',
  ],
  [
    'PlatformSupportFilter',
    '57-10 — the inbox query filter the web turns into ?breached=&priority=; a request shape, never a response body.',
  ],
  [
    'SupportTargets',
    '57-10 — the API returns publishedTargets() from support-sla.ts as an unnamed object (no …View to import) on the public support-targets route.',
  ],
]);

// ── 1. Enumerate the API's response projections ─────────────────────────────

/**
 * API response projections live in the service layer, but x71 lifted several into the controller
 * that serialises them, and repository projections are wire shapes too — so a view under any of
 * these three file kinds counts, not only `*.service.ts`.
 */
function apiSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    if (!/\.(service|controller|repository)\.ts$/.test(entry.name)) continue;
    out.push(join(entry.parentPath ?? entry.path, entry.name));
  }
  return out.sort();
}

if (!existsSync(apiModulesDir)) {
  console.error(`contracts-check: ${relative(repoRoot, apiModulesDir)} does not exist.`);
  process.exit(1);
}

const VIEW_RE = /^export interface ([A-Za-z0-9_]*View)\b/gm;
/** @type {Map<string, string>} view name → `path:line` */
const apiViews = new Map();
for (const file of apiSourceFiles(apiModulesDir)) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(VIEW_RE)) {
    const line = text.slice(0, m.index).split('\n').length;
    apiViews.set(m[1], `${relative(repoRoot, file).split(sep).join('/')}:${line}`);
  }
}

// ── 1b. Enumerate the web client's response projections ─────────────────────

/**
 * A web `export interface`/`export type` is a *response projection* unless one of these drops it:
 *   - it lives in `client.ts` or `errors.ts` — request/response transport and error plumbing,
 *     not an endpoint's response body;
 *   - its name ends in a request-side suffix (`Input|Query|Body|Options`);
 *   - its name is listed in WEB_REQUEST_SHAPES — a request-side shape whose name ends in `Request`
 *     but which is genuinely a fetch body/params type, named here explicitly rather than dropped
 *     by suffix (see below);
 *   - it is a literal `type` alias — a string-literal enum (`type InboxMode = 'all' | …`) or an
 *     inline object-literal command union (`type TriageMove = { to: 'triage' } | …`). A `type`
 *     alias that unions *named* interfaces (e.g. `SignInResponse`) is a real response shape and
 *     is kept.
 * The rule is deliberately about shape, not a hand-maintained allow-list, so a new web response
 * type is caught by default and a new request type is ignored by default.
 *
 * `Request` is NOT a dropped suffix (it was until x79 — review-x77 Important-2). Two *response*
 * shapes are domain nouns that end in it — `ClientRequest` (portal.ts) and `AcceptedClientRequest`
 * (client-requests.ts), a client's request *for work*, not an HTTP request body — and the old
 * suffix drop hid them from the web enumeration, and would silently hide any future `*Request`
 * response noun with no API pair. Both are enumerated now and paired (their web side appears in
 * the pairing file). A genuine request-side `*Request` type is excluded only by being named in
 * WEB_REQUEST_SHAPES below, which makes each such exclusion a reviewed decision. The set is empty
 * today: the one `*Request` request type, `client.ts`'s `ApiRequest`, is already dropped by the
 * file rule, so nothing else needs naming.
 */
const WEB_EXCLUDE_FILES = new Set(['client.ts', 'errors.ts']);
const WEB_REQUEST_SUFFIX = /(?:Input|Query|Body|Options)$/;
/** Request-side shapes whose name ends in `Request` but are fetch body/params types, not responses. */
const WEB_REQUEST_SHAPES = new Set([]);

function webApiFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    if (WEB_EXCLUDE_FILES.has(entry.name)) continue;
    out.push(join(entry.parentPath ?? entry.path, entry.name));
  }
  return out.sort();
}

/** True for a `type` alias RHS that is a single named type or a union of *named* types only. */
function isNamedTypeUnion(rhs) {
  const members = rhs
    .replace(/^\s*\|/, '')
    .split('|')
    .map((s) => s.trim());
  return members.every((member) => /^[A-Za-z_][A-Za-z0-9_.]*(?:<[^>]*>)?(?:\[\])?$/.test(member));
}

const WEB_INTERFACE_RE = /^export interface ([A-Za-z0-9_]+)\b/gm;
const WEB_TYPE_RE = /^export type ([A-Za-z0-9_]+)\s*=\s*([\s\S]*?);/gm;
/** @type {Map<string, string>} web shape name → `path:line` */
const webShapes = new Map();

if (existsSync(webApiDir)) {
  for (const file of webApiFiles(webApiDir)) {
    const text = readFileSync(file, 'utf8');
    const at = (index) =>
      `${relative(repoRoot, file).split(sep).join('/')}:${text.slice(0, index).split('\n').length}`;
    for (const m of text.matchAll(WEB_INTERFACE_RE)) {
      if (WEB_REQUEST_SUFFIX.test(m[1]) || WEB_REQUEST_SHAPES.has(m[1])) continue;
      webShapes.set(m[1], at(m.index));
    }
    for (const m of text.matchAll(WEB_TYPE_RE)) {
      if (WEB_REQUEST_SUFFIX.test(m[1]) || WEB_REQUEST_SHAPES.has(m[1])) continue;
      if (!isNamedTypeUnion(m[2])) continue; // string-literal enum or object-literal command union
      webShapes.set(m[1], at(m.index));
    }
  }
}

// ── 2. Read the pairing file's assertions ───────────────────────────────────

if (!existsSync(pairingFile)) {
  console.error(
    `contracts-check: ${relative(repoRoot, pairingFile)} is missing. This is the check; without it nothing compares the API to the web client.`,
  );
  process.exit(1);
}
const pairingText = readFileSync(pairingFile, 'utf8');

// Aliases: `import type { WorkItemView as ApiWorkItemView } from '../../apps/api/…'`.
// Resolved rather than assumed, so a pair cannot be claimed by naming a type the file never
// imported from apps/api.
/** @type {Map<string, string>} local alias → exported name in apps/api */
const aliasToView = new Map();
/** @type {Map<string, string>} local alias → exported name in apps/web (the web side of a pair) */
const webAliasToShape = new Map();
/** @type {Map<string, string>} exported apps/api name → the source file the pairing imports it from */
const apiTypeSource = new Map();
const IMPORT_RE = /import type \{([^}]*)\} from '([^']*)'/g;
for (const m of pairingText.matchAll(IMPORT_RE)) {
  const target = m[2].includes('apps/api/')
    ? aliasToView
    : m[2].includes('apps/web/')
      ? webAliasToShape
      : null;
  if (!target) continue;
  for (const clause of m[1].split(',')) {
    const parts = clause.trim().split(/\s+as\s+/);
    if (parts.length === 2) target.set(parts[1], parts[0]);
    else if (parts[0]) target.set(parts[0], parts[0]);
    if (target === aliasToView && parts[0])
      apiTypeSource.set(parts[0], join(dirname(pairingFile), m[2].replace(/\.js$/, '.ts')));
  }
}

/**
 * True when `name` is still exported by the apps/api file the pairing imports it from — declared
 * there (`export interface` / `export type`) or re-exported (`export type { … }`).
 */
function apiTypeStillExported(name) {
  const source = apiTypeSource.get(name);
  if (!source || !existsSync(source)) return false;
  const text = readFileSync(source, 'utf8');
  return (
    new RegExp(String.raw`^export (?:interface|type) ${name}\b`, 'm').test(text) ||
    new RegExp(String.raw`^export type \{[^}]*\b${name}\b`, 'm').test(text)
  );
}

const ASSERT_RE = /Assert<\s*(Exact|Narrows)\s*<\s*([A-Za-z0-9_]+)\s*,\s*([A-Za-z0-9_]+)\s*>\s*>/g;
/** @type {{ kind: string, api: string, web: string }[]} */
const pairs = [];
for (const m of pairingText.matchAll(ASSERT_RE)) {
  const api = aliasToView.get(m[2]);
  if (api) pairs.push({ kind: m[1], api, web: m[3] });
}
const pairedViews = new Set(pairs.map((p) => p.api));
/** Web shapes named on the web side of a pair, resolved through the aliases above. */
const pairedWebShapes = new Set(
  pairs.map((p) => webAliasToShape.get(p.web)).filter((name) => name !== undefined),
);

// ── 3. Coverage ─────────────────────────────────────────────────────────────

const problems = [];

for (const [view, where] of apiViews) {
  if (pairedViews.has(view)) continue;
  if (EXEMPT.has(view)) continue;
  problems.push(
    `${where}: \`${view}\` is an API response projection with no counterpart assertion in e2e/contracts/api-web-shapes.ts and no entry in EXEMPT. Pair it with the apps/web type that declares the same response, or add it to EXEMPT with the reason there is no web consumer.`,
  );
}

for (const [view, reason] of EXEMPT) {
  if (apiViews.has(view)) {
    if (!reason || reason.length < 20)
      problems.push(`EXEMPT["${view}"] has no usable reason. Say why there is no web consumer.`);
    continue;
  }
  problems.push(
    `EXEMPT["${view}"] names a view that no longer exists in apps/api. Delete the entry — a stale exemption is how this list turns back into a blanket.`,
  );
}

// A pair may name an apps/api type that is not an enumerated …View — an element type, a `*.ts`
// helper's projection, a union alias of two views. It still compiles here and still covers its web
// shape; it is stale only if the API stopped exporting the name it claims.
for (const pair of pairs) {
  if (!apiViews.has(pair.api) && !apiTypeStillExported(pair.api))
    problems.push(
      `e2e/contracts/api-web-shapes.ts asserts against \`${pair.api}\`, which is no longer exported by the apps/api file it is imported from.`,
    );
}

if (pairs.length === 0)
  problems.push(
    'e2e/contracts/api-web-shapes.ts contains no Assert<Exact<…>> / Assert<Narrows<…>> assertions. An empty pairing file is the same vacuous gate this check replaced.',
  );

// ── 3b. Coverage — the web side ──────────────────────────────────────────────

for (const [shape, where] of webShapes) {
  if (pairedWebShapes.has(shape)) continue;
  if (WEB_EXEMPT.has(shape)) continue;
  problems.push(
    `${where}: \`${shape}\` is a web response shape in apps/web/src/lib/api/** with no counterpart assertion in e2e/contracts/api-web-shapes.ts and no entry in WEB_EXEMPT. Pair it with the apps/api view that produces the same response, or add it to WEB_EXEMPT with the reason it has no pair yet.`,
  );
}

for (const [shape, reason] of WEB_EXEMPT) {
  if (webShapes.has(shape)) {
    if (!reason || reason.length < 20)
      problems.push(`WEB_EXEMPT["${shape}"] has no usable reason. Say why the shape has no pair.`);
    continue;
  }
  problems.push(
    `WEB_EXEMPT["${shape}"] names a shape that is no longer an enumerated web response projection in apps/web/src/lib/api/**. Delete the entry — a stale exemption is how this list turns back into a blanket.`,
  );
}

// ── 4. Agreement — compile the assertions ───────────────────────────────────

let tscOutput = '';
let tscOk = true;
if (!existsSync(e2eTsconfig)) {
  tscOk = false;
  tscOutput = `contracts-check: ${relative(repoRoot, e2eTsconfig)} is missing; the assertions cannot be compiled.`;
} else {
  const tsc = spawnSync(
    process.execPath,
    [join(repoRoot, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', e2eTsconfig],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  tscOutput = `${tsc.stdout ?? ''}${tsc.stderr ?? ''}`.trim();
  tscOk = tsc.status === 0;
}

// ── 5. Report ───────────────────────────────────────────────────────────────

const webPairedCount = [...webShapes.keys()].filter((s) => pairedWebShapes.has(s)).length;
const webExemptCount = [...webShapes.keys()].filter((s) => WEB_EXEMPT.has(s)).length;

const summary = {
  apiViews: apiViews.size,
  paired: pairedViews.size,
  exact: pairs.filter((p) => p.kind === 'Exact').length,
  narrows: pairs.filter((p) => p.kind === 'Narrows').length,
  exempt: EXEMPT.size,
  webShapes: webShapes.size,
  webPaired: webPairedCount,
  webExempt: webExemptCount,
  coverageProblems: problems,
  assignabilityOk: tscOk,
};

if (asJson) {
  console.log(JSON.stringify({ ...summary, tscOutput }, null, 2));
} else {
  console.log(
    `contracts-check: ${apiViews.size} API response views — ${pairedViews.size} paired (${summary.exact} exact, ${summary.narrows} narrowing), ${EXEMPT.size} exempt with a stated reason.`,
  );
  console.log(
    `contracts-check: ${webShapes.size} web response shapes — ${webPairedCount} paired, ${webExemptCount} exempt`,
  );
  if (problems.length) {
    console.error('\ncontracts-check FAILED — coverage:\n');
    for (const p of problems) console.error(`  - ${p}`);
  }
  if (!tscOk) {
    console.error(
      '\ncontracts-check FAILED — the API and the web client disagree about a response shape:\n',
    );
    console.error(tscOutput || '(tsc produced no output but exited non-zero)');
    console.error(
      '\nThe pairing lives in e2e/contracts/api-web-shapes.ts. Fix whichever side is wrong;\ndo not widen a type to make this pass.',
    );
  }
  if (!problems.length && tscOk) console.log('contracts-check: OK.');
}

process.exit(problems.length === 0 && tscOk ? 0 : 1);
