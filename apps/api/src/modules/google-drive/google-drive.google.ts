import { createHash, createHmac, randomBytes } from 'node:crypto';
import { constantTimeEquals } from '../identity/session-token.js';

/**
 * Google Drive as company storage — the protocol half. Nothing here touches the database.
 *
 * - **Configuration** comes only from the environment (`GOOGLE_DRIVE_CLIENT_ID` /
 *   `GOOGLE_DRIVE_CLIENT_SECRET`, falling back to the sign-in client `GOOGLE_CLIENT_ID` /
 *   `GOOGLE_CLIENT_SECRET` that Peter's setup steps create). With either missing the feature is
 *   off and the Storage screen says "not configured". No secret is ever in code.
 * - **Scope** is `drive.file` (plus `openid email` to show which account connected): TManage sees
 *   only the files it creates or a person picks, never the whole Drive.
 * - **The flow cookie** carries `state` and the PKCE verifier, signed with `SESSION_SECRET` under
 *   its own purpose and bound to the organization and the person who started it.
 * - **Folder layout** is `TManage/<Project>/<Work item>/`; {@link driveFolderName} makes a name safe.
 */

export const DRIVE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const DRIVE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const DRIVE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
export const DRIVE_SCOPES = 'openid email https://www.googleapis.com/auth/drive.file';
export const DRIVE_CALLBACK_PATH = '/v1/integrations/google-drive/callback';
/** The flow cookie must reach both the callback and the org-scoped completion route. */
export const DRIVE_COOKIE_PATH = '/v1';
export const DRIVE_FLOW_COOKIE = 'tm_gdrive_flow';
export const DRIVE_FLOW_TTL_SECONDS = 600;
export const DRIVE_ROOT_FOLDER_NAME = 'TManage';
export const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const FLOW_PURPOSE = 'google-drive-flow.v1';

export interface DriveConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** For the browser file picker; optional — without it the picker is off, uploads still work. */
  readonly pickerApiKey: string | null;
  readonly projectNumber: string | null;
}

type Env = Readonly<Record<string, string | undefined>>;

function value(env: Env, ...names: string[]): string | null {
  for (const name of names) {
    const raw = env[name]?.trim();
    if (raw) return raw;
  }
  return null;
}

/** The Drive client from the environment, or `null` (feature off, "not configured"). */
export function driveConfigFrom(env: Env): DriveConfig | null {
  const clientId = value(env, 'GOOGLE_DRIVE_CLIENT_ID', 'GOOGLE_CLIENT_ID');
  const clientSecret = value(env, 'GOOGLE_DRIVE_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    pickerApiKey: value(env, 'GOOGLE_PICKER_API_KEY'),
    projectNumber: value(env, 'GOOGLE_PROJECT_NUMBER'),
  };
}

// ── The flow cookie ──────────────────────────────────────────────────────────

