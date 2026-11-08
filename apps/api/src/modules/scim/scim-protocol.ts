import { createHash, randomBytes } from 'node:crypto';
import { constantTimeEquals } from '../identity/session-token.js';

/**
 * 54-16 — SCIM 2.0 (RFC 7643 / RFC 7644), the protocol half. Nothing here touches the database.
 *
 * - **Bearer keys**: `tmanage_scim_<43 base64url>`; only the SHA-256 hex is stored. A key names
 *   exactly one organization, so the tenant always comes from the key and never from the request.
 * - **Filters**: one comparison, `<attribute> eq|sw "<JSON string>"`, on an allow-listed attribute.
 *   Anything else is `400 invalidFilter`. The value is decoded with `JSON.parse` and later bound
 *   as a parameter (with `LIKE` wildcards escaped for `sw`), so it is data and never SQL.
 * - **PATCH**: RFC 7644 §3.5.2 operations on the attributes this server keeps.
 */

export const SCIM_CONTENT_TYPE = 'application/scim+json';
export const SCIM_BASE_PATH = '/v1/scim/v2';
export const SCHEMA_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCHEMA_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCHEMA_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCHEMA_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCHEMA_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCHEMA_SPC = 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig';
export const SCHEMA_RESOURCE_TYPE = 'urn:ietf:params:scim:schemas:core:2.0:ResourceType';
export const SCHEMA_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Schema';

export const SCIM_KEY_PREFIX = 'tmanage_scim_';
export const SCIM_MAX_RESULTS = 200;
const MAX_FILTER_LENGTH = 512;
const MAX_VALUE_LENGTH = 254;

export type ScimErrorType =
  | 'invalidFilter'
  | 'invalidValue'
  | 'invalidSyntax'
  | 'invalidPath'
  | 'mutability'
  | 'uniqueness'
  | 'tooMany'
  | 'noTarget';

/** A SCIM error response (RFC 7644 §3.12). `detail` is fixed text, never the request echoed. */
export class ScimError extends Error {
  override name = 'ScimError';
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly scimType?: ScimErrorType,
  ) {
    super(detail);
  }

  body(): Record<string, unknown> {
    return {
      schemas: [SCHEMA_ERROR],
      status: String(this.status),
      ...(this.scimType ? { scimType: this.scimType } : {}),
      detail: this.detail,
    };
  }
}

export const scimNotFound = (): ScimError => new ScimError(404, 'Resource not found.');
export const scimUnauthorized = (): ScimError => new ScimError(401, 'Authorization failed.');

// ── Bearer keys ──────────────────────────────────────────────────────────────

