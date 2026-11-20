import { describe, expect, it } from 'vitest';

import {
  ALLOWED_FINGERPRINTS_CAP,
  allowedStatementKey,
  createGuardEventLog,
} from './guard-event-log.js';
import { analyzeStatement } from './tenant-guard.js';
import type { TenantGuardEvent } from './tenant-guard.js';

function event(
  fingerprint: string,
  allowedReason?: string,
  shape = `select ? from invitations where id = ${fingerprint}`,
): TenantGuardEvent {
  return {
    organizationId: 'org-1',
    correlationId: 'corr-1',
    mode: 'enforce',
    statementKind: 'select',
    tenantTables: ['invitations'],
    violations: [],
    fingerprint,
    shape,
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

  it('QA-FIX-R: an IN list or VALUES batch of another size is the same statement', () => {
    const written: string[] = [];
    const repeats: string[] = [];
    const log = createGuardEventLog((e) => written.push(e.fingerprint), {
      debug: (e) => repeats.push(e.fingerprint),
    });
    const reason = 'upload sweep reads every organization';
    const inList = (n: number) =>
      `select organization_id from upload_sessions where id in ( ${Array(n).fill('?').join(' , ')} )`;
    const values = (n: number) =>
      `insert into t ( a , b ) values ${Array(n).fill('( ? , ? )').join(' , ')}`;
    log(event('in1', reason, inList(1)));
    log(event('in3', reason, inList(3)));
    log(event('in50', reason, inList(50)));
    log(event('v1', reason, values(1)));
    log(event('v7', reason, values(7)));
    expect(written).toEqual(['in1', 'v1']);
    expect(repeats).toEqual(['in3', 'in50', 'v7']);
  });

  it('the key folds the shapes the guard itself renders', () => {
    const reason = 'upload sweep reads every organization';
    const shapeOf = (sql: string) => analyzeStatement(sql, [], 'org-1').shape;
    const a = shapeOf('SELECT organization_id FROM upload_sessions WHERE id IN (?, ?)');
    const b = shapeOf('SELECT organization_id FROM upload_sessions WHERE id IN (?,?,?,?,?)');
    expect(a).not.toBe(b);
    expect(allowedStatementKey(event('a', reason, a))).toBe(
      allowedStatementKey(event('b', reason, b)),
    );
  });

  it('the same shape under another audited reason is its own line', () => {
    const written: string[] = [];
    const log = createGuardEventLog((e) => written.push(e.fingerprint));
    log(event('a', 'invitation sweep crosses every organization', 'select ? from x'));
    log(event('b', 'relay reads the outbox of every organization', 'select ? from x'));
    expect(written).toEqual(['a', 'b']);
  });

  it('past the cap, new allowed statements go to debug and the cap is reported once', () => {
    const written: string[] = [];
    const repeats: string[] = [];
    const caps: number[] = [];
    const log = createGuardEventLog((e) => written.push(e.fingerprint), {
      debug: (e) => repeats.push(e.fingerprint),
      capReached: (cap) => caps.push(cap),
    });
    const reason = 'invitation sweep crosses every organization';
    for (let i = 0; i < ALLOWED_FINGERPRINTS_CAP; i += 1) log(event(`f${String(i)}`, reason));
    log(event('extra', reason));
    log(event('extra2', reason));
    log(event('violation'));
    expect(written).toHaveLength(ALLOWED_FINGERPRINTS_CAP + 1);
    expect(written.at(-1)).toBe('violation');
    expect(repeats).toEqual(['extra', 'extra2']);
    expect(caps).toEqual([ALLOWED_FINGERPRINTS_CAP]);
  });
});
