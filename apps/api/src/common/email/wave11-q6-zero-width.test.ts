import { describe, expect, it } from 'vitest';
import { composeInvitationEmail, mailSafeName } from './invitation-email.js';

/**
 * Wave 11 Q6 (security run 3, M03 / F36 remainder): an invisible code point between the label
 * and the TLD split the run, so "evil<U+200B>.com" reached the mail looking like "evil.com".
 */
const cp = (code: number): string => String.fromCodePoint(code);

describe('mailSafeName refuses links hidden behind invisible code points', () => {
  const plain = mailSafeName('pay at evil.com');

  it.each([
    ['U+200B zero-width space', `pay at evil${cp(0x20_0b)}.com`],
    ['U+2060 word joiner', `pay at evil${cp(0x20_60)}.com`],
    ['U+00AD soft hyphen', `pay at ev${cp(0xad)}il.com`],
    ['U+FEFF byte-order mark', `pay at evil${cp(0xfe_ff)}.com`],
    ['U+3164 Hangul filler', `pay at evil${cp(0x31_64)}.com`],
    ['U+FFA0 half-width Hangul filler', `pay at evil${cp(0xff_a0)}.com`],
    ['U+034F grapheme joiner', `pay at evil${cp(0x03_4f)}.com`],
    ['U+180E Mongolian vowel separator', `pay at evil${cp(0x18_0e)}.com`],
    ['U+FE0F variation selector', `pay at evil${cp(0xfe_0f)}.com`],
    ['U+202E right-to-left override', `pay at evil${cp(0x20_2e)}.com`],
    ['U+2066 left-to-right isolate', `pay at evil${cp(0x20_66)}.com`],
    ['U+200D zero-width joiner', `pay at evil${cp(0x20_0d)}.com`],
  ])('%s is refused exactly as the visible link is', (_label, name) => {
    expect(plain).toBe('pay at …');
    expect(mailSafeName(name)).toBe(plain);
  });

  it.each([
    ['zero-width space', `evil${cp(0x20_0b)}.com`],
    ['word joiner', `evil${cp(0x20_60)}.com`],
    ['soft hyphen', `ev${cp(0xad)}il.com`],
    ['byte-order mark', `evil${cp(0xfe_ff)}.com`],
    ['Hangul filler', `evil${cp(0x31_64)}.com`],
  ])('a bare %s link collapses to the placeholder like "evil.com"', (_label, name) => {
    expect(mailSafeName(name)).toBe(mailSafeName('evil.com'));
    expect(mailSafeName(name)).toBe('—');
  });

  it('refuses an invisible split inside an email address and a phone number too', () => {
    expect(mailSafeName(`write to a${cp(0x20_0b)}@evil.com`)).toBe('write to …');
    expect(mailSafeName(`call +1 555${cp(0x20_60)}0100 now`)).toBe('call … now');
  });

  it('leaves no invisible code point in the subject, text or html', () => {
    const message = composeInvitationEmail({
      to: 'lina@example.com',
      clientOrganizationName: null,
      organizationName: `Northstar${cp(0x20_0b)} Studio pay at evil${cp(0x20_0b)}.com`,
      inviterName: `Omar${cp(0xfe_ff)} Farouk`,
      inviterEmail: 'omar@northstar.example',
      role: 'member',
      expiresAt: new Date('2026-09-13T12:00:00.000Z'),
      link: 'https://app.tmanage.example/invitations/tok123',
    });
    for (const part of [message.subject, message.text, message.html ?? '']) {
      expect(part).not.toContain(cp(0x20_0b));
      expect(part).not.toContain(cp(0xfe_ff));
      expect(part).not.toContain('evil');
    }
    expect(message.subject).toBe(
      'Omar Farouk invited you to Northstar Studio pay at … as Team member',
    );
  });
});

describe('Arabic names keep working (RLM is stripped silently, the name passes)', () => {
  const rlm = cp(0x20_0f);

  it('an Arabic name carrying U+200F the way the product writes it passes, mark removed', () => {
    expect(mailSafeName(`${rlm}شركة النور`)).toBe('شركة النور');
    expect(mailSafeName(`${rlm}شركة النور TManage`)).toBe('شركة النور TManage');
  });

  it('an Arabic name with U+200F before a hidden link is still refused', () => {
    expect(mailSafeName(`${rlm}ادفع على evil${cp(0x20_0b)}.com`)).toBe('ادفع على …');
  });

  it('the Arabic template still opens each mixed line with exactly one RLM', () => {
    const message = composeInvitationEmail({
      to: 'lina@example.com',
      clientOrganizationName: null,
      organizationName: `${rlm}شركة النور`,
      inviterName: 'عمر فاروق',
      inviterEmail: 'omar@northstar.example',
      role: 'member',
      expiresAt: new Date('2026-09-13T12:00:00.000Z'),
      link: 'https://app.tmanage.example/invitations/tok123',
      locale: 'ar-EG',
    });
    expect(message.text).toContain(`${rlm}أنت مدعو للانضمام إلى شركة النور على TManage`);
    expect(message.text).not.toContain(`${rlm}${rlm}`);
    expect(message.text).not.toContain(`إلى ${rlm}`);
  });
});
