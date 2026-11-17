import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { FORM_SUBMISSION_STATES } from '../../common/database/schema.js';
import type { FormSubmissionRow, FormSubmissionState } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { ChallengeView } from '../public-abuse/challenge.service.js';
import type { AssessPublicWrite } from '../public-abuse/public-abuse.guard.js';
import type { PublicFormAttachmentGate, PublicAttachmentRule } from './public-form-attachments.js';
import type { PublicFormsRepository, SubmissionAttachmentRow } from './public-forms.repository.js';
import {
  checkPublicValues,
  newPublicSlug,
  newSubmissionReference,
  submissionDescription,
  toPublicDefinition,
} from './public-forms.validate.js';
import type { PublicFormDefinition, SubmittedValue } from './public-forms.validate.js';

/**
 * 52-20 — public intake forms, backend half (spec 52 §52-20, migration 0258).
 *
 * ## Internal (signed in)
 *
 * Publish / unpublish a `work_forms` row (`work.create`, as defining one is — `form.manage` is not
 * a capability yet), and triage its submissions (`client_request.triage`): list, mark spam,
 * convert to a work item. Converting goes through the existing `WorkItemsService.create`, which
 * resolves the project tenant-scoped and relation-gates `work.create` (a stranger's project is a
 * 404). A conversion claims the row first (`new|spam → converting`, a compare-and-set), so two
 * triagers racing get one work item and one 409; a failed create puts the row back.
 *
 * ## Public (no session)
 *
 * The slug is shape-checked, then resolved on `bootstrapRead(['work_forms'])` to the form's
 * `(organization_id, id)` ({@link PublicFormAttachmentGate.resolve}); everything after runs under
 * a service context for that organization.
 * Unknown, malformed and unpublished slugs give the same 404. A submission's values are checked
 * against the form (opaque keys, typed, length-capped) before 52-21's `assessPublicWrite` runs;
 * `blocked` stores nothing, `challenge` is a 202 the page renders, `hold` is stored as `new` for a
 * person, `spam` is stored as `spam` — and the visitor gets the same `{ reference }` either way.
 *
 * ## Attachments (52-20a)
 *
 * The owner's setting (`setAttachments`) and the gate decide whether a visitor may attach files.
 * A submission that carries the visit's `uploadToken` is stored under the token's submission id,
 * which is the `object_id` its files were uploaded under; triage lists them with the submission.
 */
const MAX_PAGE = 100;
const DEFAULT_PAGE = 50;
const MAX_TITLE = 300;

/** The narrow slice of `WorkItemsService` a conversion uses. */
export interface WorkItemCreator {
  create(
    context: TenantContext,
    principal: Principal,
    input: { projectId: string; title: string; description?: string | null },
  ): Promise<{ readonly id: string }>;
}

export interface PublicFormState {
  readonly published: boolean;
  /** The path a visitor opens: `/f/<slug>`. */
  readonly slug: string | null;
}

/** 52-20a. The owner's attachment setting: the project visitors' files go to, or `null` (off). */
export interface PublicFormAttachmentSetting {
  readonly attachmentProjectId: string | null;
}

/** `GET /v1/public/forms/:slug`: the opaque definition and the attachment rule (or `null`). */
export interface PublicFormView extends PublicFormDefinition {
  readonly attachments: PublicAttachmentRule | null;
}

/** 52-20a. A visitor's file as triage sees it; opened through the normal (scan-gated) download. */
export interface SubmissionAttachmentView {
  readonly fileAssetId: string;
  readonly name: string;
  readonly status: string;
}

export interface SubmissionView {
  readonly id: string;
  readonly reference: string;
  readonly state: FormSubmissionState;
  readonly values: Readonly<Record<string, SubmittedValue>>;
  readonly language: string | null;
  readonly risk: { readonly decision: string; readonly score: number; readonly reasons: string[] };
  readonly workItemId: string | null;
  readonly attachments: readonly SubmissionAttachmentView[];
  readonly createdAt: string;
}

export type PublicSubmitResult =
  | { readonly kind: 'stored'; readonly reference: string }
  | { readonly kind: 'challenge'; readonly challenge: ChallengeView }
  | { readonly kind: 'blocked'; readonly retryAfterSeconds?: number };

