import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  MeetingAgendaTemplateItem,
  MeetingAgendaTemplateRow,
  MeetingRow,
} from '../../common/database/schema.js';
import { MeetingsRepository } from './meetings.repository.js';
import { MeetingNotesRepository } from './meeting-notes.repository.js';
import { AgendaTemplatesRepository } from './agenda-templates.repository.js';
import type {
  CreateAgendaTemplateInput,
  ListAgendaTemplatesOptions,
  UpdateAgendaTemplateInput,
} from './agenda-templates.repository.js';

/**
 * Injection token for {@link AgendaTemplatesService}. Slice-local (declared beside the class it
 * provides) to keep this slice file-disjoint from the shared `common/http/tokens.ts`, the
 * convention {@link MeetingRsvpService} follows.
 */
export const AGENDA_TEMPLATES_SERVICE = Symbol('AGENDA_TEMPLATES_SERVICE');

/**
 * The application service for CAL agenda templates (x314) — the object-level decision the route
 * guard cannot make, and the transaction boundary the controller may not open.
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on the route asks the coarse `meeting.read`/`meeting.write` question. This
 * service repeats it at the object layer so the decision holds even for a caller reaching the
 * service by some path that bypassed the guard (spec §3: route guards are UX, the evaluator is the
 * control) — and, for the template CRUD, that is the *only* check, because a template is org-scoped
 * and names no project. It calls `authorize()` with `meeting.read`/`meeting.write` against a
 * resource whose `projectId` is `null` (the `MeetingSeriesService` shape); those capabilities are
 * not relation-gated, so the decision reduces to the role ceiling and a role that lacks it is a
 * **403**.
 *
 * ## Apply resolves the meeting and the template tenant-scoped BEFORE it authorizes or writes
 *
 * The apply endpoint names a meeting by path id; a meeting *is* project-owned, so the Known-trap
 * order applies (the `MeetingAttendeesService` shape): the meeting is resolved tenant-scoped first —
 * an unknown or cross-tenant `meetingId` is `null` → 404 with no write — then relation-checked with
 * `work.create` (the ceiling-mirror of `meeting.write`), and a caller off that project relation gets
 * the same 404, never a 403. Only then is the template resolved tenant-scoped (a cross-tenant
 * `templateId` → 404) and its items seeded.
 *
 * ## Apply seeds the meeting's existing item store, idempotently
 *
 * There is no dedicated agenda-item table; the per-meeting item store is `meeting_notes` (0033,
 * x105). Applying a template inserts one note (kind `note`, body = the item title) per template item
 * whose title is not already a note on that meeting, so re-applying the same template — or applying
 * two templates that share an item — never duplicates an identical title. This slice adds no schema
 * to `meeting_notes`; it reads its store for existence and writes through its repository's `create`.
 */

/** What a caller is allowed to see of a template. `organizationId` is deliberately absent (§7). */
export interface AgendaTemplateView {
  readonly id: string;
  readonly name: string;
  readonly items: readonly MeetingAgendaTemplateItem[];
  readonly createdByUserId: string;
  /** ISO-8601 instants on the wire. */
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The outcome of applying a template: which meeting, and how many items were newly seeded. */
export interface ApplyAgendaTemplateResult {
  readonly meetingId: string;
  readonly templateId: string;
  /** Template items whose title was inserted as a new note by this apply. */
  readonly seeded: number;
  /** Template items whose title was already a note on the meeting (skipped — idempotent). */
  readonly skipped: number;
}

/**
 * An explicit projection, not a serialised row (`25-AUTH-AND-TENANT-ISOLATION` §7): a column added
 * to `meeting_agenda_templates` in a future migration is invisible until someone decides otherwise,
 * and `organization_id` is never echoed into a response body.
 */
function toView(row: MeetingAgendaTemplateRow): AgendaTemplateView {
  return {
    id: row.id,
    name: row.name,
    items: [...row.itemsJson].sort((left, right) => left.position - right.position),
    createdByUserId: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class AgendaTemplatesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly templates: AgendaTemplatesRepository = new AgendaTemplatesRepository(),
    /**
     * Read-only, used to resolve the meeting named in the path tenant-scoped before any authorize
     * or write on apply (the Known-trap order). Stateless, so a fresh handle is cheap.
     */
    private readonly meetings: MeetingsRepository = new MeetingsRepository(),
    /**
     * The per-meeting agenda-item store (x105). Read for existence and written through on apply; no
     * schema edit here — the seed reuses this repository's `list` and `create`.
     */
    private readonly notes: MeetingNotesRepository = new MeetingNotesRepository(),
  ) {}

  /** Throw 403 unless the principal's ceiling includes `capability` in the acting tenant. */
  private requireCapability(
    context: TenantContext,
    principal: Principal,
    capability: Capability,
  ): void {
    const decision = authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        // A template is org-scoped: no project relation to check.
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!decision.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
    }
  }

