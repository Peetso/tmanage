import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TrustContentController } from './trust-content.controller.js';
import { TrustContentService } from './trust-content.service.js';
import { DataLocationService } from './data-location.service.js';
import { IS_PUBLIC, SKIPS_TENANT, REQUIRED_CAPABILITY } from '../../common/http/decorators.js';

/**
 * The public security-and-trust page (x158).
 *
 * The whole of this slice's safety is that the read is public *and* asks for nothing: no
 * session, no tenant, no capability. So the test proves both halves — the content is present
 * and non-trivial, and the route carries `@Public()`/`@NoTenant()` with no capability metadata
 * a guard could demand. No database and no e2e journey: there is nothing tenant-specific to
 * scope and nothing to persist.
 */
describe('TrustContentController', () => {
  const controller = new TrustContentController(new TrustContentService());

  it('returns control sections and a non-empty subprocessor list', () => {
    const view = controller.getTrust();
    expect(view.controls.length).toBeGreaterThan(0);
    for (const section of view.controls) {
      expect(section.controls.length).toBeGreaterThan(0);
    }
    expect(view.subprocessors.length).toBeGreaterThan(0);
    for (const sub of view.subprocessors) {
      expect(sub.name).not.toBe('');
      expect(sub.purpose).not.toBe('');
    }
    expect(view.statusPath).toBe('/status');
  });

  it('is public, tenant-less, and requires no capability', () => {
    const handler = TrustContentController.prototype.getTrust;
    expect(Reflect.getMetadata(IS_PUBLIC, handler)).toBe(true);
    expect(Reflect.getMetadata(SKIPS_TENANT, handler)).toBe(true);
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, handler)).toBeUndefined();
  });

  it('54-17: the data-location read is public and names the configured region label', () => {
    const service = new DataLocationService();
    expect(service.getDataLocation({ TMANAGE_DATA_REGION_LABEL: ' Germany (Hostinger) ' })).toEqual(
      { region: 'default', regionLabel: 'Germany (Hostinger)', updatedOn: '2026-10-29' },
    );
    expect(service.getDataLocation({}).regionLabel).toBeNull();
    const handler = TrustContentController.prototype.getDataLocation;
    expect(Reflect.getMetadata(IS_PUBLIC, handler)).toBe(true);
    expect(Reflect.getMetadata(SKIPS_TENANT, handler)).toBe(true);
  });
});
