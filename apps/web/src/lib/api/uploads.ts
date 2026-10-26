import type { ApiClient } from './client';
import { NetworkError } from './errors';
import { uploadToDrive, type DriveAttachmentView, type StorageStatusView } from './google-drive';
import {
  uploadToOneDrive,
  uploadsGoToOneDrive,
  type OneDriveAttachmentView,
  type OneDriveStatusView,
} from './onedrive';
import { attachWorkItemFile, type ItemFile } from './work-items';

/**
 * The browser side of the upload pipeline (FILE-001/002), for a work item's attachments.
 *
 * Three calls, the same three the upload journey (`e2e/tests/upload-journeys.spec.ts`) makes:
 *
 * 1. `POST …/upload-sessions` (signed in, with an `Idempotency-Key`) reserves quota and answers
 *    one target URL per part.
 * 2. Each part is `PUT` to its target **with no cookie** — the target carries its own signed part
 *    token, and on the production host it is the API's own `/v1/uploads/…` route (the local
 *    filesystem driver). The API answers each part's `ETag`.
 * 3. `POST …/upload-sessions/:id/complete` with those etags. The asset is then `uploaded`; the
 *    verifier and scanner take it from there, exactly as for every other upload.
 *
 * Nothing here decides what is allowed: the API refuses an oversized file, a purpose the caller
 * may not use and a project the caller cannot write to, and the verifier refuses a type outside
 * decision F5's families whatever the browser declared. The checks below only say so earlier, in
 * words, before any byte moves.
 *
 * The two response shapes are read partially (only the fields this flow needs) and are not
 * exported, so they are not web response projections for `contracts-check`; the API's
 * `UploadSessionView` and `FileAssetView` stay listed there as not fully mirrored by the web.
 */

/** The single-upload ceiling the API applies by default (`UPLOAD_MAX_BYTES`, 100 MiB). */
export const MAX_ATTACHMENT_BYTES = 104_857_600;

/** How many files one new work item takes in one go. */
export const MAX_ATTACHMENTS = 10;

/**
 * The media types the verifier admits (decision F5, `content-signature.ts`), keyed by extension
 * so a file whose browser-reported type is empty (common for `.md` and `.csv`) still declares one.
 */
const TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
};

const ADMITTED_TYPES: ReadonlySet<string> = new Set(Object.values(TYPE_BY_EXTENSION));

/** The `accept` attribute for the file input: every admitted extension and type. */
export const ATTACHMENT_ACCEPT = [
  ...Object.keys(TYPE_BY_EXTENSION).map((extension) => `.${extension}`),
  ...ADMITTED_TYPES,
].join(',');

/** A human list of the admitted kinds, for the hint under the picker. */
export const ATTACHMENT_KINDS_LABEL =
  'PDF, images (PNG, JPEG, GIF, WebP), Word, Excel, PowerPoint, ZIP, text, CSV or Markdown';

/** The minimal file facts these checks read — `File` has them, and a test can fake them. */
export interface AttachmentFileInput {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

/**
 * The media type to declare for a file, or `null` when it is not one the verifier admits. The
 * browser's own type wins when it is admitted; otherwise the extension decides.
 */
export function attachmentMimeType(file: AttachmentFileInput): string | null {
  const reported = file.type.trim().toLowerCase();
  if (ADMITTED_TYPES.has(reported)) return reported;
  const dot = file.name.lastIndexOf('.');
  if (dot === -1) return null;
  return TYPE_BY_EXTENSION[file.name.slice(dot + 1).toLowerCase()] ?? null;
}

/** Why a file cannot be attached, in a sentence — or `null` when it can. */
export function attachmentProblem(file: AttachmentFileInput): string | null {
  if (file.size < 1) return `“${file.name}” is empty.`;
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `“${file.name}” is larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}.`;
  }
  if (/[/\\]/.test(file.name)) return `“${file.name}” has a name that cannot be used.`;
  if (attachmentMimeType(file) === null) {
    return `“${file.name}” is not a file type TManage accepts.`;
  }
  return null;
}

/** `1.2 MB`-style sizes for the chips and messages. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes >= 10 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`;
}

interface UploadSessionReply {
  readonly id: string;
  readonly fileAssetId: string;
  readonly partSizeBytes: number;
  readonly uploadUrls: readonly { readonly partNumber: number; readonly url: string }[];
}

interface UploadedAssetReply {
  readonly id: string;
  readonly status: string;
}

/**
 * Every step has a deadline, so a request that never settles ends in the screen's error state
 * instead of an endless "Attaching…" (wave 17). A JSON step (open, cancel, attach) gets 30 s.
 */