  /** Create a template behind `meeting.write`. */
  async create(
    context: TenantContext,
    principal: Principal,
    input: Omit<CreateAgendaTemplateInput, 'createdBy'>,
  ): Promise<AgendaTemplateView> {
    this.requireCapability(context, principal, 'meeting.write');

    const row = await this.database.transaction(context, (tx) =>
      this.templates.create(tx, context, { ...input, createdBy: context.userId }),
    );
    return toView(row);
  }

  /** List the tenant's templates behind `meeting.read`, in the repository's deterministic order. */
  async list(
    context: TenantContext,
    principal: Principal,
    options: ListAgendaTemplatesOptions,
  ): Promise<readonly AgendaTemplateView[]> {
    this.requireCapability(context, principal, 'meeting.read');

    const rows = await this.database.read(context, (runner) =>
      this.templates.list(runner, context, options),
    );
    return rows.map(toView);
  }

  /**
   * Replace a template's name + items behind `meeting.write` (idempotent PUT).
   *
   * The capability is checked first (403 for a role without it, org-scoped so nothing to hide behind
   * a 404); then the template is resolved tenant-scoped — a cross-tenant or unknown id is a 404 with
   * no write — and only then replaced.
   */
  async update(
    context: TenantContext,
    principal: Principal,
    templateId: string,
    input: UpdateAgendaTemplateInput,
  ): Promise<AgendaTemplateView> {
    this.requireCapability(context, principal, 'meeting.write');

    const existing = await this.database.read(context, (runner) =>
      this.templates.findById(runner, context, templateId),
    );
    if (!existing) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'template_not_visible');
    }

    const row = await this.database.transaction(context, (tx) =>
      this.templates.update(tx, context, templateId, input),
    );
    return toView(row);
  }

  /**
   * Delete a template behind `meeting.write`. A cross-tenant or unknown id is a 404 (the scoped
   * delete removed nothing), never a silent success.
   */
  async delete(context: TenantContext, principal: Principal, templateId: string): Promise<void> {
    this.requireCapability(context, principal, 'meeting.write');

    const removed = await this.database.transaction(context, (tx) =>
      this.templates.delete(tx, context, templateId),
    );
    if (!removed) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'template_not_visible');
    }
  }

  /**
   * Apply a template to a meeting, seeding its agenda items (meeting notes) idempotently.
   *
   * The meeting is resolved tenant-scoped and relation-checked with `work.create` before any write
   * (the Known-trap order); a cross-tenant `meetingId` or a caller off the project is a 404 with no
   * write. The template is then resolved tenant-scoped (a cross-tenant `templateId` → 404). Existing
   * notes on the meeting are read once; a template item whose title already matches a note body is
   * skipped, the rest are inserted as `note` records in one transaction.
   */
  async applyToMeeting(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
    templateId: string,
  ): Promise<ApplyAgendaTemplateResult> {
    const meeting = await this.database.read(context, (runner) =>
      this.meetings.findById(runner, context, meetingId),
    );
    if (!meeting || !this.mayWriteMeeting(principal, meeting)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'meeting_not_visible');
    }

    const template = await this.database.read(context, (runner) =>
      this.templates.findById(runner, context, templateId),
    );
    if (!template) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'template_not_visible');
    }

    const existingNotes = await this.database.read(context, (runner) =>
      this.notes.list(runner, context, { meetingId, limit: 200 }),
    );
    const existingTitles = new Set(existingNotes.map((note) => note.body));

    const toSeed = [...template.itemsJson]
      .sort((left, right) => left.position - right.position)
      .filter((item) => !existingTitles.has(item.title));

    if (toSeed.length > 0) {
      await this.database.transaction(context, async (tx) => {
        for (const item of toSeed) {
          await this.notes.create(tx, context, {
            meetingId,
            kind: 'note',
            body: item.title,
            authorUserId: context.userId,
          });
        }
      });
    }

    return {
      meetingId,
      templateId,
      seeded: toSeed.length,
      skipped: template.itemsJson.length - toSeed.length,
    };
  }

  /** The relation rule for a meeting write, expressed with `work.create` (mirror of meeting.write). */
  private mayWriteMeeting(principal: Principal, meeting: MeetingRow): boolean {
    return authorize({
      principal,
      capability: 'work.create',
      resource: {
        organizationId: meeting.organizationId,
        projectId: meeting.projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }
}
