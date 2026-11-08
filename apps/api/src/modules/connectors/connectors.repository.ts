import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  calendarConnections,
  connectorInstallations,
  storageConnections,
} from '../../common/database/schema.js';
import type { ConnectorInstallationRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 54-01. The connector installs (0328), plus read-only lookups of the built-in connections the
 * registry reuses (`storage_connections` for Drive/OneDrive, `calendar_connections` for the
 * caller's own calendars). Every statement carries the tenant predicate; `organization_id` always
 * comes from the context.
 */
export class ConnectorsRepository {
  async listInstalled(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly ConnectorInstallationRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(connectorInstallations)
      .where(eq(connectorInstallations.organizationId, context.organizationId));
  }

  async findByKey(
    runner: TenantQueryRunner,
    context: TenantContext,
    connectorKey: string,
  ): Promise<ConnectorInstallationRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(connectorInstallations)
      .where(
        and(
          eq(connectorInstallations.organizationId, context.organizationId),
          eq(connectorInstallations.connectorKey, connectorKey),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** `uq_connector_installations_org_key` is the backstop for a racing second install. */
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly connectorKey: string;
      readonly credentialEnc: string | null;
      readonly credentialHint: string | null;
    },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(connectorInstallations)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        connectorKey: input.connectorKey,
        credentialEnc: input.credentialEnc,
        credentialHint: input.credentialHint,
        installedBy: context.userId,
        installedAt: sql`current_timestamp(3)`,
      });
  }

  async remove(
    runner: TenantQueryRunner,
    context: TenantContext,
    connectorKey: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(connectorInstallations)
      .where(
        and(
          eq(connectorInstallations.organizationId, context.organizationId),
          eq(connectorInstallations.connectorKey, connectorKey),
        ),
      );
  }

  /** The company storage providers connected right now (`google_drive`, `onedrive`). */
  async connectedStorage(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .select({ provider: storageConnections.provider })
      .from(storageConnections)
      .where(
        and(
          eq(storageConnections.organizationId, context.organizationId),
          inArray(storageConnections.provider, ['google_drive', 'onedrive']),
          eq(storageConnections.status, 'connected'),
        ),
      );
    return rows.map((row) => row.provider);
  }

  /** The caller's own connected calendars (`google`, `microsoft`). */
  async connectedCalendars(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .select({ provider: calendarConnections.provider })
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.organizationId, context.organizationId),
          eq(calendarConnections.userId, context.userId),
          eq(calendarConnections.status, 'connected'),
        ),
      );
    return rows.map((row) => row.provider);
  }
}