export const UPLOAD_STEP_TIMEOUT_MS = 30_000;

/** `complete` assembles every part on the server before it answers, so it gets two minutes. */
export const UPLOAD_COMPLETE_TIMEOUT_MS = 120_000;

/**
 * A byte transfer (one part, or a whole file to Google): a minute plus the time it takes at
 * 32 KB/s. Measured on live 2026-10-26: an 8 MiB part took ~50 s at ~170 KB/s, so a slow line
 * still finishes and only a true stall is cut.
 */
export function transferTimeoutMs(bytes: number): number {
  return 60_000 + Math.ceil(bytes / 32_768) * 1_000;
}

export interface UploadAttachmentOptions {
  /** The fetch the part PUTs use. Injectable so a test sees exactly what is sent. */
  readonly fetch?: typeof globalThis.fetch;
  /** A fresh `Idempotency-Key` (16–128 of `[A-Za-z0-9_-]`). */
  readonly newKey?: () => string;
  /** The signal that aborts a step after `ms`. Injectable so a test need not wait. */
  readonly deadline?: (ms: number) => AbortSignal;
  /** Bytes of this file sent so far, summed over every part (Figma 409:6602). */
  readonly onProgress?: (sentBytes: number) => void;
  /** The row's Cancel: aborts whatever step is running and ends in `UploadCancelledError`. */
  readonly signal?: AbortSignal;
}

/** The upload was cancelled by the person, not stopped by a fault; the screen drops its row. */
export class UploadCancelledError extends Error {
  constructor() {
    super('upload_cancelled');
    this.name = 'UploadCancelledError';
  }
}

/** A `fetch` that may also report the bytes its body has sent (`xhrFetch` does). */
type ProgressFetch = (
  url: string,
  init: RequestInit & { readonly onUploadProgress?: (loaded: number) => void },
) => Promise<Response>;

/**
 * `fetch` over `XMLHttpRequest`, because only XHR reports upload progress (`upload.onprogress`).
 * Same contract as `fetch` for what this file sends: method, headers, a Blob or string body,
 * `credentials`, an abort `signal`; it rejects with a `TypeError` on a network failure.
 */
