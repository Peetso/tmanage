import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readCappedBody } from '../../common/storage/capped-body.js';
import { constantTimeEquals } from '../identity/session-token.js';
import {
  isStoredReturnTo,
  type ConnectReturnTo,
} from '../platform-admin/connect-setup/connect-return.js';

/**
 * OneDrive as company storage — the protocol half (Microsoft identity platform and Graph). Nothing
 * here touches the database. The Google Drive twin is `google-drive.google.ts`.
 *
 * - **Configuration** comes only from the environment (`MICROSOFT_CLIENT_ID`,
 *   `MICROSOFT_CLIENT_SECRET`, optional `MICROSOFT_TENANT`, default `common` = personal Microsoft
 *   accounts and work or school accounts). With either secret missing the feature is off and the
 *   Storage screen says "not configured". No secret is ever in code.
 * - **Scopes** are `openid profile email offline_access Files.ReadWrite`. Graph has no per-file
 *   scope like Google's `drive.file`, and `Files.ReadWrite.AppFolder` only reaches `Apps/TManage`
 *   (the owner could never choose a root folder, and picked files outside it would be invisible).
 *   `Files.ReadWrite.All` is asked for only when the owner turns on SharePoint document libraries
 *   (incremental consent: a second connect with the wider scope). `User.Read` is not requested:
 *   the account label comes from the id_token.
 * - **Refresh tokens rotate**: every refresh answers with a new refresh token, which the caller
 *   must store. Microsoft has no revoke endpoint for them; a disconnect wipes the stored one.
 * - **The flow cookie** carries `state` and the PKCE verifier, signed with `SESSION_SECRET` under
 *   its own purpose and bound to the organization and the person who started it.
 * - **Addressing** is (drive id, item id). {@link oneDriveFolderName} makes a folder name safe.
 */

export const GRAPH_API = 'https://graph.microsoft.com/v1.0';
/** 51-17. How many document libraries the root choice lists. */
export const LIBRARIES_PAGE_SIZE = 100;
export const ONEDRIVE_BASE_SCOPES = 'openid profile email offline_access Files.ReadWrite';
/** Incremental consent for SharePoint document libraries. */
export const ONEDRIVE_LIBRARY_SCOPES = `${ONEDRIVE_BASE_SCOPES} Files.ReadWrite.All`;
/** Picker v8 on a personal account asks for an onedrive.com token, not a Graph one. */
export const PERSONAL_PICKER_SCOPE = 'OneDrive.ReadWrite offline_access';
export const PERSONAL_PICKER_BASE_URL = 'https://onedrive.live.com/picker';
export const ONEDRIVE_CALLBACK_PATH = '/v1/integrations/onedrive/callback';
/** The flow cookie must reach both the callback and the org-scoped completion route. */
export const ONEDRIVE_COOKIE_PATH = '/v1';
export const ONEDRIVE_FLOW_COOKIE = 'tm_onedrive_flow';
export const ONEDRIVE_FLOW_TTL_SECONDS = 600;
export const ONEDRIVE_ROOT_FOLDER_NAME = 'TManage';
export const ONEDRIVE_CHILDREN_PAGE_SIZE = 50;
/** 57-13a. Below this a file is sent in one PUT; above it, through an upload session. */
export const ONEDRIVE_SIMPLE_UPLOAD_BYTES = 4 * 1024 * 1024;
/** 57-13a. Session chunk: a multiple of 320 KiB, as Graph requires. */
export const ONEDRIVE_UPLOAD_CHUNK_BYTES = 32 * 320 * 1024;
const FLOW_PURPOSE = 'onedrive-flow.v1';

export interface OneDriveConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** `common`, `organizations`, `consumers` or one tenant's id or domain. */
  readonly tenant: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/** The Microsoft client from the environment, or `null` (feature off, "not configured"). */
export function oneDriveConfigFrom(env: Env): OneDriveConfig | null {
  const clientId = env['MICROSOFT_CLIENT_ID']?.trim();
  const clientSecret = env['MICROSOFT_CLIENT_SECRET']?.trim();
  if (!clientId || !clientSecret) return null;
  const tenant = env['MICROSOFT_TENANT']?.trim();
  return {
    clientId,
    clientSecret,
    tenant: tenant && /^[A-Za-z0-9.-]{1,64}$/.test(tenant) ? tenant : 'common',
  };
}