export function newScimKey(): {
  readonly secret: string;
  readonly hash: string;
  readonly prefix: string;
} {
  const secret = `${SCIM_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { secret, hash: hashScimKey(secret), prefix: secret.slice(0, SCIM_KEY_PREFIX.length + 6) };
}

export function hashScimKey(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** The key from `Authorization: Bearer …`, or undefined when absent or not shaped like one. */
export function readScimBearer(header: unknown): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer[ ]+(\S+)$/u.exec(header.trim());
  const secret = match?.[1];
  if (!secret?.startsWith(SCIM_KEY_PREFIX)) return undefined;
  return /^[A-Za-z0-9_-]{43}$/u.test(secret.slice(SCIM_KEY_PREFIX.length)) ? secret : undefined;
}

/** Defence in depth after the indexed lookup: the stored hash must equal the presented one. */
export function scimHashMatches(stored: string, presented: string): boolean {
  return constantTimeEquals(stored, presented);
}

// ── Filters ──────────────────────────────────────────────────────────────────

export type ScimFilterField = 'email' | 'displayName';

export interface ScimFilter {
  readonly field: ScimFilterField;
  readonly op: 'eq' | 'sw';
  readonly value: string;
}

const USER_FILTER_FIELDS: Readonly<Record<string, ScimFilterField>> = {
  username: 'email',
  emails: 'email',
  'emails.value': 'email',
};
const GROUP_FILTER_FIELDS: Readonly<Record<string, ScimFilterField>> = {
  displayname: 'displayName',
};

const FILTER_PATTERN = /^\s*([A-Za-z][A-Za-z0-9.]*)\s+(eq|sw)\s+("(?:[^"\\]|\\.)*")\s*$/iu;

/** Parse `?filter=`; undefined when absent. Throws `invalidFilter` for anything else. */
export function parseScimFilter(raw: unknown, resource: 'User' | 'Group'): ScimFilter | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || raw.length > MAX_FILTER_LENGTH) throw invalidFilter();
  const match = FILTER_PATTERN.exec(raw);
  if (!match) throw invalidFilter();
  const fields = resource === 'User' ? USER_FILTER_FIELDS : GROUP_FILTER_FIELDS;
  const field = fields[match[1]!.toLowerCase()];
  if (!field) throw invalidFilter();
  let value: unknown;
  try {
    value = JSON.parse(match[3]!);
  } catch {
    throw invalidFilter();
  }
  if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH || hasControlCharacter(value)) {
    throw invalidFilter();
  }
  return {
    field,
    op: match[2]!.toLowerCase() as 'eq' | 'sw',
    value: field === 'email' ? value.trim().toLowerCase() : value.trim(),
  };
}

function invalidFilter(): ScimError {
  return new ScimError(400, 'The filter is not supported.', 'invalidFilter');
}

/** A `LIKE` prefix pattern with the wildcards and the escape character escaped. */
export function likePrefix(value: string): string {
  return `${value.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;
}

export interface ScimPage {
  readonly startIndex: number;
  readonly count: number;
}

/** `startIndex` (1-based) and `count`, clamped (RFC 7644 §3.4.2.4). */
export function parseScimPage(query: Record<string, unknown>): ScimPage {
  const int = (value: unknown, fallback: number) => {
    const n = typeof value === 'string' && /^-?\d{1,9}$/u.test(value) ? Number(value) : fallback;
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    startIndex: Math.max(1, int(query['startIndex'], 1)),
    count: Math.min(SCIM_MAX_RESULTS, Math.max(0, int(query['count'], 100))),
  };
}

export function listResponse(
  resources: readonly unknown[],
  total: number,
  page: ScimPage,
): Record<string, unknown> {
  return {
    schemas: [SCHEMA_LIST],
    totalResults: total,
    startIndex: page.startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

// ── Resources ────────────────────────────────────────────────────────────────

export interface ScimUserRecord {
  readonly membershipId: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly groups: readonly { readonly id: string; readonly name: string }[];
}

export interface ScimGroupRecord {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly members: readonly { readonly membershipId: string; readonly email: string }[];
}

/** Invited and active people are provisioned; suspended people are `active: false`. */
export function isScimActive(status: string): boolean {
  return status === 'active' || status === 'invited';
}

export function userResource(record: ScimUserRecord, base: string): Record<string, unknown> {
  return {
    schemas: [SCHEMA_USER],
    id: record.membershipId,
    userName: record.email,
    name: { formatted: record.displayName },
    displayName: record.displayName,
    emails: [{ value: record.email, type: 'work', primary: true }],
    active: isScimActive(record.status),
    groups: record.groups.map((group) => ({
      value: group.id,
      display: group.name,
      $ref: `${base}/Groups/${group.id}`,
    })),
    meta: {
      resourceType: 'User',
      created: record.createdAt.toISOString(),
      lastModified: record.updatedAt.toISOString(),
      location: `${base}/Users/${record.membershipId}`,
    },
  };
}

export function groupResource(record: ScimGroupRecord, base: string): Record<string, unknown> {
  return {
    schemas: [SCHEMA_GROUP],
    id: record.id,
    displayName: record.name,
    members: record.members.map((member) => ({
      value: member.membershipId,
      display: member.email,
      $ref: `${base}/Users/${member.membershipId}`,
    })),
    meta: {
      resourceType: 'Group',
      created: record.createdAt.toISOString(),
      lastModified: record.createdAt.toISOString(),
      location: `${base}/Groups/${record.id}`,
    },
  };
}

// ── Request bodies ───────────────────────────────────────────────────────────

const objectOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** SCIM booleans arrive as `false` and, from some providers, as `"False"`. */
export function scimBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && /^(true|false)$/iu.test(value)) {
    return value.toLowerCase() === 'true';
  }
  return undefined;
}

/** C0 controls and DEL, checked by code point (no control characters in a regex literal). */
function hasControlCharacter(value: string): boolean {
  for (const c of value) {
    const code = c.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function cleanName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = [...value]
    .filter((c) => !hasControlCharacter(c))
    .join('')
    .trim();
  return name === '' ? undefined : name.slice(0, 190);
}

function nameOf(body: Record<string, unknown>): string | undefined {
  const name = objectOf(body['name']);
  const joined = [name['givenName'], name['familyName']]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' ');
  return cleanName(body['displayName']) ?? cleanName(name['formatted']) ?? cleanName(joined);
}

function primaryEmail(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.map(objectOf);
  const chosen = entries.find((entry) => entry['primary'] === true) ?? entries[0];
  return typeof chosen?.['value'] === 'string' ? chosen['value'].trim().toLowerCase() : undefined;
}

export interface ScimUserInput {
  readonly email: string;
  readonly displayName: string | undefined;
  readonly active: boolean | undefined;
}

/** POST / PUT body: `userName` is the address; `emails` must agree with it when present. */
export function parseUserBody(body: unknown): ScimUserInput {
  const input = objectOf(body);
  const userName =
    typeof input['userName'] === 'string' ? input['userName'].trim().toLowerCase() : '';
  const email = userName || primaryEmail(input['emails']) || '';
  if (!/^[^\s@]{1,64}@[^\s@]{3,189}$/u.test(email)) {
    throw new ScimError(400, 'userName must be an e-mail address.', 'invalidValue');
  }
  const listed = primaryEmail(input['emails']);
  if (listed !== undefined && listed !== email) {
    throw new ScimError(400, 'The primary e-mail must equal userName.', 'invalidValue');
  }
  const active = input['active'] === undefined ? undefined : scimBoolean(input['active']);
  if (input['active'] !== undefined && active === undefined) {
    throw new ScimError(400, 'active must be true or false.', 'invalidValue');
  }
  return { email, displayName: nameOf(input), active };
}

export interface ScimUserPatch {
  active?: boolean;
  displayName?: string;
  /** An address the provider wants; the service refuses a change of address. */
  email?: string;
}

export interface ScimPatchOperation {
  readonly op: 'add' | 'replace' | 'remove';
  readonly path: string | undefined;
  readonly value: unknown;
}

export function parsePatchOperations(body: unknown): readonly ScimPatchOperation[] {
  const input = objectOf(body);
  const schemas = input['schemas'];
  const operations = input['Operations'];
  if (!Array.isArray(schemas) || !schemas.includes(SCHEMA_PATCH) || !Array.isArray(operations)) {
    throw new ScimError(400, 'The body is not a PatchOp.', 'invalidSyntax');
  }
  if (operations.length === 0 || operations.length > 100) {
    throw new ScimError(400, 'A PatchOp holds 1 to 100 operations.', 'invalidSyntax');
  }
  return operations.map((raw) => {
    const operation = objectOf(raw);
    const op = typeof operation['op'] === 'string' ? operation['op'].toLowerCase() : '';
    if (op !== 'add' && op !== 'replace' && op !== 'remove') {
      throw new ScimError(400, 'op must be add, replace or remove.', 'invalidSyntax');
    }
    const path = typeof operation['path'] === 'string' ? operation['path'].trim() : undefined;
    return { op, path: path === '' ? undefined : path, value: operation['value'] };
  });
}

/** `members[value eq "id"]` → `id`; `members` → undefined; anything else → null (not members). */
function memberFilterPath(path: string): string | undefined | null {
  if (path.toLowerCase() === 'members') return undefined;
  const match = /^members\[\s*value\s+eq\s+("(?:[^"\\]|\\.)*")\s*\]$/iu.exec(path);
  if (!match) return null;
  try {
    const id = JSON.parse(match[1]!) as unknown;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

function memberIds(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return list.map((entry) => {
    const id = objectOf(entry)['value'];
    if (typeof id !== 'string' || id === '') {
      throw new ScimError(400, 'Each member needs a value.', 'invalidValue');
    }
    return id;
  });
}

export function parseUserPatch(body: unknown): ScimUserPatch {
  const patch: ScimUserPatch = {};
  const apply = (path: string, value: unknown, op: ScimPatchOperation['op']) => {
    const key = path.toLowerCase();
    if (op === 'remove') {
      throw new ScimError(400, 'This attribute cannot be removed.', 'mutability');
    }
    if (key === 'active') {
      const active = scimBoolean(value);
      if (active === undefined)
        throw new ScimError(400, 'active must be true or false.', 'invalidValue');
      patch.active = active;
    } else if (
      key === 'displayname' ||
      key === 'name.formatted' ||
      key === 'name.givenname' ||
      key === 'name.familyname'
    ) {
      const name = cleanName(value);
      if (name !== undefined) patch.displayName = name;
    } else if (key === 'name') {
      const name = nameOf({ name: value });
      if (name !== undefined) patch.displayName = name;
    } else if (key === 'username') {
      if (typeof value === 'string') patch.email = value.trim().toLowerCase();
    } else if (key === 'emails' || /^emails\[.*\]\.value$/iu.test(path)) {
      const email = typeof value === 'string' ? value.trim().toLowerCase() : primaryEmail(value);
      if (email !== undefined) patch.email = email;
    } else if (key === 'externalid' || key.startsWith('urn:')) {
      // Kept by the provider, not here; accepted so a provider's routine update does not fail.
    } else {
      throw new ScimError(400, 'The path is not supported.', 'invalidPath');
    }
  };
  for (const operation of parsePatchOperations(body)) {
    if (operation.path === undefined) {
      if (operation.op === 'remove') throw new ScimError(400, 'remove needs a path.', 'noTarget');
      for (const [path, value] of Object.entries(objectOf(operation.value))) {
        apply(path, value, operation.op);
      }
      continue;
    }
    apply(operation.path, operation.value, operation.op);
  }
  return patch;
}

export interface ScimGroupPatch {
  displayName?: string;
  /** `replace members` sets the whole list. */
  replaceMembers?: string[];
  readonly addMembers: string[];
  readonly removeMembers: string[];
}

export function parseGroupPatch(body: unknown): ScimGroupPatch {
  const patch: ScimGroupPatch = { addMembers: [], removeMembers: [] };
  for (const operation of parsePatchOperations(body)) {
    const path = operation.path;
    if (path === undefined) {
      const value = objectOf(operation.value);
      if (operation.op === 'remove') throw new ScimError(400, 'remove needs a path.', 'noTarget');
      if (value['displayName'] !== undefined) patch.displayName = groupName(value['displayName']);
      if (value['members'] !== undefined) {
        if (operation.op === 'replace') patch.replaceMembers = memberIds(value['members']);
        else patch.addMembers.push(...memberIds(value['members']));
      }
      continue;
    }
    if (path.toLowerCase() === 'displayname') {
      if (operation.op === 'remove')
        throw new ScimError(400, 'displayName is required.', 'mutability');
      patch.displayName = groupName(operation.value);
      continue;
    }
    const target = memberFilterPath(path);
    if (target === null) throw new ScimError(400, 'The path is not supported.', 'invalidPath');
    if (operation.op === 'remove') {
      if (target !== undefined) patch.removeMembers.push(target);
      else if (operation.value === undefined) patch.replaceMembers = [];
      else patch.removeMembers.push(...memberIds(operation.value));
    } else if (operation.op === 'replace' && target === undefined) {
      patch.replaceMembers = memberIds(operation.value);
    } else {
      patch.addMembers.push(...memberIds(operation.value));
    }
  }
  return patch;
}

export function groupName(value: unknown): string {
  const name = cleanName(value);
  if (name === undefined || name.length > 120) {
    throw new ScimError(400, 'displayName must be 1 to 120 characters.', 'invalidValue');
  }
  return name;
}

export interface ScimGroupInput {
  readonly displayName: string;
  readonly members: string[];
}

export function parseGroupBody(body: unknown): ScimGroupInput {
  const input = objectOf(body);
  return {
    displayName: groupName(input['displayName']),
    members: input['members'] === undefined ? [] : memberIds(input['members']),
  };
}

// ── Discovery ────────────────────────────────────────────────────────────────

export function serviceProviderConfig(base: string): Record<string, unknown> {
  return {
    schemas: [SCHEMA_SPC],
    documentationUri: `${base}/ServiceProviderConfig`,
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: SCIM_MAX_RESULTS },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'Bearer key',
        description: 'A provisioning key created by the company owner in Admin > Security.',
        primary: true,
      },
    ],
    meta: { resourceType: 'ServiceProviderConfig', location: `${base}/ServiceProviderConfig` },
  };
}

