import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { FORM_SUBMISSION_STATES } from '../../common/database/schema.js';
import type { FormSubmissionRow, FormSubmissionState } from '../../common/database/schema.js';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { ChallengeView } from '../public-abuse/challenge.service.js';
import type { AssessPublicWrite } from '../public-abuse/public-abuse.guard.js';
import type { PublicFormsRepository } from './public-forms.repository.js';
import {
  checkPublicValues,
  isPublicSlug,
  newPublicSlug,
  newSubmissionReference,
  submissionDescription,
  toPublicDefinition,
} from './public-forms.validate.js';
import type { PublicFormDefinition, SubmittedValue } from './public-forms.validate.js';
import { classifyUpload, DEFAULT_PRESETS } from '../files/file-safety.js';
import type { ClassifyResult } from '../files/file-safety.js';

/** 56-06 / 52-20a: a public form's attachment, judged by the one file-safety rule (images + PDF). */
export function classifyPublicFormAttachment(file: {
  readonly fileName: string;
  readonly declaredType: string;
  readonly sizeBytes: number;
  readonly head?: Buffer;
}): ClassifyResult {
  const maxBytes = 25 * 1024 * 1024;
  return classifyUpload({ ...file, channel: 'public_form', presets: DEFAULT_PRESETS, maxBytes });
}

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
 * `(organization_id, id)`; everything after runs under a service context for that organization.
 * Unknown, malformed and unpublished slugs give the same 404. A submission's values are checked
 * against the form (opaque keys, typed, length-capped) before 52-21's `assessPublicWrite` runs;
 * `blocked` stores nothing, `challenge` is a 202 the page renders, `hold` is stored as `new` for a
 * person, `spam` is stored as `spam` — and the visitor gets the same `{ reference }` either way.
 */

const SERVICE_POLICY = 'public-form-intake';
const BOOTSTRAP_REASON =
  'resolving which organization a published public form slug belongs to (slug is globally unique; the organization comes from the form row)';
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

export interface SubmissionView {
  readonly id: string;
  readonly reference: string;
  readonly state: FormSubmissionState;
  readonly values: Readonly<Record<string, SubmittedValue>>;
  readonly language: string | null;
  readonly risk: { readonly decision: string; readonly score: number; readonly reasons: string[] };
  readonly workItemId: string | null;
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

export function toSubmissionView(row: FormSubmissionRow): SubmissionView {
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
    const rows = await this.database.read(context, async (runner) => {
      const form = await this.repository.findForm(runner, context, formId);
      if (!form) throw notFound('public_form_not_visible');
      this.requireOrg(principal, context, 'client_request.triage');
      return this.repository.listSubmissions(runner, context, formId, {
        ...(state === undefined ? {} : { state }),
        limit,
      });
    });
    return rows.map(toSubmissionView);
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
      if (row.state === 'spam') return toSubmissionView(row);
      const moved = await this.repository.transition(tx, context, submissionId, ['new'], {
        state: 'spam',
        spamMarkedBy: context.userId,
      });
      if (moved === 0) throw this.conflict();
      return toSubmissionView({ ...row, state: 'spam', spamMarkedBy: context.userId });
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
      return { row, formName: form.name };
    });

    const view = toSubmissionView(claimed.row);
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

  async publicDefinition(slug: unknown, correlationId: string): Promise<PublicFormDefinition> {
    const found = await this.resolvePublic(slug, correlationId);
    return toPublicDefinition(found.form.name, found.form.fieldsJson);
  }

  async submit(request: PublicSubmitRequest): Promise<PublicSubmitResult> {
    const { context, form } = await this.resolvePublic(request.slug, request.correlationId);
    const values = checkPublicValues(form.fieldsJson, request.body['values']);

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
        const reference = newSubmissionReference();
        await this.repository.insertSubmission(
          tx,
          context,
          {
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

  private async resolvePublic(slug: unknown, correlationId: string) {
    if (!isPublicSlug(slug)) throw notFound('public_form_unknown');
    const found = await this.database.bootstrapRead(
      { correlationId, reason: BOOTSTRAP_REASON, tables: ['work_forms'] },
      (runner) => this.repository.findPublishedBySlug(runner, slug),
    );
    if (!found) throw notFound('public_form_unknown');
    const context = createServiceContext({
      organizationId: found.organizationId,
      correlationId,
      policyVersion: SERVICE_POLICY,
    });
    const form = await this.database.read(context, (runner) =>
      this.repository.findForm(runner, context, found.id),
    );
    if (!form || !form.publicEnabled) throw notFound('public_form_unknown');
    return { context, form };
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
