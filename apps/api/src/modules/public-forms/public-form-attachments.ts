import { createHmac } from 'node:crypto';
import { uuidv7 } from '@tmanage/domain';
import type { WorkFormRow } from '../../common/database/schema.js';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { FORM_ATTACHMENT_LIMIT, FORM_ATTACHMENT_MAX_FILES } from '../files/purpose-policy.js';
import type { PublicFormUploadTarget } from '../files/files.service.js';
import { constantTimeEquals } from '../identity/session-token.js';
import type { ThrottleLimits } from '../rate-limits/durable-rate-limiter.js';
import { scannerConfigured } from '../tenancy/download-scan-policy.js';
import type { ScannerPresence } from '../tenancy/download-scan-policy.js';
import type { PublicFormsRepository } from './public-forms.repository.js';
import { isPublicSlug } from './public-forms.validate.js';

/**
 * 52-20a — the public-form attachment rule (spec 52 §15.1), the gate in front of the upload door.
 *
 * ## Who decides
 *
 * The form's owner: `work_forms.attachment_project_id` (0365). NULL, the default, means visitors
 * attach nothing; a project id means visitors may attach images and PDF ({@link FORM_ATTACHMENT_LIMIT},
 * at most {@link FORM_ATTACHMENT_MAX_FILES}), kept in that project. A deployment with no malware
 * scanner offers no attachments at all — a stranger's file must be scanned before staff open it.
 *
 * ## How an upload is bound
 *
 * `POST /v1/public/forms/:slug/upload-token` mints a **draft token**: the organization, the form and
 * a fresh submission id, sealed with an HMAC under the session secret and valid for
 * {@link DRAFT_TOKEN_TTL_SECONDS}. Every upload carries it; the gate opens it, checks it names
 * *this* form of *this* organization, and hands the files door a {@link PublicFormUploadTarget}
 * built from the form row and the token alone. The submission that follows is stored under the
 * token's id, so the files are bound to it by `object_id` and nothing the visitor says can point a
 * file at another form, another organization or another submission. A visitor reads nothing back.
 */

/**
 * The anonymous attachment routes' budget (token, create, complete, cancel), per IP and form: five
 * files cost eleven calls, so a person is never near it and a script is held to a trickle.
 */
export const PUBLIC_FORM_UPLOAD_LIMITS: ThrottleLimits = {
  perMinute: 30,
  perHour: 120,
  key: 'ip+link',
  onStoreError: 'closed',
};

/** A visitor fills the rest of the form after attaching; one hour is the whole visit. */
export const DRAFT_TOKEN_TTL_SECONDS = 60 * 60;
const TOKEN_PURPOSE = 'public-form-draft.v1';

const SERVICE_POLICY = 'public-form-intake';
const BOOTSTRAP_REASON =
  'resolving which organization a published public form slug belongs to (slug is globally unique; the organization comes from the form row)';

/** What a draft token carries. Short keys: it travels in a header on every upload. */
export interface DraftClaims {
  readonly organizationId: string;
  readonly formId: string;
  readonly submissionId: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`${TOKEN_PURPOSE}.${payload}`).digest('base64url');
}

export function sealDraftToken(claims: DraftClaims, secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      o: claims.organizationId,
      f: claims.formId,
      s: claims.submissionId,
      e: claims.expiresAt,
    }),
    'utf8',
  ).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/** The claims, or `null` for a missing, forged, malformed or expired token. */
export function openDraftToken(
  raw: unknown,
  secret: string,
  nowSeconds: number,
): DraftClaims | null {
  if (typeof raw !== 'string' || raw.length > 512) return null;
  const [payload, signature, extra] = raw.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  if (!constantTimeEquals(signature, sign(payload, secret))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const { o, f, s, e } = (parsed ?? {}) as Record<string, unknown>;
  if (typeof o !== 'string' || typeof f !== 'string' || typeof s !== 'string') return null;
  if (typeof e !== 'number' || !Number.isSafeInteger(e) || e <= nowSeconds) return null;
  return { organizationId: o, formId: f, submissionId: s, expiresAt: e };
}

/** What a visitor's page is told about attachments: the rule, or nothing when there are none. */
export interface PublicAttachmentRule {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly mimeTypes: readonly string[];
}

export interface DraftTokenView {
  readonly uploadToken: string;
  readonly expiresAt: string;
}

/** A published form resolved from its slug, under a service context for its own organization. */
export interface ResolvedPublicForm {
  readonly context: TenantContext;
  readonly form: WorkFormRow;
}

const notFound = (): ApiError =>
  new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'public_form_unknown');

