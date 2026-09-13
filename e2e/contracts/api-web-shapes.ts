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
import type { ClientRequestClientView as ApiClientRequestClientView } from '../../apps/api/src/modules/requests/client-requests.service.js';
import type { ClientRequestView as ApiClientRequestView } from '../../apps/api/src/modules/requests/client-requests.service.js';
import type { ConversationView as ApiConversationView } from '../../apps/api/src/modules/conversations/conversations.service.js';
import type { InboxBundleView as ApiInboxBundleView } from '../../apps/api/src/modules/inbox/inbox.service.js';
import type { InboxPageView as ApiInboxPageView } from '../../apps/api/src/modules/inbox/inbox.service.js';
import type { InvitationView as ApiInvitationView } from '../../apps/api/src/modules/tenancy/invitations.service.js';
import type { MessageRevisionView as ApiMessageRevisionView } from '../../apps/api/src/modules/conversations/conversations.service.js';
import type { MessageView as ApiMessageView } from '../../apps/api/src/modules/conversations/conversations.service.js';
import type { PortalInboxBundleView as ApiPortalInboxBundleView } from '../../apps/api/src/modules/inbox/portal-inbox.service.js';
import type { PortalInboxPageView as ApiPortalInboxPageView } from '../../apps/api/src/modules/inbox/portal-inbox.service.js';
import type { PortalProjectView as ApiPortalProjectView } from '../../apps/api/src/modules/clients/portal.service.js';
import type { PortalWorkItemView as ApiPortalWorkItemView } from '../../apps/api/src/modules/clients/portal.service.js';
import type { ProjectClientView as ApiProjectClientView } from '../../apps/api/src/modules/clients/clients.service.js';
import type { ProjectView as ApiProjectView } from '../../apps/api/src/modules/projects/projects.service.js';
import type { WorkItemView as ApiWorkItemView } from '../../apps/api/src/modules/work/work-items.service.js';

// ── The shapes `apps/web` declares for them ─────────────────────────────────
import type { ClientRequestRecord as WebClientRequestRecord } from '../../apps/web/src/lib/api/client-requests';
import type { ProjectShare as WebProjectShare } from '../../apps/web/src/lib/api/clients';
import type {
  ConversationSummary as WebConversationSummary,
  MessageRevisionSummary as WebMessageRevisionSummary,
  MessageSummary as WebMessageSummary,
} from '../../apps/web/src/lib/api/conversations';
import type {
  InboxBundle as WebInboxBundle,
  InboxPage as WebInboxPage,
} from '../../apps/web/src/lib/api/inbox';
import type { InvitationSummary as WebInvitationSummary } from '../../apps/web/src/lib/api/invitations';
import type {
  ClientRequest as WebClientRequest,
  PortalInboxBundle as WebPortalInboxBundle,
  PortalInboxPage as WebPortalInboxPage,
  PortalProject as WebPortalProject,
  PortalWorkItem as WebPortalWorkItem,
} from '../../apps/web/src/lib/api/portal';
import type { ProjectSummary as WebProjectSummary } from '../../apps/web/src/lib/api/projects';
import type { WorkItemSummary as WebWorkItemSummary } from '../../apps/web/src/lib/api/work-items';

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

type SameKeys<Api, Web> = [keyof Api] extends [keyof Web]
  ? [keyof Web] extends [keyof Api]
    ? true
    : ApiWebMismatch<Api, Web>
  : ApiWebMismatch<Api, Web>;

/**
 * One-way assignability plus key equality — the weaker assertion, used only where the web type
 * is deliberately *narrower* than the API's and the difference is recorded below with a reason.
 *
 * It is weaker in exactly one direction and no further: a renamed field still fails (`SameKeys`),
 * a `string` that became a `number` still fails (`[Web] extends [Api]`), a removed field still
 * fails. What it tolerates is the API declaring `string` where the web declares the union the
 * database actually constrains — never the reverse, and never a different field.
 */
type Narrows<Api, Web> = [Web] extends [Api] ? SameKeys<Api, Web> : ApiWebMismatch<Api, Web>;

/** `never extends true` is vacuously satisfied, so a failing check must resolve to an object. */
type Assert<T extends true> = T;

// Exact pairs — the API projection and the web declaration are the same type.
type _conversation = Assert<Exact<ApiConversationView, WebConversationSummary>>;
type _message = Assert<Exact<ApiMessageView, WebMessageSummary>>;
type _messageRevision = Assert<Exact<ApiMessageRevisionView, WebMessageRevisionSummary>>;
type _inboxBundle = Assert<Exact<ApiInboxBundleView, WebInboxBundle>>;
type _inboxPage = Assert<Exact<ApiInboxPageView, WebInboxPage>>;
type _portalInboxBundle = Assert<Exact<ApiPortalInboxBundleView, WebPortalInboxBundle>>;
type _portalInboxPage = Assert<Exact<ApiPortalInboxPageView, WebPortalInboxPage>>;
type _portalProject = Assert<Exact<ApiPortalProjectView, WebPortalProject>>;
type _portalWorkItem = Assert<Exact<ApiPortalWorkItemView, WebPortalWorkItem>>;
type _projectClient = Assert<Exact<ApiProjectClientView, WebProjectShare>>;
type _project = Assert<Exact<ApiProjectView, WebProjectSummary>>;
type _clientRequestClient = Assert<Exact<ApiClientRequestClientView, WebClientRequest>>;

// Narrowing pairs — three, each a real divergence, each open rather than papered over.
//
// In all three the API projection types a lifecycle column as `string` while the web declares
// the union the column is actually constrained to. The web side is the more truthful of the
// two and is *not* being widened to make this file compile; the API side is what wants
// tightening, and tightening it is an `apps/api` change with its own test surface, not this
// slice's. Recorded in the report and in `docs/implementation-status.md` as open.

/** `WorkItemView.state: string` vs `WORK_ITEM_STATES` (`@tmanage/domain`). */
type _workItem = Assert<Narrows<ApiWorkItemView, WebWorkItemSummary>>;

/** `ClientRequestView.state: string` vs the nine states of `23-ERD` §6. */
type _clientRequest = Assert<Narrows<ApiClientRequestView, WebClientRequestRecord>>;

/** `InvitationView.status: string` vs `pending | accepted | expired | revoked`. */
type _invitation = Assert<Narrows<ApiInvitationView, WebInvitationSummary>>;