export function authorizeEndpoint(config: Pick<OneDriveConfig, 'tenant'>): string {
  return `https://login.microsoftonline.com/${config.tenant}/oauth2/v2.0/authorize`;
}

export function tokenEndpoint(config: Pick<OneDriveConfig, 'tenant'>): string {
  return `https://login.microsoftonline.com/${config.tenant}/oauth2/v2.0/token`;
}

// ── The flow cookie ──────────────────────────────────────────────────────────

export interface OneDriveFlow {
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly userId: string;
  readonly state: string;
  readonly verifier: string;
  /** Whether this connect asks for SharePoint libraries (`Files.ReadWrite.All`). */
  readonly libraries: boolean;
  /** R38: set when the connect started from Connected apps, so it returns there. */
  readonly returnTo?: ConnectReturnTo;
  /** Unix seconds. */
  readonly expiresAt: number;
}

function random(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function newOneDriveFlow(
  owner: { organizationId: string; organizationSlug: string; userId: string; libraries: boolean },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): OneDriveFlow {
  return {
    ...owner,
    state: random(),
    verifier: random(),
    expiresAt: nowSeconds + ONEDRIVE_FLOW_TTL_SECONDS,
  };
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`${FLOW_PURPOSE}.${payload}`).digest('base64url');
}

