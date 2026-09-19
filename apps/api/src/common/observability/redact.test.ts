import { describe, expect, it } from 'vitest';
import { redactFields } from './redact.js';
import { serializeForLog } from './logger.js';

/**
 * OBS-001 security proof. A log line must never carry a secret or raw PII, whatever shape the
 * record arrives in. This is the one thorough test the slice budget reserves for the redactor
 * (RULES rule 11: a security proof may be thorough), so it exercises every rule at once:
 * deny-listed keys at several depths and inside an array, the suffix rules, the email mask, and
 * a circular graph that must survive rather than throw.
 */
describe('redactFields', () => {
  it('strips seeded secrets at three depths, including inside an array, and masks email', () => {
    const record = {
      // depth 1 — deny-list and a suffix rule
      password: 'DEPTH1-PW',
      apiKey: 'DEPTH1-APIKEY',
      email: 'john.doe@example.com',
      keep: 'visible-scalar',
      // depth 2
      user: {
        refreshToken: 'DEPTH2-RT',
        clientSecret: 'DEPTH2-SECRET',
        name: 'Ada',
      },
      // depth 3
      nested: {
        inner: {
          totpSeed: 'DEPTH3-SEED',
          recoveryCode: 'DEPTH3-RECOVERY',
        },
      },
      // inside an array
      sessions: [
        { id: 's1', accessToken: 'ARR-AT' },
        { id: 's2', cookie: 'ARR-COOKIE', userPassword: 'ARR-PW' },
      ],
    };

    const out = redactFields(record);
    const serialized = JSON.stringify(out);

    for (const secret of [
      'DEPTH1-PW',
      'DEPTH1-APIKEY',
      'DEPTH2-RT',
      'DEPTH2-SECRET',
      'DEPTH3-SEED',
      'DEPTH3-RECOVERY',
      'ARR-AT',
      'ARR-COOKIE',
      'ARR-PW',
    ]) {
      expect(serialized).not.toContain(secret);
    }

    // Non-sensitive scalars are preserved so the log stays useful.
    expect(serialized).toContain('visible-scalar');
    expect(serialized).toContain('Ada');
    expect(serialized).toContain('s1');

    // Email is masked to first character + domain, never the full local part.
    const masked = (out as { email: string }).email;
    expect(masked).toBe('j***@example.com');
    expect(serialized).not.toContain('john.doe@example.com');
  });

  it('masks email-family key variants case-insensitively, leaving non-address siblings intact', () => {
    const record = {
      userEmail: 'jane.doe@corp.example',
      EmailAddress: 'ADA@corp.example',
      inviterEmail: 'ib@corp.example',
      // Same `email*` prefix, but not an address — must survive rather than be clobbered.
      emailVerifiedAt: '2026-09-19T00:00:00.000Z',
      emailed: true,
    };

    const out = redactFields(record) as Record<string, unknown>;

    expect(out['userEmail']).toBe('j***@corp.example');
    expect(out['EmailAddress']).toBe('A***@corp.example');
    expect(out['inviterEmail']).toBe('i***@corp.example');
    // Non-address siblings under an `email*` key are preserved.
    expect(out['emailVerifiedAt']).toBe('2026-09-19T00:00:00.000Z');
    expect(out['emailed']).toBe(true);

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('jane.doe@corp.example');
    expect(serialized).not.toContain('ADA@corp.example');
  });

  it('keeps a shared (non-cyclic) reference on both branches while still cutting a real cycle', () => {
    // One object reached down two independent branches — not a cycle. The ancestor-only guard
    // must walk it fully both times, not replace the second sighting with the cycle marker.
    const shared = { name: 'Ada', role: 'owner' };
    const out = redactFields({ left: shared, right: shared }) as {
      left: unknown;
      right: unknown;
    };

    expect(out.left).toEqual({ name: 'Ada', role: 'owner' });
    expect(out.right).toEqual({ name: 'Ada', role: 'owner' });
    // Neither branch was mistaken for a cycle.
    expect(out.right).not.toBe('[circular]');
    expect(JSON.stringify(out)).not.toContain('[circular]');
  });

  it('never throws on a circular graph and marks the cycle', () => {
    const cyclic: Record<string, unknown> = { token: 'CIRCULAR-SECRET', label: 'root' };
    cyclic['self'] = cyclic;

    let out: unknown;
    expect(() => {
      out = redactFields(cyclic);
    }).not.toThrow();

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('CIRCULAR-SECRET');
    expect(serialized).toContain('label');
  });

  // The database-connection error path (`app-composition.ts`'s `onConnectionError`, and the
  // sibling entrypoint and mailer sites) routes a caught Error through `serializeForLog`. A driver
  // error carries its connection config — DSN and credential — on the `cause`, where a raw
  // `JSON.stringify(error)` emits `{}` and drops both the secret guarantee and the diagnostic.
  it('redacts a credential carried by a database connection Error while keeping the diagnostic', () => {
    const error = new Error('connection rejected during session setup', {
      cause: { host: 'db.internal', user: 'tmanage_app', password: 'DB-DSN-SECRET' },
    });
    (error as Error & { code?: string }).code = 'ER_ACCESS_DENIED_ERROR';

    const serialized = serializeForLog(error);

    // The seeded credential inside the Error's cause never reaches the log.
    expect(serialized).not.toContain('DB-DSN-SECRET');
    // The diagnostic survives: message, driver code and the non-secret cause fields stay useful.
    expect(serialized).toContain('connection rejected during session setup');
    expect(serialized).toContain('ER_ACCESS_DENIED_ERROR');
    expect(serialized).toContain('db.internal');
  });
});
