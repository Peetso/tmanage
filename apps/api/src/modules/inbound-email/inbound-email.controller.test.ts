import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { InboundEmailController } from './inbound-email.controller.js';

/** R21-f — every route carries a capability; none is reachable without one. */
describe('InboundEmailController (R21-f)', () => {
  it('gates the address routes on org.manage and the triage routes on client_request.triage', () => {
    const proto = InboundEmailController.prototype as unknown as Record<string, object>;
    const caps = Object.fromEntries(
      ['address', 'create', 'rotate', 'log', 'attachments', 'trust'].map((name) => {
        const keys = Reflect.getMetadataKeys(proto[name] as object);
        const values = keys.map(
          (key: unknown) => Reflect.getMetadata(key, proto[name] as object) as unknown,
        );
        return [name, values.find((v) => typeof v === 'string' && v.includes('.'))];
      }),
    );
    expect(caps).toEqual({
      address: 'org.manage',
      create: 'org.manage',
      rotate: 'org.manage',
      log: 'client_request.triage',
      attachments: 'client_request.triage',
      trust: 'client_request.triage',
    });
  });
});