export function sealOneDriveFlow(flow: OneDriveFlow, secret: string): string {
  const payload = Buffer.from(JSON.stringify(flow), 'utf8').toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/** The flow, or `undefined` for a missing, forged, malformed or expired cookie. */
export function openOneDriveFlow(
  raw: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): OneDriveFlow | undefined {
  if (!raw) return undefined;
  const [payload, signature, extra] = raw.split('.');
  if (!payload || !signature || extra !== undefined) return undefined;
  if (!constantTimeEquals(signature, sign(payload, secret))) return undefined;
  try {
    const flow = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OneDriveFlow;
    if (
      typeof flow.state !== 'string' ||
      typeof flow.verifier !== 'string' ||
      typeof flow.organizationId !== 'string' ||
      typeof flow.organizationSlug !== 'string' ||
      typeof flow.userId !== 'string' ||
      typeof flow.libraries !== 'boolean' ||
      !isStoredReturnTo(flow.returnTo) ||
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

export function oneDriveStateMatches(flow: OneDriveFlow, returned: unknown): boolean {
  return typeof returned === 'string' && constantTimeEquals(flow.state, returned);
}

export function oneDriveAuthorizationUrl(input: {
  config: OneDriveConfig;
  redirectUri: string;
  flow: OneDriveFlow;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    response_mode: 'query',
    client_id: input.config.clientId,
    redirect_uri: input.redirectUri,
    scope: input.flow.libraries ? ONEDRIVE_LIBRARY_SCOPES : ONEDRIVE_BASE_SCOPES,
    state: input.flow.state,
    code_challenge: createHash('sha256').update(input.flow.verifier).digest('base64url'),
    code_challenge_method: 'S256',
    // Let the owner choose which Microsoft account holds the company's files.
    prompt: 'select_account',
  });
  return `${authorizeEndpoint(input.config)}?${params.toString()}`;
}

// ── Names and ids ────────────────────────────────────────────────────────────

/**
 * A OneDrive folder or file name from a title: control characters and the characters OneDrive
 * refuses (`" * : < > ? / \ |`) removed, whitespace collapsed, no leading or trailing dots or
 * spaces, at most 120 characters, never empty.
 */
export function oneDriveFolderName(title: string, fallback: string): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"*:<>?/\\|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 120)
    .replace(/^[\s.]+|[\s.]+$/g, '');
  return cleaned === '' ? fallback : cleaned;
}

/** A Graph drive or item id: a short run of id characters; anything else is refused before any call. */
export function isGraphId(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[A-Za-z0-9!_.=-]{5,255}$/.test(raw);
}

/** NV10. A Graph `$skiptoken` as Graph issues it: at most 1024 URL-safe characters. */
export function isGraphSkipToken(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[A-Za-z0-9!_.~=%-]{1,1024}$/.test(raw);
}

// ── The transport ────────────────────────────────────────────────────────────

export interface OneDriveTokens {
  readonly accessToken: string;
  /** Microsoft rotates it: a refresh answers with a new one the caller must store. */
  readonly refreshToken: string | null;
  /** The scopes Microsoft granted (space-separated), when it said. */
  readonly scope: string | null;
}

export interface OneDriveSignIn extends OneDriveTokens {
  /** The account label (`email` or `preferred_username` from the id_token). */
  readonly email: string | null;
}

export interface OneDriveDrive {
  readonly id: string;
  readonly name: string;
  /** `personal`, `business` or `documentLibrary`. */
  readonly driveType: string;
  readonly webUrl: string | null;
}

export interface OneDriveItem {
  readonly id: string;
  readonly driveId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number | null;
  readonly webUrl: string | null;
  readonly isFolder: boolean;
  /** The parent folder's item id; null for a drive's root. */
  readonly parentId: string | null;
  /** FIX6 C3b. Graph's `lastModifiedDateTime`, when asked for in full; else null. */
  readonly modifiedTime?: string | null;
}

/** NV10. One entry of a folder listing: never a download link, never a token. */
export interface OneDriveChild {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number | null;
  readonly modifiedTime: string | null;
  readonly isFolder: boolean;
}

export interface OneDriveChildrenPage {
  readonly files: readonly OneDriveChild[];
  readonly nextPageToken: string | null;
}

/** Microsoft refused the grant (expired, revoked, password changed): the connection goes to error. */
export class OneDriveGrantRevokedError extends Error {
  override name = 'OneDriveGrantRevokedError';
}

/** The grant lacks consent for what was asked (e.g. the picker's resource); the grant stays. */
export class OneDriveConsentRequiredError extends Error {
  override name = 'OneDriveConsentRequiredError';
}

/** Graph does not show this item to this connection (unknown id, 403 or 404). */
export class OneDriveItemNotFoundError extends Error {
  override name = 'OneDriveItemNotFoundError';
}

/** Any other failure talking to Microsoft. */
export class OneDriveUnavailableError extends Error {
  override name = 'OneDriveUnavailableError';
}

/** FIX6 C1. Graph shows the item but refuses this connection its bytes (403 on `/content`). */
export class OneDriveNoAccessError extends Error {
  override name = 'OneDriveNoAccessError';
}

/** FIX6 C1. Graph sent the download somewhere that is not Microsoft's own file storage. */
export class OneDriveRedirectRefusedError extends Error {
  override name = 'OneDriveRedirectRefusedError';
}

/** FIX6 C1. The only hosts a Graph `/content` redirect may send the server to (the SSRF guard). */
const CONTENT_HOST_SUFFIXES = [
  '.sharepoint.com',
  '.1drv.com',
  '.onedrive.com',
  '.livefilestore.com',
] as const;

/**
 * FIX6 C1. Whether a `/content` redirect target is Microsoft's file storage: `https`, the default
 * port, no credentials in the URL, and a host under one of {@link CONTENT_HOST_SUFFIXES}.
 */
export function isOneDriveContentUrl(raw: string | null): raw is string {
  if (raw === null) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return CONTENT_HOST_SUFFIXES.some(
    (suffix) => host.endsWith(suffix) && host.length > suffix.length,
  );
}

export interface OneDriveTransport {
  exchangeCode(input: {
    config: OneDriveConfig;
    code: string;
    redirectUri: string;
    verifier: string;
    scope: string;
  }): Promise<OneDriveSignIn>;
  /** A token for `scope` (Graph by default, or the picker's resource); the refresh token rotates. */
  refreshTokens(input: {
    config: OneDriveConfig;
    refreshToken: string;
    scope: string;
  }): Promise<OneDriveTokens>;
  myDrive(accessToken: string): Promise<OneDriveDrive>;
  /** A drive by id (a SharePoint document library chosen as the root). */
  getDrive(accessToken: string, driveId: string): Promise<OneDriveDrive>;
  /** Find the folder by name under the parent, or create it (`conflictBehavior: fail`, then look up). */
  ensureFolder(
    accessToken: string,
    input: { driveId: string; parentId: string; name: string },
  ): Promise<string>;
  /** `parent` (the attach check's ancestor walk) asks Graph for the id and parent only. */
  getItem(
    accessToken: string,
    input: { driveId: string; itemId: string },
    fields?: 'full' | 'parent',
  ): Promise<OneDriveItem>;
  /** NV10. One page (50) of the folder's children, for the server-side project file list. */
  listChildren(
    accessToken: string,
    input: { driveId: string; itemId: string; skipToken: string | null },
  ): Promise<OneDriveChildrenPage>;
  /**
   * FIX6 C1. The item's bytes. `/content` on the fixed Graph host answers with a redirect, which
   * is followed only to {@link isOneDriveContentUrl} (and without the token); reading stops past
   * `maxBytes` (`DownloadTooLargeError`).
   */
  downloadItem(
    accessToken: string,
    input: { driveId: string; itemId: string },
    maxBytes: number,
  ): Promise<Buffer>;
  /** 51-17. The document libraries of the organisation's root SharePoint site this account sees. */
  listLibraries(accessToken: string): Promise<readonly OneDriveDrive[]>;
  /**
   * 57-13a. Upload bytes into the folder `parentId` (a name clash is renamed); answers the new
   * item id. Large files go through an upload session whose URL must pass
   * {@link isOneDriveContentUrl}; it carries no token and is never logged.
   */
  uploadItem(
    accessToken: string,
    input: { driveId: string; parentId: string; name: string; bytes: Buffer },
  ): Promise<string>;
  /** 57-13a. Remove an item TManage uploaded (a failed verification); an absent item is fine. */
  deleteItem(accessToken: string, input: { driveId: string; itemId: string }): Promise<void>;
}

function idTokenLabel(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: unknown;
      preferred_username?: unknown;
    };
    const label = typeof claims.email === 'string' ? claims.email : claims.preferred_username;
    return typeof label === 'string' ? label.slice(0, 320) : null;
  } catch {
    return null;
  }
}

