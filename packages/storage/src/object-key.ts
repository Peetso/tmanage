/**
 * The object-key layout — `49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY` §4:
 *
 *     tenant/{organization_uuid}/project/{project_uuid}/upload/{upload_uuid}/part-or-object
 *
 * Built here and nowhere else, from identifiers that are checked to be UUIDs before they
 * are joined. The check is the point: a key is a path, and a component that is not a UUID
 * — `..`, a slash, an empty string — would compose a key outside the tenant's prefix. The
 * prefix is what a per-tenant lifecycle rule or a per-tenant inventory walk keys on, so a
 * key that escapes it is a file that never counts and is never cleaned up.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class InvalidObjectKeyComponentError extends Error {
  constructor(readonly component: string) {
    // The value itself is not repeated: it is exactly the thing that failed to look like
    // an identifier, and may be anything.
    super(`object key component ${component} is not a lowercase UUID`);
    this.name = 'InvalidObjectKeyComponentError';
  }
}

export interface UploadObjectKeyInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly uploadId: string;
}

function requireUuid(name: string, value: string): string {
  if (!UUID.test(value)) throw new InvalidObjectKeyComponentError(name);
  return value;
}

/** The key an upload's object lives under, in whichever zone the caller names. */
export function uploadObjectKey(input: UploadObjectKeyInput): string {
  const organizationId = requireUuid('organizationId', input.organizationId);
  const projectId = requireUuid('projectId', input.projectId);
  const uploadId = requireUuid('uploadId', input.uploadId);
  return `tenant/${organizationId}/project/${projectId}/upload/${uploadId}/object`;
}
