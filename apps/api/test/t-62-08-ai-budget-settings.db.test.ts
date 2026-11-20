import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import { createTenantPool } from '../src/common/database/connection.js';
import { TenantDatabase } from '../src/common/database/tenant-context.js';
import type { PlatformAdminActor } from '../src/modules/platform-admin/platform-admin.guard.js';
import { AI_BUDGET_SETTING } from '../src/modules/platform-admin/settings/ai-budget.js';
import {
  AI_BUDGET_AUDIT_ACTIONS,
  AiBudgetSettingsService,
} from '../src/modules/platform-admin/settings/ai-budget.service.js';
import { PlatformSettingsRepository } from '../src/modules/platform-admin/settings/settings.repository.js';
import { RUNTIME_STATEMENT_TIMEOUT_MS, startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * 62-08 (plan 62 §5, §7) — Platform settings → AI budget on MariaDB 11.8 through the real identity
 * path, as the runtime user (grants included). FOR THE TEST PHASE (lane T did not run it):
 *
 * 1. Lowering the customers cap below what it already settled pauses it in the same transaction;
 *    the setting row and one platform audit row are written with it.
 * 2. Two racing reserve releases of 10 USD from a 15 USD reserve: exactly one moves, the other is
 *    a 409; the caps still sum to the ceiling.
 * 3. Resume leaves a pool above its cap paused.
 */

const USD = 1_000_000;
const ENV = { AI_PLATFORM_CAP_MAX_USD: '100' };
const NOW = new Date('2026-11-20T10:00:00.000Z');
const REASON = 'Test phase budget check';

let db: TestDatabase;
let world: SeedWorld;
let pool: Pool | undefined;
let service: AiBudgetSettingsService;

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await db.admin.query<RowDataPacket[]>(sql, params);
  return result;
}

function actor(): PlatformAdminActor {
  return {
    account: { userId: world.northstar.owner.id, email: world.northstar.owner.email },
    sessionId: uuidv7(),
    stepUp: { expiresAt: new Date(NOW.getTime() + 55 * 60_000), mfaVerified: true },
  } as unknown as PlatformAdminActor;
}

const request = () => ({ correlationId: uuidv7(), ip: null, userAgent: null });

beforeAll(async () => {
  db = await startTestDatabase();
  world = await seedTwoTenants(db.admin);
  pool = createTenantPool({
    url: db.runtimeUrl,
    connectionLimit: 8,
    statementTimeoutMs: RUNTIME_STATEMENT_TIMEOUT_MS,
  });
  const database = new TenantDatabase(pool, { guardMode: 'enforce' });
  service = new AiBudgetSettingsService({
    database,
    store: new PlatformSettingsRepository(database),
    env: ENV,
    now: () => NOW,
    stepUpWindowMinutes: 60,
  });
}, 180_000);

beforeEach(async () => {
  await db.admin.query('delete from ai_budget_pools');
  await db.admin.query('delete from platform_settings where setting_key = ?', [AI_BUDGET_SETTING]);
  await db.admin.query("delete from platform_admin_audit_events where action like 'platform.ai_%'");
});

afterAll(async () => {
  await pool?.end();
  await db?.stop();
});

const caps = (customers: number) => ({
  customersCents: customers * 100,
  testingCents: 2500,
  reserveCents: 1500,
  sonnetEnabled: true,
  applyTo: 'this_month',
  reason: REASON,
});

describe('lowering a cap below the spend pauses at once', () => {
  it('pauses customers in the same transaction as the setting and its audit row', async () => {
    await service.update(actor(), caps(60), request());
    await db.admin.execute(
      "update ai_budget_pools set settled_micro_usd = ? where pool = 'customers' and period_start = '2026-11-01'",
      [30 * USD],
    );
    const view = await service.update(actor(), caps(20), request());
    expect(view.pools.find((p) => p.pool === 'customers')).toMatchObject({
      capMicroUsd: 20 * USD,
      paused: true,
      pausedReason: 'cap_lowered',
    });
    const audits = await rows('select action from platform_admin_audit_events where action = ?', [
      AI_BUDGET_AUDIT_ACTIONS.updated,
    ]);
    expect(audits).toHaveLength(2);
    const resumed = await service.resume(actor(), { reason: REASON }, request());
    expect(resumed.pools.filter((p) => p.paused).map((p) => p.pool)).toEqual(['customers']);
  });
});

describe('the reserve gives only what it has', () => {
  it('two racing 10 USD releases from 15 USD: one moves, one is a 409', async () => {
    await service.update(actor(), caps(60), request());
    const body = { to: 'customers', amountCents: 1000, reason: REASON };
    const outcomes = await Promise.allSettled([
      service.releaseReserve(actor(), body, request()),
      service.releaseReserve(actor(), body, request()),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((o) => o.status === 'rejected')).toMatchObject({
      reason: { status: 409, auditCode: 'ai_reserve_short' },
    });
    const [sum] = await rows(
      "select sum(cap_micro_usd) as total from ai_budget_pools where period_start = '2026-11-01'",
    );
    expect(Number(sum?.['total'])).toBe(100 * USD);
    const audits = await rows('select action from platform_admin_audit_events where action = ?', [
      AI_BUDGET_AUDIT_ACTIONS.reserveReleased,
    ]);
    expect(audits).toHaveLength(1);
  });
});