export interface DriveFlow {
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly userId: string;
  readonly state: string;
  readonly verifier: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

function random(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function newDriveFlow(
  owner: { organizationId: string; organizationSlug: string; userId: string },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): DriveFlow {
  return {
    ...owner,
    state: random(),
    verifier: random(),
    expiresAt: nowSeconds + DRIVE_FLOW_TTL_SECONDS,
  };
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`${FLOW_PURPOSE}.${payload}`).digest('base64url');
}

export function sealDriveFlow(flow: DriveFlow, secret: string): string {
  const payload = Buffer.from(JSON.stringify(flow), 'utf8').toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/** The flow, or `undefined` for a missing, forged, malformed or expired cookie. */
export function openDriveFlow(
  raw: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): DriveFlow | undefined {
  if (!raw) return undefined;
  const [payload, signature, extra] = raw.split('.');
  if (!payload || !signature || extra !== undefined) return undefined;
  if (!constantTimeEquals(signature, sign(payload, secret))) return undefined;
  try {
    const flow = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as DriveFlow;
    if (
      typeof flow.state !== 'string' ||
      typeof flow.verifier !== 'string' ||
      typeof flow.organizationId !== 'string' ||
      typeof flow.organizationSlug !== 'string' ||
      typeof flow.userId !== 'string' ||
      typeof flow.expiresAt !== 'number' ||
      flow.expiresAt < nowSeconds
    ) {
      return undefined;
    }
    return flow;
  } catch {
    return undefined;
  }
}

export function driveStateMatches(flow: DriveFlow, returned: unknown): boolean {
  return typeof returned === 'string' && constantTimeEquals(flow.state, returned);
}

export function driveAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  flow: DriveFlow;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: DRIVE_SCOPES,
    state: input.flow.state,
    code_challenge: createHash('sha256').update(input.flow.verifier).digest('base64url'),
    code_challenge_method: 'S256',
    // A refresh token is only issued with offline access, and `consent` makes Google issue a
    // fresh one on a reconnect rather than reuse a revoked grant.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return `${DRIVE_AUTHORIZATION_ENDPOINT}?${params.toString()}`;
}

// ── Folder names ─────────────────────────────────────────────────────────────

/**
 * A Drive folder name from a project or work-item title: control characters and slashes removed
 * (a `/` would read as a path), whitespace collapsed, at most 120 characters, never empty.
 */
export function driveFolderName(title: string, fallback: string): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .trim();
  return cleaned === '' ? fallback : cleaned;
}

/** Escape a value for a Drive `q` string literal (backslash and single quote). */
export function driveQueryLiteral(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** A Drive id is a short run of URL-safe characters; anything else is refused before any call. */
export function isDriveId(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{5,128}$/.test(raw);
}

/** NV10. A Drive page token as Google issues it: at most 512 URL-safe characters. */
export function isDrivePageToken(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[A-Za-z0-9_.~-]{1,512}$/.test(raw);
}

// ── The transport ────────────────────────────────────────────────────────────

export interface DriveTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly email: string | null;
}

export interface DriveFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number | null;
  readonly webViewLink: string | null;
  readonly driveId: string | null;
  /**
   * V2. The folders the file sits in, as Google reports them to this connection (empty when the
   * parent is not visible to it, such as a file shared with the person from someone else's Drive).
   */
  readonly parents: readonly string[];
}

/** NV10. One entry of a folder listing: never a download or thumbnail link, never a token. */
export interface DriveChild {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number | null;
  readonly modifiedTime: string | null;
  readonly isFolder: boolean;
}

export interface DriveChildrenPage {
  readonly files: readonly DriveChild[];
  readonly nextPageToken: string | null;
}

/** Google refused the grant (expired or revoked): the connection moves to the error state. */
export class DriveGrantRevokedError extends Error {
  override name = 'DriveGrantRevokedError';
}

/** Google does not show this file to this connection (unknown id, or outside `drive.file`). */
export class DriveFileNotFoundError extends Error {
  override name = 'DriveFileNotFoundError';
}

/** Any other failure talking to Google. */
export class DriveUnavailableError extends Error {
  override name = 'DriveUnavailableError';
}

export interface DriveTransport {
  exchangeCode(input: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    verifier: string;
  }): Promise<DriveTokens>;
  refreshAccessToken(input: {
    refreshToken: string;
    clientId: string;
    clientSecret: string;
  }): Promise<string>;
  revoke(token: string): Promise<void>;
  /** Find the folder by name under the parent, or create it. */
  ensureFolder(
    accessToken: string,
    input: { name: string; parentId: string | null; driveId: string | null },
  ): Promise<string>;
  /** `fields: 'parents'` (M04's ancestor walk) asks Google for the id and parents only. */
  getFile(accessToken: string, fileId: string, fields?: 'full' | 'parents'): Promise<DriveFile>;
  /** NV10. One page (50) of the folder's children, for the server-side project file list. */
  listChildren(
    accessToken: string,
    input: { parentId: string; pageToken: string | null },
  ): Promise<DriveChildrenPage>;
  /** Start a resumable upload into the folder; returns Google's one-upload session URL. */
  startUpload(
    accessToken: string,
    input: { name: string; mimeType: string; size: number; parentId: string; origin: string },
  ): Promise<string>;
}

