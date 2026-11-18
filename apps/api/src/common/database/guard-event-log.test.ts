import { describe, expect, it } from 'vitest';

import { ALLOWED_FINGERPRINTS_CAP, createGuardEventLog } from './guard-event-log.js';
import type { TenantGuardEvent } from './tenant-guard.js';

function event(fingerprint: string, allowedReason?: string): TenantGuardEvent {
  return {
    organizationId: 'org-1',
    correlationId: 'corr-1',
    mode: 'enforce',
    statementKind: 'select',
    tenantTables: ['invitations'],
    violations: [],
    fingerprint,
    shape: 'select ? from invitations',
    ...(allowedReason === undefined ? {} : { allowedReason }),
  };
}

describe('createGuardEventLog', () => {
  it('logs an allowed cross-tenant statement once per fingerprint', () => {
    const written: string[] = [];
    const log = createGuardEventLog((e) => written.push(e.fingerprint));
    const reason = 'invitation sweep crosses every organization';
    log(event('a', reason));
    log(event('a', reason));
    log(event('b', reason));
    log(event('a', reason));
    expect(written).toEqual(['a', 'b']);
  });

  it('logs a real violation every time, even with a fingerprint already seen as allowed', () => {
    const written: string[] = [];
    const log = createGuardEventLog((e) => written.push(e.fingerprint));
    log(event('a', 'invitation sweep crosses every organization'));
    log(event('a'));
    log(event('a'));
    expect(written).toEqual(['a', 'a', 'a']);
  });

  it('past the cap, allowed statements are logged every time again', () => {
    const written: string[] = [];
    const log = createGuardEventLog((e) => written.push(e.fingerprint));
    const reason = 'invitation sweep crosses every organization';
    for (let i = 0; i < ALLOWED_FINGERPRINTS_CAP; i += 1) log(event(`f${String(i)}`, reason));
    log(event('extra', reason));
    log(event('extra', reason));
    expect(written.filter((f) => f === 'extra')).toHaveLength(2);
  });
});
