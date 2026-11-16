import { describe, expect, it } from 'vitest';
import {
  isPlatformAdminEmail,
  parsePlatformAdminEmails,
  platformBootstrapLine,
  platformStepUpMinutes,
} from './platform-admin.access.js';
import { PlatformBootstrapReport } from './platform-bootstrap-report.js';

/**
 * PLATFORMFIX (2026-11-16): the owner set `PLATFORM_ADMIN_EMAILS` on the host, restarted, and
 * could not tell why Platform admin still answered 404; and asked for the step-up to last a day.
 */
describe('PLATFORM_ADMIN_EMAILS as typed into a hosting panel', () => {
  it('reads commas, semicolons, spaces, new lines, quotes and angle brackets, any case', () => {
    expect(
      parsePlatformAdminEmails(
        ' "Owner@Example.com, ops@example.com";<Third@Example.org>\n\'x@y.io\' ',
      ),
    ).toEqual(['owner@example.com', 'ops@example.com', 'third@example.org', 'x@y.io']);
  });

  it('drops junk and duplicates, and matches exactly (no prefix, no pattern)', () => {
    const list = parsePlatformAdminEmails('a@x.com, A@X.COM, not-an-email, @, a@@b, ""');
    expect(list).toEqual(['a@x.com']);
    expect(
      ['a@x.com', ' A@x.com ', 'a@x.co', 'a@x.com.evil', 'ba@x.com', ''].map((email) =>
        isPlatformAdminEmail(list, email),
      ),
    ).toEqual([true, true, false, false, false, false]);
  });
});

describe('the platform bootstrap start-up line (counts only)', () => {
  const confirmed = { emailVerified: true, mfaEnabled: true };
  it('says what is missing, never an address', () => {
    expect([
      platformBootstrapLine(0, [], true),
      platformBootstrapLine(1, [], true),
      platformBootstrapLine(1, [{ emailVerified: false, mfaEnabled: false }], true),
      platformBootstrapLine(1, [{ emailVerified: true, mfaEnabled: false }], true),
      platformBootstrapLine(1, [{ emailVerified: true, mfaEnabled: false }], false),
      platformBootstrapLine(2, [confirmed], true),
    ]).toEqual([
      'platform bootstrap: 0 address(es) configured; Platform admin is off',
      'platform bootstrap: 1 address(es) configured; 0 with an account, 0 confirmed, 0 can open Platform admin — no account with that address yet (sign up first)',
      'platform bootstrap: 1 address(es) configured; 1 with an account, 0 confirmed, 0 can open Platform admin — e-mail not confirmed yet (click the confirmation link)',
      'platform bootstrap: 1 address(es) configured; 1 with an account, 1 confirmed, 0 can open Platform admin — turn on two-step sign-in first',
      'platform bootstrap: 1 address(es) configured; 1 with an account, 1 confirmed, 1 can open Platform admin',
      'platform bootstrap: 2 address(es) configured; 1 with an account, 1 confirmed, 1 can open Platform admin',
    ]);
  });

  it('asks the database with the parsed list and survives a failed read', async () => {
    const asked: (readonly string[])[] = [];
    const report = new PlatformBootstrapReport(
      ['owner@example.com'],
      {
        bootstrapAccounts: async (emails) => {
          asked.push(emails);
          return [{ emailVerified: true, mfaEnabled: true }];
        },
      },
      true,
    );
    const failing = new PlatformBootstrapReport(
      ['owner@example.com'],
      { bootstrapAccounts: () => Promise.reject(new Error('db down')) },
      true,
    );
    expect([await report.line(), await failing.line(), asked]).toEqual([
      'platform bootstrap: 1 address(es) configured; 1 with an account, 1 confirmed, 1 can open Platform admin',
      'platform bootstrap: 1 address(es) configured; the account check failed',
      [['owner@example.com']],
    ]);
  });
});

describe('the Platform admin step-up window', () => {
  it('is 24 hours by default; PLATFORM_REAUTH_TTL_HOURS sets 1 to 24 whole hours, else default', () => {
    expect(
      [undefined, '', '1', '8', ' 24 ', '0', '25', '1.5', '-3', 'abc', '100'].map((value) =>
        platformStepUpMinutes(value === undefined ? {} : { PLATFORM_REAUTH_TTL_HOURS: value }),
      ),
    ).toEqual([1440, 1440, 60, 480, 1440, 1440, 1440, 1440, 1440, 1440, 1440]);
  });
});