function decodeEmail(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: unknown;
    };
    return typeof claims.email === 'string' ? claims.email : null;
  } catch {
    return null;
  }
}

function toDriveFile(body: Record<string, unknown>): DriveFile {
  const size = typeof body['size'] === 'string' ? Number(body['size']) : null;
  return {
    id: String(body['id']),
    name: typeof body['name'] === 'string' ? body['name'] : 'Untitled',
    mimeType: typeof body['mimeType'] === 'string' ? body['mimeType'] : 'application/octet-stream',
    size: size !== null && Number.isFinite(size) ? size : null,
    webViewLink: typeof body['webViewLink'] === 'string' ? body['webViewLink'] : null,
    driveId: typeof body['driveId'] === 'string' ? body['driveId'] : null,
    parents: Array.isArray(body['parents'])
      ? body['parents'].filter((id): id is string => typeof id === 'string').slice(0, 20)
      : [],
  };
}

const FILE_FIELDS = 'id,name,mimeType,size,webViewLink,driveId,parents';
const PARENT_FIELDS = 'id,parents';
const CHILD_FIELDS = 'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents)';
export const DRIVE_CHILDREN_PAGE_SIZE = 50;

function toDriveChild(body: Record<string, unknown>): DriveChild | null {
  if (!isDriveId(body['id'])) return null;
  const size = typeof body['size'] === 'string' ? Number(body['size']) : null;
  const mimeType =
    typeof body['mimeType'] === 'string' ? body['mimeType'] : 'application/octet-stream';
  return {
    id: body['id'],
    name: typeof body['name'] === 'string' ? body['name'].slice(0, 255) : 'Untitled',
    mimeType: mimeType.slice(0, 190),
    size: size !== null && Number.isFinite(size) ? size : null,
    modifiedTime: typeof body['modifiedTime'] === 'string' ? body['modifiedTime'] : null,
    isFolder: mimeType === FOLDER_MIME_TYPE,
  };
}