/** Microsoft's token errors that mean "consent is missing for this scope", not "the grant is gone". */
const CONSENT_ERRORS = new Set(['consent_required', 'interaction_required', 'invalid_scope']);

async function tokenError(response: Response): Promise<Error> {
  let body: { error?: unknown; suberror?: unknown; error_codes?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // An unreadable error body is treated by status alone.
  }
  const codes = Array.isArray(body.error_codes) ? body.error_codes : [];
  if (
    CONSENT_ERRORS.has(String(body.error)) ||
    CONSENT_ERRORS.has(String(body.suberror)) ||
    codes.includes(65001)
  ) {
    return new OneDriveConsentRequiredError('Microsoft wants consent for this scope');
  }
  if (body.error === 'invalid_grant' || response.status === 401) {
    return new OneDriveGrantRevokedError('Microsoft refused the refresh token');
  }
  return new OneDriveUnavailableError(`Microsoft answered ${response.status}`);
}

function toItem(body: Record<string, unknown>, fallbackDriveId: string): OneDriveItem {
  const parent = (body['parentReference'] ?? {}) as Record<string, unknown>;
  const file = (body['file'] ?? null) as Record<string, unknown> | null;
  const size = typeof body['size'] === 'number' ? body['size'] : null;
  return {
    id: String(body['id']),
    driveId: typeof parent['driveId'] === 'string' ? parent['driveId'] : fallbackDriveId,
    name: typeof body['name'] === 'string' ? body['name'] : 'Untitled',
    mimeType:
      file && typeof file['mimeType'] === 'string' ? file['mimeType'] : 'application/octet-stream',
    size: size !== null && Number.isFinite(size) ? size : null,
    webUrl: typeof body['webUrl'] === 'string' ? body['webUrl'] : null,
    isFolder: body['folder'] !== undefined && body['folder'] !== null,
    parentId: isGraphId(parent['id']) ? parent['id'] : null,
    modifiedTime:
      typeof body['lastModifiedDateTime'] === 'string' ? body['lastModifiedDateTime'] : null,
  };
}