export function resourceTypes(base: string): Record<string, unknown>[] {
  return [
    {
      schemas: [SCHEMA_RESOURCE_TYPE],
      id: 'User',
      name: 'User',
      endpoint: '/Users',
      schema: SCHEMA_USER,
      meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/User` },
    },
    {
      schemas: [SCHEMA_RESOURCE_TYPE],
      id: 'Group',
      name: 'Group',
      endpoint: '/Groups',
      schema: SCHEMA_GROUP,
      meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/Group` },
    },
  ];
}

const attribute = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name,
  type: 'string',
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: 'readWrite',
  returned: 'default',
  uniqueness: 'none',
  ...extra,
});

export function schemas(base: string): Record<string, unknown>[] {
  return [
    {
      schemas: [SCHEMA_SCHEMA],
      id: SCHEMA_USER,
      name: 'User',
      attributes: [
        attribute('userName', { required: true, mutability: 'immutable', uniqueness: 'server' }),
        attribute('displayName'),
        attribute('name', { type: 'complex', subAttributes: [attribute('formatted')] }),
        attribute('emails', {
          type: 'complex',
          multiValued: true,
          mutability: 'immutable',
          subAttributes: [
            attribute('value'),
            attribute('type'),
            attribute('primary', { type: 'boolean' }),
          ],
        }),
        attribute('active', { type: 'boolean' }),
        attribute('groups', { type: 'complex', multiValued: true, mutability: 'readOnly' }),
      ],
      meta: { resourceType: 'Schema', location: `${base}/Schemas/${SCHEMA_USER}` },
    },
    {
      schemas: [SCHEMA_SCHEMA],
      id: SCHEMA_GROUP,
      name: 'Group',
      attributes: [
        attribute('displayName', { required: true, uniqueness: 'server' }),
        attribute('members', { type: 'complex', multiValued: true }),
      ],
      meta: { resourceType: 'Schema', location: `${base}/Schemas/${SCHEMA_GROUP}` },
    },
  ];
}