export const xhrFetch: ProgressFetch = (url, init) =>
  new Promise<Response>((resolve, reject) => {
    const signal = init.signal ?? undefined;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open(init.method ?? 'GET', url);
    xhr.withCredentials = init.credentials === 'include';
    new Headers(init.headers).forEach((value, name) => xhr.setRequestHeader(name, value));
    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const settle = () => signal?.removeEventListener('abort', onAbort);
    if (init.onUploadProgress) {
      const report = init.onUploadProgress;
      xhr.upload.onprogress = (event) => report(event.loaded);
    }
    xhr.onload = () => {
      settle();
      const headers = new Headers();
      for (const line of xhr
        .getAllResponseHeaders()
        .trim()
        .split(/[\r\n]+/)) {
        const colon = line.indexOf(':');
        if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
      }
      const empty = xhr.status === 204 || xhr.status === 304;
      resolve(new Response(empty ? null : xhr.responseText, { status: xhr.status, headers }));
    };
    xhr.onerror = () => {
      settle();
      reject(new TypeError('Failed to fetch'));
    };
    xhr.onabort = () => {
      settle();
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    xhr.send((init.body ?? null) as XMLHttpRequestBodyInit | null);
  });

/**
 * One figure for a file sent in several requests: each request reports its own bytes, and the
 * file's progress is their sum (requests go one after another, each slice once), capped at the
 * file's size.
 */
export function createProgressTracker(
  totalBytes: number,
  report: (sentBytes: number) => void,
): { request(): (loaded: number) => void } {
  const loaded: number[] = [];
  return {
    request() {
      const index = loaded.push(0) - 1;
      return (bytes) => {
        loaded[index] = Math.max(loaded[index] ?? 0, bytes);
        report(
          Math.min(
            totalBytes,
            loaded.reduce((sum, value) => sum + value, 0),
          ),
        );
      };
    },
  };
}

/** A signal that aborts when any of `signals` does. */
function anySignal(...signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/**
 * The PUT every byte transfer goes through: XHR when a screen shows progress (only XHR reports
 * it), else `fetch` — the injected one (a test's) wins, and reports a request's bytes once it
 * answers. Each request also stops on the person's Cancel and on its own deadline.
 */
function progressPut(
  deps: UploadAttachmentOptions,
  totalBytes: number,
  deadlineFor: (body: unknown) => AbortSignal | undefined,
): typeof globalThis.fetch {
  const send: ProgressFetch =
    deps.fetch ??
    (deps.onProgress && typeof XMLHttpRequest === 'function'
      ? xhrFetch
      : globalThis.fetch.bind(globalThis));
  const tracker = createProgressTracker(totalBytes, deps.onProgress ?? (() => undefined));
  return async (input, init = {}) => {
    const report = tracker.request();
    const body = init.body;
    const response = await send(String(input), {
      ...init,
      // A body-less request (OneDrive's clean-up DELETE) must still run after a Cancel.
      signal: anySignal(
        deadlineFor(body),
        init.signal ?? undefined,
        body ? deps.signal : undefined,
      ),
      onUploadProgress: report,
    });
    if (response.ok && body instanceof Blob) report(body.size);
    return response;
  };
}

/** Rethrow as `UploadCancelledError` when the person cancelled, else as it came. */
function cancelledOr(error: unknown, signal: AbortSignal | undefined): unknown {
  return signal?.aborted ? new UploadCancelledError() : error;
}

function defaultDeadline(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

function defaultKey(): string {
  const cryptoRef = globalThis.crypto as Crypto | undefined;
  if (cryptoRef?.randomUUID) return `wa-${cryptoRef.randomUUID()}`;
  return `wa-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e12).toString(36)}`;
}

function orgBase(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}`;
}

/**
 * Upload one file into a project and answer the new file asset's id. A failure after the session
 * opened cancels it, so the reservation is released rather than left for the sweeper.
 */
export async function uploadProjectFile(
  client: ApiClient,
  organizationSlug: string,
  input: { readonly projectId: string; readonly file: Blob & AttachmentFileInput },
  deps: UploadAttachmentOptions = {},
): Promise<string> {
  // The internal purpose for a project's own files; `internal` audience by default, so an
  // attachment is never shown to a client by being uploaded.
  return runUpload(
    client,
    `${orgBase(organizationSlug)}/upload-sessions`,
    { projectId: input.projectId, purpose: 'deliverable' },
    input.file,
    deps,
  );
}

/**
 * A8. A client's file for a message on their own request, through the portal upload session:
 * purpose `request_message` (0232) with the request as `objectId`, so the API binds the file to
 * that request and to the client's organization before the message names it, and the request's
 * own attachment list does not pick it up.
 */
export async function uploadPortalRequestFile(
  client: ApiClient,
  organizationSlug: string,
  input: {
    readonly projectId: string;
    readonly requestId: string;
    readonly file: Blob & AttachmentFileInput;
  },
  deps: UploadAttachmentOptions = {},
): Promise<string> {
  return runUpload(
    client,
    `${orgBase(organizationSlug)}/portal/upload-sessions`,
    { projectId: input.projectId, purpose: 'request_message', objectId: input.requestId },
    input.file,
    deps,
  );
}

async function runUpload(
  client: ApiClient,
  sessionsPath: string,
  target: Readonly<Record<string, string>>,
  file: Blob & AttachmentFileInput,
  deps: UploadAttachmentOptions,
): Promise<string> {
  const mimeType = attachmentMimeType(file);
  if (mimeType === null) throw new Error(`“${file.name}” is not a file type TManage accepts.`);
  const deadline = deps.deadline ?? defaultDeadline;
  const send = progressPut(deps, file.size, (body) =>
    deadline(transferTimeoutMs(body instanceof Blob ? body.size : 0)),
  );
  const step = (ms: number) => anySignal(deadline(ms), deps.signal);

  const { data: session } = await client
    .request<UploadSessionReply>({
      method: 'POST',
      path: sessionsPath,
      signal: step(UPLOAD_STEP_TIMEOUT_MS),
      headers: { 'idempotency-key': (deps.newKey ?? defaultKey)() },
      body: {
        ...target,
        fileName: file.name,
        mimeType,
        sizeBytes: file.size,
      },
    })
    .catch((error: unknown) => {
      throw cancelledOr(error, deps.signal);
    });

  try {
    const parts: { partNumber: number; etag: string }[] = [];
    for (const target of [...session.uploadUrls].sort((a, b) => a.partNumber - b.partNumber)) {
      const start = (target.partNumber - 1) * session.partSizeBytes;
      const chunk = file.slice(start, start + session.partSizeBytes);
      let response: Response;
      try {
        response = await send(target.url, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: chunk,
          // The part token authorises the PUT; the session cookie must not travel with it.
          credentials: 'omit',
        });
      } catch (cause) {
        if (deps.signal?.aborted) throw new UploadCancelledError();
        throw new NetworkError(`“${file.name}” did not reach TManage.`, cause);
      }
      const etag = response.headers.get('etag');
      if (!response.ok || !etag) {
        throw new Error(`“${file.name}” could not be uploaded (part ${target.partNumber}).`);
      }
      parts.push({ partNumber: target.partNumber, etag });
    }

    const { data: asset } = await client.request<UploadedAssetReply>({
      method: 'POST',
      path: `${sessionsPath}/${encodeURIComponent(session.id)}/complete`,
      body: { parts },
      signal: step(UPLOAD_COMPLETE_TIMEOUT_MS),
    });
    return asset.id;
  } catch (error) {
    await client
      .request<unknown>({
        method: 'POST',
        path: `${sessionsPath}/${encodeURIComponent(session.id)}/cancel`,
        signal: deadline(UPLOAD_STEP_TIMEOUT_MS),
      })
      .catch(() => undefined);
    throw cancelledOr(error, deps.signal);
  }
}

/** Where a new attachment goes (B, 0236): the row's "To Google Drive" / "To OneDrive" note. */
export type UploadDestination = 'tmanage' | 'google_drive' | 'onedrive';

export function uploadDestination(
  storage: StorageStatusView | undefined,
  oneDrive: OneDriveStatusView | undefined,
): UploadDestination {
  if (uploadsGoToOneDrive(oneDrive)) return 'onedrive';
  if (uploadsGoToDrive(storage)) return 'google_drive';
  return 'tmanage';
}

/**
 * B. Whether a new attachment goes to Google Drive: the company's storage is `google_drive`
 * (Control > Storage, migration 0210) and Drive is connected. Anything else — TManage storage,
 * another provider, Drive in error, or the status not read yet — keeps the TManage upload.
 */
export function uploadsGoToDrive(status: StorageStatusView | undefined): boolean {
  return status?.storageMode === 'google_drive' && status.googleDrive.status === 'connected';
}

/** Reject with a `NetworkError` once `signal` aborts, whatever `work` is still waiting on. */
function settleBy<T>(work: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
  const stalled = new Promise<never>((_, reject) => {
    const fail = () => reject(new NetworkError(message));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
  return Promise.race([work, stalled]);
}

/**
 * Upload a file for a work item to where the company keeps files: Google Drive through the
 * existing `uploadToDrive` (the bytes go straight to Google, the file is then attached as a Drive
 * attachment), OneDrive the same way through `uploadToOneDrive` (0236), or TManage storage,
 * attached as an item file.
 */
export async function uploadWorkItemAttachment(
  client: ApiClient,
  organizationSlug: string,
  input: {
    readonly workItemId: string;
    readonly projectId: string;
    readonly file: File;
    readonly storage: StorageStatusView | undefined;
    /** 0236. OneDrive's status; OneDrive takes the upload when it is the company's storage. */
    readonly oneDrive?: OneDriveStatusView | undefined;
  },
  deps: UploadAttachmentOptions = {},
): Promise<
  | { readonly kind: 'onedrive'; readonly attachment: OneDriveAttachmentView }
  | { readonly kind: 'google_drive'; readonly attachment: DriveAttachmentView }
  | { readonly kind: 'tmanage'; readonly file: ItemFile }
> {
  const deadline = deps.deadline ?? defaultDeadline;
  const destination = uploadDestination(input.storage, input.oneDrive);
  if (destination !== 'tmanage') {
    const transfer = transferTimeoutMs(input.file.size);
    const put = progressPut(deps, input.file.size, () => deadline(transfer));
    const within = anySignal(deadline(2 * UPLOAD_STEP_TIMEOUT_MS + transfer), deps.signal);
    try {
      if (destination === 'onedrive') {
        const attachment = await settleBy(
          uploadToOneDrive(client, organizationSlug, input.workItemId, input.file, put),
          within,
          `“${input.file.name}” did not reach OneDrive.`,
        );
        return { kind: 'onedrive', attachment };
      }
      const attachment = await settleBy(
        uploadToDrive(client, organizationSlug, input.workItemId, input.file, put),
        within,
        `“${input.file.name}” did not reach Google Drive.`,
      );
      return { kind: 'google_drive', attachment };
    } catch (error) {
      throw cancelledOr(error, deps.signal);
    }
  }
  const fileAssetId = await uploadProjectFile(
    client,
    organizationSlug,
    { projectId: input.projectId, file: input.file },
    deps,
  );
  const file = await settleBy(
    attachWorkItemFile(client, organizationSlug, input.workItemId, { fileAssetId }),
    deadline(UPLOAD_STEP_TIMEOUT_MS),
    `“${input.file.name}” was not attached.`,
  );
  return { kind: 'tmanage', file };
}
