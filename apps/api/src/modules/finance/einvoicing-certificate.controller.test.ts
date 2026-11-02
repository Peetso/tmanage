import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { EinvoiceSigningService } from './einvoice-signing.service.js';
import { EinvoicingCertificateController } from './einvoicing-certificate.controller.js';

/** 52-12 (R22-a): the route guards and that the header + session reach the service's step-up. */
describe('EinvoicingCertificateController', () => {
  const capabilityOf = (key: string): unknown =>
    Reflect.getMetadata(
      REQUIRED_CAPABILITY,
      (EinvoicingCertificateController.prototype as unknown as Record<string, object>)[key]!,
    );

  it('reads with finance.manage; PUT and DELETE need org.security.manage', () => {
    expect(capabilityOf('get')).toBe('finance.manage');
    expect(capabilityOf('put')).toBe('org.security.manage');
    expect(capabilityOf('remove')).toBe('org.security.manage');
  });

  it('passes the x-reauth-token and the session id to the step-up', async () => {
    const replace = vi.fn(async () => ({}) as never);
    const revoke = vi.fn(async () => undefined);
    const controller = new EinvoicingCertificateController({
      replace,
      revoke,
    } as unknown as EinvoiceSigningService);
    const context = {} as TenantContext;
    const principal = {} as Principal;
    await controller.put(context, principal, { a: 1 }, 'tok', { sessionId: 's1' } as never);
    await controller.remove(context, principal, undefined, undefined);
    expect(replace).toHaveBeenCalledWith(
      context,
      principal,
      { a: 1 },
      {
        reauthToken: 'tok',
        sessionId: 's1',
      },
    );
    expect(revoke).toHaveBeenCalledWith(context, principal, {
      reauthToken: undefined,
      sessionId: undefined,
    });
  });
});