function toChild(body: Record<string, unknown>): OneDriveChild | null {
  if (!isGraphId(body['id'])) return null;
  const file = (body['file'] ?? null) as Record<string, unknown> | null;
  const size = typeof body['size'] === 'number' ? body['size'] : null;
  const mimeType =
    file && typeof file['mimeType'] === 'string' ? file['mimeType'] : 'application/octet-stream';
  return {
    id: body['id'],
    name: typeof body['name'] === 'string' ? body['name'].slice(0, 255) : 'Untitled',
    mimeType: mimeType.slice(0, 190),
    size: size !== null && Number.isFinite(size) ? size : null,
    modifiedTime:
      typeof body['lastModifiedDateTime'] === 'string' ? body['lastModifiedDateTime'] : null,
    isFolder: body['folder'] !== undefined && body['folder'] !== null,
  };
}

/** The `$skiptoken` of Graph's `@odata.nextLink`, when it is one we would accept back. */
export function skipTokenOf(nextLink: unknown): string | null {
  if (typeof nextLink !== 'string') return null;
  try {
    const token = new URL(nextLink).searchParams.get('$skiptoken');
    return isGraphSkipToken(token) ? token : null;
  } catch {
    return null;
  }
}

const ITEM_SELECT = 'id,name,size,webUrl,file,folder,parentReference,lastModifiedDateTime';
const PARENT_SELECT = 'id,parentReference';
const CHILD_SELECT = 'id,name,size,file,folder,lastModifiedDateTime';

