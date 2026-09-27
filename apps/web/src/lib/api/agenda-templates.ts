import type { ApiClient } from './client';

/**
 * CAL agenda templates (x314) — the meeting agenda-template list / create / edit / delete / apply
 * client.
 *
 * A template is an org-scoped reusable agenda served at `.../meetings/agenda-templates`: `GET` lists
 * a tenant's templates behind `meeting.read`; `POST` creates, `PUT .../:templateId` replaces
 * (idempotent), and `DELETE .../:templateId` removes one behind `meeting.write`. `POST
 * .../meetings/:meetingId/apply-agenda-template` seeds a meeting's agenda items from a template,
 * behind `meeting.write`. A template names no project — unlike a meeting — so nothing here carries a
 * `projectId`.
 */

/** One ordered agenda item in a template: a short title and its position in the list. */
export interface MeetingAgendaTemplateItem {
  readonly title: string;
  /** 0-based position; the server assigns it from the item's index in the submitted list. */
  readonly position: number;
}

/**
 * One template, as the screen reads it. Paired `Exact` with the API's `AgendaTemplateView` in the
 * contracts gate (`e2e/contracts/api-web-shapes.ts`): rename or retype a field on either side and
 * `pnpm contracts:check` fails. `organizationId` is deliberately absent — it is never echoed into a
 * response body (`25-AUTH-AND-TENANT-ISOLATION` §7).
 */
export interface AgendaTemplateView {
  readonly id: string;
  readonly name: string;
  readonly items: readonly MeetingAgendaTemplateItem[];
  readonly createdByUserId: string;
  /** ISO-8601 instants on the wire. */
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What the create/edit form sends. A request body, not a paired projection. */
export interface AgendaTemplateInput {
  readonly name: string;
  /** Each item needs a non-empty `title`; the server assigns positions from the list order. */
  readonly items: readonly { readonly title: string }[];
}

/**
 * The outcome of applying a template. Not a `*View` — so the contracts gate does not enumerate it —
 * and it echoes no tenant id: which meeting, which template, and how many items were newly seeded
 * versus skipped as already-present (the apply is idempotent).
 */
export interface ApplyAgendaTemplateResult {
  readonly meetingId: string;
  readonly templateId: string;
  readonly seeded: number;
  readonly skipped: number;
}

/** List a tenant's agenda templates (behind `meeting.read`). */
export async function listAgendaTemplates(
  client: ApiClient,
  organizationSlug: string,
): Promise<{ readonly templates: readonly AgendaTemplateView[] }> {
  const { data } = await client.request<{ readonly templates: readonly AgendaTemplateView[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings/agenda-templates`,
  });
  return data;
}

/** Create an agenda template (behind `meeting.write`). Returns the created template (201). */
export async function createAgendaTemplate(
  client: ApiClient,
  organizationSlug: string,
  input: AgendaTemplateInput,
): Promise<AgendaTemplateView> {
  const { data } = await client.request<AgendaTemplateView>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings/agenda-templates`,
    body: input,
  });
  return data;
}

/** Replace an agenda template's name + items (behind `meeting.write`, idempotent PUT). */
export async function updateAgendaTemplate(
  client: ApiClient,
  organizationSlug: string,
  templateId: string,
  input: AgendaTemplateInput,
): Promise<AgendaTemplateView> {
  const { data } = await client.request<AgendaTemplateView>({
    method: 'PUT',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings/agenda-templates/${encodeURIComponent(templateId)}`,
    body: input,
  });
  return data;
}

/** Delete an agenda template (behind `meeting.write`, 204). */
export async function deleteAgendaTemplate(
  client: ApiClient,
  organizationSlug: string,
  templateId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings/agenda-templates/${encodeURIComponent(templateId)}`,
  });
}

/** Apply a template to a meeting, seeding its agenda items idempotently (behind `meeting.write`). */
export async function applyAgendaTemplate(
  client: ApiClient,
  organizationSlug: string,
  meetingId: string,
  templateId: string,
): Promise<ApplyAgendaTemplateResult> {
  const { data } = await client.request<ApplyAgendaTemplateResult>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings/${encodeURIComponent(meetingId)}/apply-agenda-template`,
    body: { templateId },
  });
  return data;
}
