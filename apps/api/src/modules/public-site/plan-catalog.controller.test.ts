import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { IS_PUBLIC, REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { PlanCatalogController } from './plan-catalog.controller.js';
import { PlanCatalogService } from './plan-catalog.service.js';

/**
 * FEAT · module 1 Public site (x157). The public pricing endpoint's controller, over the real
 * service (the catalog is static, so there are no fakes and no database — nothing to stub). The
 * subject is the contract the marketing page depends on and the fact that the route is genuinely
 * public: no session, no capability, the five flat plans (free/starter/studio/business/enterprise)
 * with one flat-price rule, in a stable order.
 */

function build(): PlanCatalogController {
  return new PlanCatalogController(new PlanCatalogService());
}

describe('GET /v1/public/site/plans', () => {
  it('returns the five flat plans the website draws, in a stable order', () => {
    const first = build().plans().plans;
    const second = build().plans().plans;

    // The same five tiers, same order, every call — Studio is the one recommended card.
    expect(first.map((tier) => tier.id)).toEqual([
      'free',
      'starter',
      'studio',
      'business',
      'enterprise',
    ]);
    expect(second.map((tier) => tier.id)).toEqual(first.map((tier) => tier.id));
    expect(first.map((tier) => tier.monthlyPriceCents)).toEqual([0, 1900, 4900, 8900, 0]);
    expect(first.filter((tier) => tier.featured).map((tier) => tier.id)).toEqual(['studio']);

    for (const tier of first) {
      // A flat price for the whole team: never a per-member or per-seat rule.
      expect(tier.seatRule).toBe('Flat price for the whole team');
      expect(Number.isInteger(tier.monthlyPriceCents)).toBe(true);
      expect(tier.currency).toBe('usd');
      expect(tier.name.length).toBeGreaterThan(0);
      expect(tier.features).toHaveLength(4);
      // The response never carries a tenant or a principal — it is display copy only.
      const record = tier as unknown as Record<string, unknown>;
      expect(record['organizationId']).toBeUndefined();
      expect(record['userId']).toBeUndefined();
    }
  });
});

describe('the route is public, with no capability ceiling', () => {
  it('is marked @Public() so the guard pipeline (session, CSRF, tenant, capability) is skipped', () => {
    expect(Reflect.getMetadata(IS_PUBLIC, PlanCatalogController)).toBe(true);
  });

  it('requires no capability — a public read asks for none', () => {
    const cap = Reflect.getMetadata(
      REQUIRED_CAPABILITY,
      PlanCatalogController.prototype.plans as object,
    );
    expect(cap).toBeUndefined();
  });
});