export interface PublicSubmitRequest {
  readonly slug: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly ip: string | undefined;
  readonly acceptLanguage: string | undefined;
  readonly correlationId: string;
}

export function toSubmissionView(
  row: FormSubmissionRow,
  files: readonly SubmissionAttachmentRow[] = [],
): SubmissionView {
  return {
    id: row.id,
    reference: row.reference,
    state: row.state as FormSubmissionState,
    values: JSON.parse(row.valuesJson) as Record<string, SubmittedValue>,
    language: row.language,
    risk: {
      decision: row.riskDecision,
      score: row.riskScore,
      reasons: row.riskReasons === null || row.riskReasons === '' ? [] : row.riskReasons.split(','),
    },
    workItemId: row.createdWorkItemId,
    attachments: files
      .filter((file) => file.submissionId === row.id)
      .map((file) => ({ fileAssetId: file.fileAssetId, name: file.name, status: file.status })),
    createdAt: row.createdAt.toISOString(),
  };
}

const notFound = (reason: string): ApiError =>
  new ApiError(404, 'not_found', MESSAGES.notFound, undefined, reason);

const ER_DUP_ENTRY = 1062;
function isDuplicate(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    const candidate = e as { errno?: number; code?: string };
    if (candidate.errno === ER_DUP_ENTRY || candidate.code === 'ER_DUP_ENTRY') return true;
  }
  return false;
}

/** `pageLocale` from the page, else nothing: two letters, never free text. */
function languageOf(body: Readonly<Record<string, unknown>>): string | null {
  const raw = body['pageLocale'];
  return typeof raw === 'string' && /^[a-z]{2}$/u.test(raw) ? raw : null;
}

