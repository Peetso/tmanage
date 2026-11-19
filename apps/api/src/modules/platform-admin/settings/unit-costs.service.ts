import { optionalReason } from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { RequestContext } from '../platform-admin.service.js';
import { platformAuditFor } from '../platform-audit.service.js';
import type { PlatformSettingsRepository } from './settings.repository.js';
import {
  UNIT_COSTS_SETTING,
  parseStoredUnitCosts,
  parseUnitCostsBody,
  serializeUnitCosts,
  type UnitCosts,
} from './unit-costs.js';

/**
 * 62-A3 (B14) — read and set the platform's monthly unit costs (`unit-costs.ts`). Reuses the
 * settings page's store: one `platform_settings` row and the platform audit row in one transaction
 * (`platform.unit_costs_updated`, before and after as figures only).
 */

/** `GET/PUT /v1/platform/settings/unit-costs` — CONTRACT: `lib/api/platform-unit-costs.ts`. */
export interface UnitCostsView {
  /** `null` = not set. */
  readonly costs: UnitCosts | null;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export type UnitCostsStore = Pick<PlatformSettingsRepository, 'readAll' | 'writeMany'>;

export class UnitCostsService {
  constructor(private readonly store: UnitCostsStore) {}

  async read(context: RequestContext): Promise<UnitCostsView> {
    const stored = (await this.store.readAll(context.correlationId)).get(UNIT_COSTS_SETTING);
    return {
      costs: parseStoredUnitCosts(stored?.value),
      updatedAt: stored?.updatedAt?.toISOString() ?? null,
      updatedBy: stored?.updatedBy ?? null,
    };
  }

  async set(
    actor: PlatformAdminActor,
    body: Readonly<Record<string, unknown>> | null,
    context: RequestContext,
  ): Promise<UnitCostsView> {
    const costs = parseUnitCostsBody(body);
    const reason = optionalReason(body?.['reason']);
    const before = await this.read(context);
    await this.store.writeMany(
      [[UNIT_COSTS_SETTING, serializeUnitCosts(costs)]],
      platformAuditFor(actor, context, {
        action: 'platform.unit_costs_updated',
        targetType: 'setting',
        targetId: null,
        targetLabel: 'unit_costs',
        reason,
        beforeJson: JSON.stringify(before.costs),
        afterJson: JSON.stringify(costs),
      }),
    );
    return this.read(context);
  }
}
