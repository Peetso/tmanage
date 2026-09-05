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
 * | `message_attachment` | yes      | no — a client posts no messages yet (CHAT-001)      |
 * | `deliverable`        | yes      | no — `12-PERMISSION-MATRIX` gives no client role    |
 * |                      |          | "Publish to client"; a client does not deliver      |
 * | `document`           | no       | no — Docs is deferred past the vertical slice (`13`) |
 *
 * `document` refused for everyone means the enum member exists in the contract without a
 * live path, which is the honest state of a module nobody has built.
 */
const PERMITTED: Readonly<Record<PrincipalKind, readonly UploadPurpose[]>> = {
  internal: ['request_attachment', 'message_attachment', 'deliverable'],
  client: ['request_attachment'],
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
 * | `message_attachment` | yes      | no — a client reads no messages yet (CHAT-001)            |
 * | `deliverable`        | yes      | no — until DEL-001 supplies the published fact (CL-05)    |
 * | `document`           | no       | no — Docs is deferred                                     |
 *
 * A service principal downloads nothing through the API: a job opens the store directly.
 */
const DOWNLOADABLE: Readonly<Record<PrincipalKind, readonly UploadPurpose[]>> = {
  internal: ['request_attachment', 'message_attachment', 'deliverable'],
  client: ['request_attachment'],
  service: [],
};

export function mayDownloadFor(kind: PrincipalKind, purpose: UploadPurpose): boolean {
  return DOWNLOADABLE[kind].includes(purpose);
}

/** The purposes whose `objectId` must name an existing row, and which table it names. */
export function objectTableFor(purpose: UploadPurpose): 'client_requests' | null {
  return purpose === 'request_attachment' ? 'client_requests' : null;
}