export class PublicFormsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: PublicFormsRepository,
    private readonly workItems: WorkItemCreator,
    private readonly assess: AssessPublicWrite | null,
    private readonly gate: PublicFormAttachmentGate,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ── Internal ───────────────────────────────────────────────────────────────

  async publish(
    context: TenantContext,
    principal: Principal,
    formId: string,
  ): Promise<PublicFormState> {
    return this.setPublished(context, principal, formId, true);
  }

  async unpublish(
    context: TenantContext,
    principal: Principal,
    formId: string,
  ): Promise<PublicFormState> {
    return this.setPublished(context, principal, formId, false);
  }

  private async setPublished(
    context: TenantContext,
    principal: Principal,
    formId: string,
    enabled: boolean,
  ): Promise<PublicFormState> {
    const attempt = (): Promise<PublicFormState> =>
      this.database.transaction(context, async (tx) => {
        const form = await this.repository.findForm(tx, context, formId);
        if (!form) throw notFound('public_form_not_visible');
        this.requireOrg(principal, context, 'work.create');
        const slug = form.publicSlug ?? (enabled ? newPublicSlug() : null);
        await this.repository.setPublic(tx, context, formId, {
          enabled,
          ...(form.publicSlug === null && slug !== null ? { slug } : {}),
        });
        return { published: enabled, slug };
      });
    try {
      return await attempt();
    } catch (error) {
      // A slug collision (one in 2^50 per pair) is retried once with a fresh slug.
      if (isDuplicate(error)) return attempt();
      throw error;
    }
  }

  /**
   * 52-20a. The owner's attachment setting. `projectId: null` switches attachments off; a project
   * id switches them on and keeps visitors' files there — a live project of this organization that
   * the caller may upload to (anything else is the same 404). The next upload re-reads it.
   */
  async setAttachments(
    context: TenantContext,
    principal: Principal,
    formId: string,
    body: { readonly projectId?: unknown } | undefined,
  ): Promise<PublicFormAttachmentSetting> {
    const raw = body?.projectId;
    if (raw !== null && (typeof raw !== 'string' || raw.trim() === '' || raw.length > 36)) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'projectId', message: 'must be a project id, or null to turn attachments off' },
      ]);
    }
    const projectId = raw === null ? null : raw.trim();
    return this.database.transaction(context, async (tx) => {
      const form = await this.repository.findForm(tx, context, formId);
      if (!form) throw notFound('public_form_not_visible');
      this.requireOrg(principal, context, 'work.create');
      if (projectId !== null) {
        const live = await this.repository.isLiveProject(tx, context, projectId);
        const may = authorize({
          principal,
          capability: 'file.upload',
          resource: {
            organizationId: context.organizationId,
            projectId,
            audience: 'internal',
            lifecycle: 'active',
          },
        }).allowed;
        if (!live || !may) throw notFound('attachment_project_not_visible');
      }
      await this.repository.setAttachmentProject(tx, context, formId, projectId);
      return { attachmentProjectId: projectId };
    });
  }

  async listSubmissions(
    context: TenantContext,
    principal: Principal,
    formId: string,
    query: { readonly state?: unknown; readonly limit?: unknown },
  ): Promise<readonly SubmissionView[]> {
    const state =
      query.state === undefined
        ? undefined
        : (FORM_SUBMISSION_STATES as readonly unknown[]).includes(query.state)
          ? (query.state as FormSubmissionState)
          : null;
    const limit = query.limit === undefined ? DEFAULT_PAGE : Number(query.limit);
    if (state === null || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE) {
      throw new ApiError(400, 'validation_failed', 'The query is invalid', [
        ...(state === null
          ? [{ field: 'state', message: `must be one of ${FORM_SUBMISSION_STATES.join(', ')}` }]
          : []),
        ...(Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_PAGE
          ? []
          : [{ field: 'limit', message: `must be an integer 1–${MAX_PAGE}` }]),
      ]);
    }
    return this.database.read(context, async (runner) => {
      const form = await this.repository.findForm(runner, context, formId);
      if (!form) throw notFound('public_form_not_visible');
      this.requireOrg(principal, context, 'client_request.triage');
      const rows = await this.repository.listSubmissions(runner, context, formId, {
        ...(state === undefined ? {} : { state }),
        limit,
      });
      const files = await this.repository.listAttachments(
        runner,
        context,
        rows.map((row) => row.id),
      );
      return rows.map((row) => toSubmissionView(row, files));
    });
  }

  async markSpam(
    context: TenantContext,
    principal: Principal,
    formId: string,
    submissionId: string,
  ): Promise<SubmissionView> {
    return this.database.transaction(context, async (tx) => {
      const row = await this.repository.findSubmission(tx, context, formId, submissionId);
      if (!row) throw notFound('form_submission_not_visible');
      this.requireOrg(principal, context, 'client_request.triage');
      const files = await this.repository.listAttachments(tx, context, [row.id]);
      if (row.state === 'spam') return toSubmissionView(row, files);
      const moved = await this.repository.transition(tx, context, submissionId, ['new'], {
        state: 'spam',
        spamMarkedBy: context.userId,
      });
      if (moved === 0) throw this.conflict();
      return toSubmissionView({ ...row, state: 'spam', spamMarkedBy: context.userId }, files);
    });
  }

  async convertToWorkItem(
    context: TenantContext,
    principal: Principal,
    formId: string,
    submissionId: string,
    body: { readonly projectId?: unknown; readonly title?: unknown } | undefined,
  ): Promise<SubmissionView> {
    const projectId = typeof body?.projectId === 'string' ? body.projectId.trim() : '';
    const rawTitle = typeof body?.title === 'string' ? body.title.trim() : undefined;
    const details = [
      ...(projectId === '' ? [{ field: 'projectId', message: 'must be a non-empty string' }] : []),
      ...(rawTitle !== undefined && (rawTitle === '' || rawTitle.length > MAX_TITLE)
        ? [{ field: 'title', message: `must be 1–${MAX_TITLE} characters` }]
        : []),
    ];
    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    // Claim first: one winner per row, so a double click or two triagers file one work item.
    const claimed = await this.database.transaction(context, async (tx) => {
      const row = await this.repository.findSubmission(tx, context, formId, submissionId);
      if (!row) throw notFound('form_submission_not_visible');
      this.requireOrg(principal, context, 'client_request.triage');
      const form = await this.repository.findForm(tx, context, formId);
      if (!form) throw notFound('public_form_not_visible');
      const moved = await this.repository.transition(tx, context, submissionId, ['new', 'spam'], {
        state: 'converting',
      });
      if (moved === 0) throw this.conflict();
      const files = await this.repository.listAttachments(tx, context, [row.id]);
      return { row, formName: form.name, files };
    });

    const view = toSubmissionView(claimed.row, claimed.files);
    let workItemId: string;
    try {
      const item = await this.workItems.create(context, principal, {
        projectId,
        title: rawTitle ?? `${claimed.formName} — ${view.reference}`.slice(0, MAX_TITLE),
        description: submissionDescription(view.reference, view.values),
      });
      workItemId = item.id;
    } catch (error) {
      // Put the row back so it can be converted again (to a project the triager may file into).
      await this.database.transaction(context, (tx) =>
        this.repository.transition(tx, context, submissionId, ['converting'], {
          state: claimed.row.state as FormSubmissionState,
        }),
      );
      throw error;
    }

    const convertedAt = this.now();
    await this.database.transaction(context, (tx) =>
      this.repository.transition(tx, context, submissionId, ['converting'], {
        state: 'converted',
        convertedBy: context.userId,
        convertedAt,
        createdWorkItemId: workItemId,
      }),
    );
    return { ...view, state: 'converted', workItemId };
  }

  // ── Public ─────────────────────────────────────────────────────────────────

  async publicDefinition(slug: unknown, correlationId: string): Promise<PublicFormView> {
    const { form } = await this.gate.resolve(slug, correlationId);
    return {
      ...toPublicDefinition(form.name, form.fieldsJson),
      attachments: this.gate.rule(form),
    };
  }

  async submit(request: PublicSubmitRequest): Promise<PublicSubmitResult> {
    const resolved = await this.gate.resolve(request.slug, request.correlationId);
    const { context, form } = resolved;
    const values = checkPublicValues(form.fieldsJson, request.body['values']);
    // 52-20a: a visit that attached files sends its draft token; the submission takes the token's
    // id, which is the one its files were uploaded under. A token for another form is a 400.
    const rawToken = request.body['uploadToken'];
    const submissionId =
      rawToken === undefined || rawToken === null
        ? undefined
        : this.gate.submissionIdFor(resolved, rawToken);

    const acceptLanguage = request.acceptLanguage;
    const verdict = await this.assess?.({
      surface: request.slug,
      kind: 'form_submit',
      body: request.body,
      texts: Object.values(values).filter((v): v is string => typeof v === 'string'),
      ip: request.ip,
      acceptLanguage,
      orgId: context.organizationId,
      offerChallenge: true,
      correlationId: request.correlationId,
    });
    if (verdict?.decision === 'blocked') {
      return verdict.retryAfterSeconds === undefined
        ? { kind: 'blocked' }
        : { kind: 'blocked', retryAfterSeconds: verdict.retryAfterSeconds };
    }
    if (verdict?.decision === 'challenge' && verdict.challenge !== undefined) {
      return { kind: 'challenge', challenge: verdict.challenge };
    }

    const store = (): Promise<string> =>
      this.database.transaction(context, async (tx) => {
        if (
          submissionId !== undefined &&
          (await this.repository.findSubmission(tx, context, form.id, submissionId)) !== null
        ) {
          throw new ApiError(
            409,
            'conflict',
            'This form was already sent.',
            undefined,
            'form_submission_sent',
          );
        }
        const reference = newSubmissionReference();
        await this.repository.insertSubmission(
          tx,
          context,
          {
            ...(submissionId === undefined ? {} : { id: submissionId }),
            formId: form.id,
            reference,
            valuesJson: JSON.stringify(values),
            language: languageOf(request.body),
            state: verdict?.decision === 'spam' ? 'spam' : 'new',
            riskDecision: verdict?.decision ?? 'allow',
            riskScore: verdict?.score ?? 0,
            riskReasons: verdict === undefined ? null : verdict.reasons.join(',').slice(0, 255),
          },
          this.now(),
        );
        return reference;
      });
    let reference: string;
    try {
      reference = await store();
    } catch (error) {
      // A reference collision (one in 2^30 per pair in one organization) is retried once.
      if (!isDuplicate(error)) throw error;
      reference = await store();
    }
    return { kind: 'stored', reference };
  }

  // ── Policy ─────────────────────────────────────────────────────────────────

  private requireOrg(principal: Principal, context: TenantContext, capability: Capability): void {
    const verdict = authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'public_form_denied');
    }
  }

  private conflict(): ApiError {
    return new ApiError(
      409,
      'conflict',
      'That submission was already handled.',
      undefined,
      'form_submission_state',
    );
  }
}