const attachmentsDisabled = (): ApiError =>
  new ApiError(
    409,
    'conflict',
    'This form does not take attachments.',
    undefined,
    'attachments_disabled',
  );

const tokenRefused = (): ApiError =>
  new ApiError(
    400,
    'validation_failed',
    'The attachments have expired. Please attach the files again.',
    [{ field: 'uploadToken', message: 'is not valid for this form' }],
    'form_upload_token_refused',
  );

export class PublicFormAttachmentGate {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: PublicFormsRepository,
    private readonly scanner: ScannerPresence | undefined,
    private readonly secret: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * The slug → the published form, under a service context for the form's organization. Unknown,
   * malformed and unpublished slugs give the same 404.
   */
  async resolve(slug: unknown, correlationId: string): Promise<ResolvedPublicForm> {
    if (!isPublicSlug(slug)) throw notFound();
    const found = await this.database.bootstrapRead(
      { correlationId, reason: BOOTSTRAP_REASON, tables: ['work_forms'] },
      (runner) => this.repository.findPublishedBySlug(runner, slug),
    );
    if (!found) throw notFound();
    const context = createServiceContext({
      organizationId: found.organizationId,
      correlationId,
      policyVersion: SERVICE_POLICY,
    });
    const form = await this.database.read(context, (runner) =>
      this.repository.findForm(runner, context, found.id),
    );
    if (!form || !form.publicEnabled) throw notFound();
    return { context, form };
  }

  /** The rule a visitor's page shows, or `null`: the owner allows none, or nothing scans. */
  rule(form: WorkFormRow): PublicAttachmentRule | null {
    if (form.attachmentProjectId === null || !scannerConfigured(this.scanner)) return null;
    return {
      maxFiles: FORM_ATTACHMENT_MAX_FILES,
      maxBytes: FORM_ATTACHMENT_LIMIT.maxBytes,
      mimeTypes: FORM_ATTACHMENT_LIMIT.mimeTypes,
    };
  }

  /** `POST …/upload-token`: a fresh draft for this visit, or 409 when the form takes no files. */
  async openDraft(slug: unknown, correlationId: string): Promise<DraftTokenView> {
    const { context, form } = await this.resolve(slug, correlationId);
    if (this.rule(form) === null) throw attachmentsDisabled();
    const expiresAt = Math.floor(this.now().getTime() / 1000) + DRAFT_TOKEN_TTL_SECONDS;
    const uploadToken = sealDraftToken(
      {
        organizationId: context.organizationId,
        formId: form.id,
        submissionId: uuidv7(),
        expiresAt,
      },
      this.secret,
    );
    return { uploadToken, expiresAt: new Date(expiresAt * 1000).toISOString() };
  }

  /**
   * The upload door's target: the owner's project, the form's author and the token's submission.
   * Re-checks the owner's setting on every upload, so switching attachments off stops the next one.
   */
  async uploadTarget(
    slug: unknown,
    rawToken: unknown,
    correlationId: string,
  ): Promise<{ readonly context: TenantContext; readonly target: PublicFormUploadTarget }> {
    const { context, form } = await this.resolve(slug, correlationId);
    if (this.rule(form) === null || form.attachmentProjectId === null) {
      throw attachmentsDisabled();
    }
    const submissionId = this.submissionIdFor({ context, form }, rawToken);
    return {
      context,
      target: {
        projectId: form.attachmentProjectId,
        ownerUserId: form.createdBy,
        submissionId,
      },
    };
  }

  /** The submission id a valid token for *this* form of *this* organization carries; else 400. */
  submissionIdFor(resolved: ResolvedPublicForm, rawToken: unknown): string {
    const claims = openDraftToken(rawToken, this.secret, Math.floor(this.now().getTime() / 1000));
    if (
      claims === null ||
      claims.organizationId !== resolved.context.organizationId ||
      claims.formId !== resolved.form.id
    ) {
      throw tokenRefused();
    }
    return claims.submissionId;
  }
}
