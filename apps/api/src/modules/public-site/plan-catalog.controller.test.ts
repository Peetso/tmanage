import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { IS_PUBLIC, REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { PlanCatalogController } from './plan-catalog.controller.js';
import { PlanCatalogService } from './plan-catalog.service.js';

/**
 * FEAT · module 1 Public site (x157). The public pricing endpoint's controller, over the real
 * service (the catalog is static, so there are no fakes and no database — nothing to stub). The
 * subject is the contract the marketing page depends on and the fact that the route is genuinely
 * public: no session, no capability, every tier priced with a seat rule, in a stable order.
 */

function build(): PlanCatalogController {
  return new PlanCatalogController(new PlanCatalogService());
}

describe('GET /v1/public/site/plans', () => {
  it('returns every tier, priced, with a seat rule, in a stable order', () => {
    const first = build().plans().plans;
    const second = build().plans().plans;

    // A non-empty catalog in a deterministic order — the same tiers, same order, every call.
    expect(first.length).toBeGreaterThan(0);
    expect(first.map((tier) => tier.id)).toEqual(second.map((tier) => tier.id));
    // Cheapest first: prices are non-decreasing down the catalog.
    for (let i = 1; i < first.length; i += 1) {
      expect(first[i]!.monthlyPriceCents).toBeGreaterThanOrEqual(first[i - 1]!.monthlyPriceCents);
    }

    for (const tier of first) {
      // Each tier has a price (a non-negative integer of minor units) and a currency.
      expect(Number.isInteger(tier.monthlyPriceCents)).toBe(true);
      expect(tier.monthlyPriceCents).toBeGreaterThanOrEqual(0);
      expect(tier.currency).toBe('usd');
      // Each tier has a seat rule and at least one feature bullet — the two things the page renders.
      expect(tier.seatRule.length).toBeGreaterThan(0);
      expect(tier.name.length).toBeGreaterThan(0);
      expect(tier.features.length).toBeGreaterThan(0);
    }

    // Exactly one recommended tier — the highlighted card.
    expect(first.filter((tier) => tier.featured)).toHaveLength(1);
    // The response never carries a tenant or a principal — it is display copy only.
    for (const tier of first) {
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
