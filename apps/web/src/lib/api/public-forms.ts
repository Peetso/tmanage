import type { ApiClient } from './client';
import { ApiRequestError } from './errors';
import type { WorkFormFieldType } from './work-forms';

/**
 * 52-20 — the anonymous door of a published work form, as the public page `/f/<slug>` uses it.
 * No session: both calls go with `authentication: 'none'`. The visitor never sees an id, a project
 * or an organization — only the title and the fields under opaque keys (`f1`, `f2`, …).
 */

/** One field as a visitor sees it. Mirrors the API's `PublicFormField`. */
export interface PublicFormField {
  readonly key: string;
  readonly label: string;
  readonly type: WorkFormFieldType;
  readonly required: boolean;
  readonly maxLength?: number;
}

/** 52-20a. What a visitor may attach. Mirrors the API's `PublicAttachmentRule`. */
export interface PublicAttachmentRule {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly mimeTypes: readonly string[];
}

/** `GET /v1/public/forms/:slug`. Mirrors the API's `PublicFormView`. */
export interface PublicFormDefinition {
  readonly title: string;
  readonly fields: readonly PublicFormField[];
  /** 52-20a. `null` (or absent, e.g. a portal journey step) when the form takes no files. */
  readonly attachments?: PublicAttachmentRule | null;
}

/** A held submission's challenge. Mirrors the API's `ChallengeView`. */
export interface PublicChallengeView {
  readonly kind: 'email_code' | 'pow' | 'turnstile';
  readonly challengeId: string;
  readonly resendAfterSeconds: number;
  readonly salt?: string;
  readonly bits?: number;
}

/** What a submission POST answers: stored (`reference`) or held (`challenge`). */
export type PublicSubmitResult =
  { readonly reference: string } | { readonly challenge: PublicChallengeView };

/** The body a submission sends. Request-side (suffix `Input`). */
export type PublicSubmitInput = Readonly<Record<string, unknown>> & {
  readonly values: Readonly<Record<string, string | number | boolean>>;
  /** 52-20a. The visit's draft token when files were attached. */
  readonly uploadToken?: string;
};

function path(slug: string): string {
  return `/v1/public/forms/${encodeURIComponent(slug)}`;
}

export async function getPublicForm(
  client: ApiClient,
  slug: string,
): Promise<PublicFormDefinition> {
  const { data } = await client.request<PublicFormDefinition>({
    path: path(slug),
    authentication: 'none',
  });
  return data;
}

export async function submitPublicForm(
  client: ApiClient,
  slug: string,
  input: PublicSubmitInput,
): Promise<PublicSubmitResult> {
  const { data } = await client.request<PublicSubmitResult>({
    method: 'POST',
    path: `${path(slug)}/submissions`,
    body: input,
    authentication: 'none',
  });
  return data;
}

// ── 52-20a: attachments ─────────────────────────────────────────────────────

/** The header the API reads the visit's draft token from (never the URL). */
const TOKEN_HEADER = 'x-form-upload-token';

/** Why one file did not attach — each has its own calm sentence on the page. */
export type AttachmentProblem = 'too_big' | 'wrong_type' | 'limit' | 'unavailable' | 'failed';

export class AttachmentError extends Error {
  constructor(readonly problem: AttachmentProblem) {
    super(problem);
    this.name = 'AttachmentError';
  }
}

/** The browser's own check, so a wrong file is explained before anything is sent. */
export function attachmentProblem(
  file: { readonly size: number; readonly type: string },
  rule: PublicAttachmentRule,
): AttachmentProblem | null {
  if (!rule.mimeTypes.includes(file.type.toLowerCase())) return 'wrong_type';
  return file.size > rule.maxBytes ? 'too_big' : null;
}

/** `POST …/upload-token`: the draft token every upload of this visit carries. */
export async function openPublicFormDraft(client: ApiClient, slug: string): Promise<string> {
  try {
    const { data } = await client.request<{ readonly uploadToken: string }>({
      method: 'POST',
      path: `${path(slug)}/upload-token`,
      authentication: 'none',
    });
    return data.uploadToken;
  } catch (error) {
    throw new AttachmentError(problemOf(error));
  }
}

/** 52-20a. The upload start reply, as far as the page reads it. Narrows the API's `PublicFormUploadView`. */
export interface PublicUploadReply {
  readonly id: string;
  readonly partSizeBytes: number;
  readonly uploadUrls: readonly { readonly partNumber: number; readonly url: string }[];
}

function problemOf(error: unknown): AttachmentProblem {
  if (!(error instanceof ApiRequestError)) return 'failed';
  if (error.status === 409) return 'unavailable';
  // The file-safety refusal (422) names its reason token in one `reason` detail.
  const reason = error.details.find((detail) => detail.field === 'reason')?.message;
  if (reason !== undefined) return reason === 'too_large' ? 'too_big' : 'wrong_type';
  const fields = error.details.map((detail) => detail.field);
  if (fields.includes('files')) return 'limit';
  if (fields.includes('sizeBytes')) return 'too_big';
  if (fields.includes('mimeType')) return 'wrong_type';
  return 'failed';
}

/**
 * One file through the form's attachment door: open the upload, send its parts to the targets the
 * API minted (no cookie travels), complete it. A refusal is an {@link AttachmentError}; an upload
 * that stops part-way is cancelled so it holds nothing.
 */
export async function uploadPublicFormFile(
  client: ApiClient,
  slug: string,
  uploadToken: string,
  file: File,
  options: { readonly idempotencyKey: string; readonly fetcher?: typeof fetch } = {
    idempotencyKey: crypto.randomUUID(),
  },
): Promise<void> {
  const base = `${path(slug)}/uploads`;
  const headers = { [TOKEN_HEADER]: uploadToken };
  let session: PublicUploadReply;
  try {
    ({ data: session } = await client.request<PublicUploadReply>({
      method: 'POST',
      path: base,
      authentication: 'none',
      headers: { ...headers, 'idempotency-key': options.idempotencyKey },
      body: { fileName: file.name, mimeType: file.type.toLowerCase(), sizeBytes: file.size },
    }));
  } catch (error) {
    throw new AttachmentError(problemOf(error));
  }
  const at = `${base}/${encodeURIComponent(session.id)}`;
  try {
    const send = options.fetcher ?? fetch;
    const parts: { partNumber: number; etag: string }[] = [];
    for (const target of [...session.uploadUrls].sort((a, b) => a.partNumber - b.partNumber)) {
      const start = (target.partNumber - 1) * session.partSizeBytes;
      const response = await send(target.url, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: file.slice(start, start + session.partSizeBytes),
        credentials: 'omit',
      });
      const etag = response.headers.get('etag');
      if (!response.ok || !etag) throw new AttachmentError('failed');
      parts.push({ partNumber: target.partNumber, etag });
    }
    await client.request<unknown>({
      method: 'POST',
      path: `${at}/complete`,
      authentication: 'none',
      headers,
      body: { parts },
    });
  } catch (error) {
    await client
      .request<unknown>({ method: 'POST', path: `${at}/cancel`, authentication: 'none', headers })
      .catch(() => undefined);
    throw error instanceof AttachmentError ? error : new AttachmentError(problemOf(error));
  }
}
