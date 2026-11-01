import type { PrincipalKind } from '@tmanage/domain';
import type { UploadPurpose } from '../../common/database/schema.js';

/**
 * Which purposes which kind of principal may upload for.
 *
 * **No document states this table.** `openapi.yaml` defines the four purposes and nothing in
 * the pack maps them to roles, so the rows below are a decision this slice is taking, in
 * the deny-by-default direction, and are recorded as such in docs/implementation-status.md
 * for the owner to overturn:
 *
 * | purpose              | internal | client                                              |
 * | -------------------- | -------- | --------------------------------------------------- |
 * | `request_attachment` | yes      | yes — CL-06 lists "files" on the request form       |
 * | `request_message`    | yes      | yes — a file sent with a reply on a request (0232)  |
 * | `message_attachment` | yes      | no — a client posts no messages yet (CHAT-001)      |
 * | `deliverable`        | yes      | no — `12-PERMISSION-MATRIX` gives no client role    |
 * |                      |          | "Publish to client"; a client does not deliver      |
 * | `document`           | no       | no — Docs is deferred past the vertical slice (`13`) |
 *
 * `document` refused for everyone means the enum member exists in the contract without a
 * live path, which is the honest state of a module nobody has built.
 */
const PERMITTED: Readonly<Record<PrincipalKind, readonly UploadPurpose[]>> = {
  // `org_logo` (A11, 0224): the organization's logo. The route that sets it is `org.manage`.
  internal: [
    'request_attachment',
    'message_attachment',
    'deliverable',
    'org_logo',
    'request_message',
  ],
  client: ['request_attachment', 'request_message'],
  // A service principal never uploads through the API; the worker writes versions directly.
  service: [],
};

export function mayUploadFor(kind: PrincipalKind, purpose: UploadPurpose): boolean {
  return PERMITTED[kind].includes(purpose);
}

/**
 * FILE-002 slice C. Which purposes which kind of principal may **download**. Again no
 * document states the table; the decision, deny-by-default and recorded in
 * docs/implementation-status.md (slice C, decision D3):
 *
 * | purpose              | internal | client                                                    |
 * | -------------------- | -------- | --------------------------------------------------------- |
 * | `request_attachment` | yes      | yes — their own request's files, held to the request row  |
 * | `request_message`    | yes      | yes — reply files on their own request, held the same way |
 * | `message_attachment` | yes      | no — a client reads no messages yet (CHAT-001)            |
 * | `deliverable`        | yes      | only when published — R4 slice 4 (see below)              |
 * | `document`           | no       | no — Docs is deferred                                     |
 *
 * R4 slice 4 supplies the published fact a client `deliverable` download waited for (CL-05): the
 * purpose is admitted here, and {@link FileClientRelation} then holds it to a deliverable version
 * with a `client_projections` row (or a client-audience file of a published deliverable). This
 * table only says which purposes are worth asking about; it never grants reach on its own.
 *
 * A service principal downloads nothing through the API: a job opens the store directly.
 */
const DOWNLOADABLE: Readonly<Record<PrincipalKind, readonly UploadPurpose[]>> = {
  internal: [
    'request_attachment',
    'message_attachment',
    'deliverable',
    'org_logo',
    'request_message',
  ],
  client: ['request_attachment', 'request_message', 'deliverable'],
  service: [],
};

export function mayDownloadFor(kind: PrincipalKind, purpose: UploadPurpose): boolean {
  return DOWNLOADABLE[kind].includes(purpose);
}

/**
 * The purposes whose `objectId` must name an existing row, and which table it names. A reply file
 * (`request_message`, 0232) is bound to its request exactly as a request-form file is.
 */
export function objectTableFor(purpose: UploadPurpose): 'client_requests' | null {
  return purpose === 'request_attachment' || purpose === 'request_message'
    ? 'client_requests'
    : null;
}

/** The purposes a file may carry to be attached to a message on a client request (A8). */
export const REQUEST_MESSAGE_FILE_PURPOSES: readonly UploadPurpose[] = [
  'request_message',
  // Uploads from before 0232 (and ones reserved just before a deploy) still attach and list.
  'request_attachment',
];
