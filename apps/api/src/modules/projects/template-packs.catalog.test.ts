import { describe, expect, it } from 'vitest';
import {
  PACK_ROLES,
  TEMPLATE_PACKS,
  isPackRole,
  isWorkingDayOffset,
  packTemplateDescription,
  templatePacksForRole,
} from './template-packs.catalog.js';

/** 55-02 starter packs by role and 54-23 Arabic agency packs on the 54-22 catalog. */

const ARABIC = /[؀-ۿ]/;

function offsets(key: string): number[] {
  const pack = TEMPLATE_PACKS.find((entry) => entry.key === key);
  return (pack?.templates ?? [])
    .flatMap((template) => [
      ...(template.milestones ?? []).map((item) => item.offsetDays),
      ...(template.workItems ?? []).map((item) => item.offsetDays),
    ])
    .filter((offset): offset is number => typeof offset === 'number');
}

describe('template packs catalog (55-02, 54-23)', () => {
  it('has a starter pack for every role, unique pack keys and unique template names', () => {
    for (const role of PACK_ROLES) {
      expect(TEMPLATE_PACKS.some((pack) => pack.key === `starter-${role.replace('_', '-')}`)).toBe(
        true,
      );
    }
    const keys = TEMPLATE_PACKS.map((pack) => pack.key);
    expect(new Set(keys).size).toBe(keys.length);
    const names = TEMPLATE_PACKS.flatMap((pack) => pack.templates.map((t) => t.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it('filters by role, keeps catalog order, and returns every pack without a role', () => {
    expect(templatePacksForRole(null)).toBe(TEMPLATE_PACKS);
    const accounting = templatePacksForRole('accounting').map((pack) => pack.key);
    expect(accounting).toEqual(['monthly-retainer', 'starter-accounting']);
    expect(templatePacksForRole('designer').map((pack) => pack.key)).toContain('ar-agency-egypt');
    expect(isPackRole('marketing')).toBe(true);
    expect(isPackRole('owner')).toBe(false);
  });

  it('writes the Arabic agency packs in Arabic on a Sunday-to-Thursday week', () => {
    const arabic = TEMPLATE_PACKS.filter((pack) => pack.language === 'ar');
    expect(arabic.map((pack) => pack.key)).toEqual(['ar-agency-gulf', 'ar-agency-egypt']);
    for (const pack of arabic) {
      expect(pack.workWeek).toBe('sun_thu');
      expect(ARABIC.test(pack.name)).toBe(true);
      for (const template of pack.templates) expect(ARABIC.test(template.name)).toBe(true);
      const description = packTemplateDescription(pack, pack.templates[0]!);
      expect(description).toContain('أسبوع العمل: من الأحد إلى الخميس.');
      expect(description).not.toContain('Suggested automations');
    }
  });

  it('puts every date of the new packs on a working day', () => {
    expect([0, 4, 7, 11].every(isWorkingDayOffset)).toBe(true);
    expect([5, 6, 13].some(isWorkingDayOffset)).toBe(false);
    const fresh = TEMPLATE_PACKS.filter(
      (pack) => pack.key.startsWith('starter-') || pack.key.startsWith('ar-'),
    );
    for (const pack of fresh) expect(offsets(pack.key).every(isWorkingDayOffset)).toBe(true);
  });
});
