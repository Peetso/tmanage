import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ConnectorInstallationRow } from '../../common/database/schema.js';
import type { TokenVaultSlot } from './token-vault.js';
import { CONNECTORS, findConnector } from './connectors.catalog.js';
import type {
  ConnectorAuthType,
  ConnectorCapability,
  ConnectorDefinition,
  ConnectorScope,
} from './connectors.catalog.js';
import { ConnectorsRepository } from './connectors.repository.js';

/** 54-01. The DI token of {@link ConnectorsService}. */
export const CONNECTORS_SERVICE = Symbol.for('tmanage.ConnectorsService');

/** Longest credential accepted; a real API token is far shorter. */
export const MAX_CREDENTIAL_LENGTH = 512;

export type ConnectorState = 'connected' | 'not_connected' | 'installed' | 'not_installed';

/** What the Connected apps screen shows of one connector. Never the credential itself. */
export interface ConnectorView {
  readonly key: string;
  readonly name: string;
  readonly authType: ConnectorAuthType;
  readonly scopes: readonly string[];
  readonly capabilities: readonly ConnectorCapability[];
  readonly scope: ConnectorScope;
  readonly managed: 'built-in' | 'framework';
  readonly state: ConnectorState;
  /** The last four characters of a stored API key; null otherwise. */
  readonly credentialHint: string | null;
  /** An ISO-8601 instant; null unless installed through the framework. */
  readonly installedAt: string | null;
}

/** The additional data binding a stored connector credential to its organization and connector. */
export function connectorBinding(organizationId: string, key: string): { userId: string } {
  return { userId: `connector:${organizationId}:${key}` };
}

/** The `storage_connections` / `calendar_connections` provider behind a built-in connector. */
const BUILT_IN_SOURCE: Readonly<
  Record<string, { table: 'storage' | 'calendar'; provider: string }>
> = {
  google_drive: { table: 'storage', provider: 'google_drive' },
  onedrive: { table: 'storage', provider: 'onedrive' },
  google_calendar: { table: 'calendar', provider: 'google' },
  microsoft_calendar: { table: 'calendar', provider: 'microsoft' },
};

interface Snapshot {
  readonly installed: ReadonlyMap<string, ConnectorInstallationRow>;
  readonly storage: readonly string[];
  readonly calendars: readonly string[];
}

function toView(connector: ConnectorDefinition, snapshot: Snapshot): ConnectorView {
  const base = {
    key: connector.key,
    name: connector.name,
    authType: connector.authType,
    scopes: connector.scopes,
    capabilities: connector.capabilities,
    scope: connector.scope,
    managed: connector.managed,
  };
  if (connector.managed === 'built-in') {
    const source = BUILT_IN_SOURCE[connector.key];
    const live =
      source !== undefined &&
      (source.table === 'storage' ? snapshot.storage : snapshot.calendars).includes(
        source.provider,
      );
    return {
      ...base,
      state: live ? 'connected' : 'not_connected',
      credentialHint: null,
      installedAt: null,
    };
  }
  const row = snapshot.installed.get(connector.key);
  return {
    ...base,
    state: row ? 'installed' : 'not_installed',
    credentialHint: row?.credentialHint ?? null,
    installedAt: row?.installedAt.toISOString() ?? null,
  };
}

function unknownConnector(): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'connector_unknown');
}

/**
 * 54-01. The connector framework over the token vault: list the registry with this workspace's
 * state, read one connector's status, install and uninstall.
 *
 * Every method is owner/admin only: `org.manage`, re-checked here with the real evaluator (the
 * route guard asks the same question first). A credential only ever travels into the vault
 * (`connector_token`, bound to the organization and connector) and never back out through a view.
 * Built-in connectors (Drive, OneDrive, calendars) keep their own flows: install/uninstall here
 * refuses them with a 409 and the screen sends the owner to their own card.
 */
export class ConnectorsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly cipher: TokenVaultSlot,
    private readonly repository: ConnectorsRepository = new ConnectorsRepository(),
  ) {}

  private requireManage(context: TenantContext, principal: Principal): void {
    const { allowed } = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'denied_org.manage');
    }
  }

  private async snapshot(context: TenantContext): Promise<Snapshot> {
    return this.database.read(context, async (runner) => {
      const rows = await this.repository.listInstalled(runner, context);
      return {
        installed: new Map(rows.map((row) => [row.connectorKey, row])),
        storage: await this.repository.connectedStorage(runner, context),
        calendars: await this.repository.connectedCalendars(runner, context),
      };
    });
  }

  async list(context: TenantContext, principal: Principal): Promise<readonly ConnectorView[]> {
    this.requireManage(context, principal);
    const snapshot = await this.snapshot(context);
    return CONNECTORS.map((connector) => toView(connector, snapshot));
  }

  async status(context: TenantContext, principal: Principal, key: string): Promise<ConnectorView> {
    this.requireManage(context, principal);
    const connector = findConnector(key);
    if (!connector) throw unknownConnector();
    return toView(connector, await this.snapshot(context));
  }

  async install(
    context: TenantContext,
    principal: Principal,
    key: string,
    body: { apiKey?: unknown },
  ): Promise<ConnectorView> {
    this.requireManage(context, principal);
    const connector = findConnector(key);
    if (!connector) throw unknownConnector();
    if (connector.managed === 'built-in') {
      throw new ApiError(409, 'conflict', 'This app is connected from its own card', [
        { field: 'connector', message: 'built_in' },
      ]);
    }
    if (connector.authType !== 'api-key') {
      // An OAuth connector needs a registered client; none is switched on for the framework yet.
      throw new ApiError(409, 'conflict', 'This app is not set up for TManage yet', [
        { field: 'connector', message: 'not_configured' },
      ]);
    }
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (apiKey.length < 8 || apiKey.length > MAX_CREDENTIAL_LENGTH || /\s/u.test(apiKey)) {
      throw new ApiError(422, 'validation_failed', 'Paste a valid API key', [
        { field: 'apiKey', message: 'invalid' },
      ]);
    }
    const credentialEnc = this.cipher.encrypt(
      apiKey,
      connectorBinding(context.organizationId, connector.key),
    );
    await this.database.transaction(context, async (tx) => {
      if (await this.repository.findByKey(tx, context, connector.key)) {
        throw new ApiError(409, 'conflict', 'This app is already installed', [
          { field: 'connector', message: 'installed' },
        ]);
      }
      await this.repository.insert(tx, context, {
        connectorKey: connector.key,
        credentialEnc,
        credentialHint: apiKey.slice(-4),
      });
    });
    return toView(connector, await this.snapshot(context));
  }

  async uninstall(
    context: TenantContext,
    principal: Principal,
    key: string,
  ): Promise<ConnectorView> {
    this.requireManage(context, principal);
    const connector = findConnector(key);
    if (!connector) throw unknownConnector();
    if (connector.managed === 'built-in') {
      throw new ApiError(409, 'conflict', 'This app is disconnected from its own card', [
        { field: 'connector', message: 'built_in' },
      ]);
    }
    await this.database.transaction(context, (tx) =>
      this.repository.remove(tx, context, connector.key),
    );
    return toView(connector, await this.snapshot(context));
  }

  /**
   * The decrypted credential of an installed connector, for a future server-side caller (the Jira
   * import job). Never exposed through a route.
   */
  async credential(context: TenantContext, key: string): Promise<string | null> {
    const row = await this.database.read(context, (runner) =>
      this.repository.findByKey(runner, context, key),
    );
    if (!row?.credentialEnc) return null;
    return this.cipher.decrypt(row.credentialEnc, connectorBinding(context.organizationId, key));
  }
}