export function createOneDriveTransport(fetchImpl: typeof fetch = fetch): OneDriveTransport {
  async function call(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch {
      throw new OneDriveUnavailableError('Microsoft Graph could not be reached');
    }
    if (response.status === 401) throw new OneDriveGrantRevokedError('Graph refused the token');
    if (response.status === 403 || response.status === 404) {
      throw new OneDriveItemNotFoundError('Graph shows no such item');
    }
    if (!response.ok) throw new OneDriveUnavailableError(`Graph answered ${response.status}`);
    return response;
  }

  async function token(config: OneDriveConfig, form: Record<string, string>): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(tokenEndpoint(config), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          ...form,
        }).toString(),
      });
    } catch {
      throw new OneDriveUnavailableError('Microsoft could not be reached');
    }
    if (!response.ok) throw await tokenError(response);
    return response;
  }

  const auth = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });

  async function drive(accessToken: string, url: string): Promise<OneDriveDrive> {
    const response = await call(`${url}?$select=id,name,driveType,webUrl`, {
      headers: auth(accessToken),
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!isGraphId(body['id'])) throw new OneDriveUnavailableError('Graph gave no drive id');
    return {
      id: body['id'],
      name: typeof body['name'] === 'string' ? body['name'].slice(0, 190) : 'OneDrive',
      driveType: typeof body['driveType'] === 'string' ? body['driveType'] : 'personal',
      webUrl: typeof body['webUrl'] === 'string' ? body['webUrl'] : null,
    };
  }

  const item = (driveId: string, itemId: string) =>
    `${GRAPH_API}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`;

  return {
    async exchangeCode(input) {
      const response = await token(input.config, {
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.verifier,
        scope: input.scope,
      });
      const body = (await response.json()) as Record<string, unknown>;
      if (typeof body['access_token'] !== 'string') {
        throw new OneDriveUnavailableError('Microsoft token response had no access token');
      }
      return {
        accessToken: body['access_token'],
        refreshToken: typeof body['refresh_token'] === 'string' ? body['refresh_token'] : null,
        scope: typeof body['scope'] === 'string' ? body['scope'] : null,
        email: idTokenLabel(body['id_token']),
      };
    },

    async refreshTokens(input) {
      const response = await token(input.config, {
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
        scope: input.scope,
      });
      const body = (await response.json()) as Record<string, unknown>;
      if (typeof body['access_token'] !== 'string') {
        throw new OneDriveUnavailableError('Microsoft refresh response had no access token');
      }
      return {
        accessToken: body['access_token'],
        refreshToken: typeof body['refresh_token'] === 'string' ? body['refresh_token'] : null,
        scope: typeof body['scope'] === 'string' ? body['scope'] : null,
      };
    },

    async myDrive(accessToken) {
      return drive(accessToken, `${GRAPH_API}/me/drive`);
    },

    async getDrive(accessToken, driveId) {
      return drive(accessToken, `${GRAPH_API}/drives/${encodeURIComponent(driveId)}`);
    },

    async listLibraries(accessToken) {
      const response = await call(
        `${GRAPH_API}/sites/root/drives?$select=id,name,driveType,webUrl&$top=${LIBRARIES_PAGE_SIZE}`,
        { headers: auth(accessToken) },
      );
      const body = (await response.json()) as { value?: unknown };
      if (!Array.isArray(body.value)) return [];
      return body.value.slice(0, LIBRARIES_PAGE_SIZE).flatMap((entry) => {
        const raw = (entry ?? {}) as Record<string, unknown>;
        if (!isGraphId(raw['id']) || raw['driveType'] !== 'documentLibrary') return [];
        const name = typeof raw['name'] === 'string' ? raw['name'].slice(0, 190) : '';
        return [
          {
            id: raw['id'],
            name: name || 'SharePoint library',
            driveType: 'documentLibrary',
            webUrl: typeof raw['webUrl'] === 'string' ? raw['webUrl'] : null,
          },
        ];
      });
    },

    async ensureFolder(accessToken, input) {
      const parent = item(input.driveId, input.parentId);
      let response: Response;
      try {
        response = await fetchImpl(`${parent}/children`, {
          method: 'POST',
          headers: { ...auth(accessToken), 'content-type': 'application/json' },
          body: JSON.stringify({
            name: input.name,
            folder: {},
            '@microsoft.graph.conflictBehavior': 'fail',
          }),
        });
      } catch {
        throw new OneDriveUnavailableError('Microsoft Graph could not be reached');
      }
      if (response.status !== 409) {
        if (response.status === 401) throw new OneDriveGrantRevokedError('Graph refused the token');
        if (response.status === 403 || response.status === 404) {
          throw new OneDriveItemNotFoundError('Graph shows no such folder');
        }
        if (!response.ok) throw new OneDriveUnavailableError(`Graph answered ${response.status}`);
        const created = (await response.json()) as { id?: unknown };
        if (!isGraphId(created.id)) throw new OneDriveUnavailableError('No folder id');
        return created.id;
      }
      // 409: the name is taken under the parent; use it when it is a folder.
      const found = (await (
        await call(`${parent}:/${encodeURIComponent(input.name)}?$select=id,folder`, {
          headers: auth(accessToken),
        })
      ).json()) as { id?: unknown; folder?: unknown };
      if (!isGraphId(found.id) || found.folder === undefined || found.folder === null) {
        throw new OneDriveUnavailableError('The name is taken by a file');
      }
      return found.id;
    },

    async getItem(accessToken, input, fields = 'full') {
      const select = fields === 'parent' ? PARENT_SELECT : ITEM_SELECT;
      const response = await call(`${item(input.driveId, input.itemId)}?$select=${select}`, {
        headers: auth(accessToken),
      });
      return toItem((await response.json()) as Record<string, unknown>, input.driveId);
    },

    async listChildren(accessToken, input) {
      const search = new URLSearchParams({
        $top: String(ONEDRIVE_CHILDREN_PAGE_SIZE),
        $select: CHILD_SELECT,
        ...(input.skipToken ? { $skiptoken: input.skipToken } : {}),
      });
      const body = (await (
        await call(`${item(input.driveId, input.itemId)}/children?${search.toString()}`, {
          headers: auth(accessToken),
        })
      ).json()) as { value?: unknown; '@odata.nextLink'?: unknown };
      const files = Array.isArray(body.value)
        ? body.value
            .slice(0, ONEDRIVE_CHILDREN_PAGE_SIZE)
            .map((entry) => toChild((entry ?? {}) as Record<string, unknown>))
            .filter((entry): entry is OneDriveChild => entry !== null)
        : [];
      return { files, nextPageToken: skipTokenOf(body['@odata.nextLink']) };
    },

    async downloadItem(accessToken, input, maxBytes) {
      const statusError = (status: number): Error | null => {
        if (status === 401) return new OneDriveGrantRevokedError('Graph refused the token');
        if (status === 403) return new OneDriveNoAccessError('Graph refused the download');
        if (status === 404) return new OneDriveItemNotFoundError('Graph shows no such item');
        return null;
      };
      let response: Response;
      try {
        response = await fetchImpl(`${item(input.driveId, input.itemId)}/content`, {
          headers: auth(accessToken),
          redirect: 'manual',
        });
      } catch {
        throw new OneDriveUnavailableError('Microsoft Graph could not be reached');
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!isOneDriveContentUrl(location)) {
          throw new OneDriveRedirectRefusedError('Graph redirected outside Microsoft storage');
        }
        // The pre-authenticated download URL needs no token, and the token must not travel on.
        try {
          response = await fetchImpl(location, { redirect: 'error' });
        } catch {
          throw new OneDriveUnavailableError('Microsoft storage could not be reached');
        }
      }
      const refused = statusError(response.status);
      if (refused) throw refused;
      if (!response.ok) throw new OneDriveUnavailableError(`Graph answered ${response.status}`);
      return readCappedBody(response, maxBytes);
    },

    async uploadItem(accessToken, input) {
      const refused = (status: number): Error => {
        if (status === 401) return new OneDriveGrantRevokedError('Graph refused the token');
        if (status === 403) return new OneDriveNoAccessError('Graph refused the upload');
        if (status === 404) return new OneDriveItemNotFoundError('Graph shows no such folder');
        return new OneDriveUnavailableError(`Graph answered ${status}`);
      };
      const send = async (url: string, init: RequestInit): Promise<Response> => {
        try {
          return await fetchImpl(url, { ...init, redirect: 'error' });
        } catch {
          throw new OneDriveUnavailableError('Microsoft Graph could not be reached');
        }
      };
      const target = `${item(input.driveId, input.parentId)}:/${encodeURIComponent(input.name)}:`;
      const total = input.bytes.byteLength;
      let response: Response;
      if (total < ONEDRIVE_SIMPLE_UPLOAD_BYTES) {
        response = await send(`${target}/content?@microsoft.graph.conflictBehavior=rename`, {
          method: 'PUT',
          headers: { ...auth(accessToken), 'content-type': 'application/octet-stream' },
          body: Uint8Array.from(input.bytes),
        });
        if (!response.ok) throw refused(response.status);
      } else {
        response = await send(`${target}/createUploadSession`, {
          method: 'POST',
          headers: { ...auth(accessToken), 'content-type': 'application/json' },
          body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename' } }),
        });
        if (!response.ok) throw refused(response.status);
        const session = ((await response.json()) as { uploadUrl?: unknown }).uploadUrl;
        if (typeof session !== 'string' || !isOneDriveContentUrl(session)) {
          throw new OneDriveRedirectRefusedError('Graph gave an upload session outside Microsoft');
        }
        for (let offset = 0; offset < total; offset += ONEDRIVE_UPLOAD_CHUNK_BYTES) {
          const end = Math.min(offset + ONEDRIVE_UPLOAD_CHUNK_BYTES, total);
          // The session URL is pre-authenticated: the token must not travel to it.
          response = await send(session, {
            method: 'PUT',
            headers: { 'content-range': `bytes ${offset}-${end - 1}/${total}` },
            body: Uint8Array.from(input.bytes.subarray(offset, end)),
          });
          if (!response.ok) throw refused(response.status);
        }
      }
      const id = ((await response.json()) as { id?: unknown }).id;
      if (!isGraphId(id)) throw new OneDriveUnavailableError('Graph gave no item id');
      return id;
    },

    async deleteItem(accessToken, input) {
      let response: Response;
      try {
        response = await fetchImpl(item(input.driveId, input.itemId), {
          method: 'DELETE',
          headers: auth(accessToken),
          redirect: 'error',
        });
      } catch {
        throw new OneDriveUnavailableError('Microsoft Graph could not be reached');
      }
      if (response.status === 404 || response.ok) return;
      if (response.status === 401) throw new OneDriveGrantRevokedError('Graph refused the token');
      throw new OneDriveUnavailableError(`Graph answered ${response.status}`);
    },
  };
}