export function createDriveTransport(fetchImpl: typeof fetch = fetch): DriveTransport {
  async function call(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch {
      throw new DriveUnavailableError('Google Drive could not be reached');
    }
    if (response.status === 401) throw new DriveGrantRevokedError('Google refused the token');
    if (response.status === 404) throw new DriveFileNotFoundError('Google has no such file');
    if (!response.ok) throw new DriveUnavailableError(`Google Drive answered ${response.status}`);
    return response;
  }

  const auth = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });

  return {
    async exchangeCode(input) {
      const response = await call(DRIVE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: input.code,
          client_id: input.clientId,
          client_secret: input.clientSecret,
          redirect_uri: input.redirectUri,
          code_verifier: input.verifier,
        }).toString(),
      });
      const body = (await response.json()) as Record<string, unknown>;
      if (typeof body['access_token'] !== 'string') {
        throw new DriveUnavailableError('Google token response had no access token');
      }
      return {
        accessToken: body['access_token'],
        refreshToken: typeof body['refresh_token'] === 'string' ? body['refresh_token'] : null,
        email: decodeEmail(body['id_token']),
      };
    },

    async refreshAccessToken(input) {
      let response: Response;
      try {
        response = await fetchImpl(DRIVE_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: input.refreshToken,
            client_id: input.clientId,
            client_secret: input.clientSecret,
          }).toString(),
        });
      } catch {
        throw new DriveUnavailableError('Google could not be reached');
      }
      // `invalid_grant` (400) is the one answer that means "expired or revoked".
      if (response.status === 400 || response.status === 401) {
        throw new DriveGrantRevokedError('Google refused the refresh token');
      }
      if (!response.ok) throw new DriveUnavailableError(`Google answered ${response.status}`);
      const body = (await response.json()) as Record<string, unknown>;
      if (typeof body['access_token'] !== 'string') {
        throw new DriveUnavailableError('Google refresh response had no access token');
      }
      return body['access_token'];
    },

    async revoke(token) {
      // Best effort: a token Google already forgot is the outcome a revoke wants anyway.
      await fetchImpl(DRIVE_REVOKE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
      }).catch(() => undefined);
    },

    async ensureFolder(accessToken, input) {
      const clauses = [
        `name = ${driveQueryLiteral(input.name)}`,
        `mimeType = '${FOLDER_MIME_TYPE}'`,
        'trashed = false',
        `${driveQueryLiteral(input.parentId ?? input.driveId ?? 'root')} in parents`,
      ];
      const search = new URLSearchParams({
        q: clauses.join(' and '),
        fields: 'files(id)',
        pageSize: '1',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
        ...(input.driveId ? { corpora: 'drive', driveId: input.driveId } : {}),
      });
      const found = (await (
        await call(`${DRIVE_API}/files?${search.toString()}`, { headers: auth(accessToken) })
      ).json()) as { files?: { id?: unknown }[] };
      const existing = found.files?.[0]?.id;
      if (typeof existing === 'string') return existing;

      const parent = input.parentId ?? input.driveId;
      const created = (await (
        await call(`${DRIVE_API}/files?supportsAllDrives=true&fields=id`, {
          method: 'POST',
          headers: { ...auth(accessToken), 'content-type': 'application/json' },
          body: JSON.stringify({
            name: input.name,
            mimeType: FOLDER_MIME_TYPE,
            ...(parent ? { parents: [parent] } : {}),
          }),
        })
      ).json()) as { id?: unknown };
      if (typeof created.id !== 'string') throw new DriveUnavailableError('No folder id');
      return created.id;
    },

    async getFile(accessToken, fileId, fields = 'full') {
      const wanted = fields === 'parents' ? PARENT_FIELDS : FILE_FIELDS;
      const response = await call(
        `${DRIVE_API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=${wanted}`,
        { headers: auth(accessToken) },
      );
      return toDriveFile((await response.json()) as Record<string, unknown>);
    },

    async listChildren(accessToken, input) {
      // The parent id is put into the query only through `driveQueryLiteral`.
      const search = new URLSearchParams({
        q: `${driveQueryLiteral(input.parentId)} in parents and trashed = false`,
        fields: CHILD_FIELDS,
        pageSize: String(DRIVE_CHILDREN_PAGE_SIZE),
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
        ...(input.pageToken ? { pageToken: input.pageToken } : {}),
      });
      const body = (await (
        await call(`${DRIVE_API}/files?${search.toString()}`, { headers: auth(accessToken) })
      ).json()) as { files?: unknown; nextPageToken?: unknown };
      const files = Array.isArray(body.files)
        ? body.files
            .slice(0, DRIVE_CHILDREN_PAGE_SIZE)
            .map((entry) => toDriveChild((entry ?? {}) as Record<string, unknown>))
            .filter((entry): entry is DriveChild => entry !== null)
        : [];
      return {
        files,
        nextPageToken: isDrivePageToken(body.nextPageToken) ? body.nextPageToken : null,
      };
    },

    async startUpload(accessToken, input) {
      const response = await call(
        `${DRIVE_UPLOAD_API}/files?uploadType=resumable&supportsAllDrives=true&fields=${FILE_FIELDS}`,
        {
          method: 'POST',
          headers: {
            ...auth(accessToken),
            'content-type': 'application/json; charset=UTF-8',
            'x-upload-content-type': input.mimeType,
            'x-upload-content-length': String(input.size),
            // Google answers the browser's upload with CORS headers for this origin only.
            origin: input.origin,
          },
          body: JSON.stringify({ name: input.name, parents: [input.parentId] }),
        },
      );
      const location = response.headers.get('location');
      if (!location?.startsWith('https://')) {
        throw new DriveUnavailableError('Google did not open an upload session');
      }
      return location;
    },
  };
}
