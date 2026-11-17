import { describe, expect, it } from 'vitest';
import { composeCollaborationEmail } from './collaboration-mailer.js';
import type { CollaborationEmailFacts } from './collaboration-mailer.js';

const facts: CollaborationEmailFacts = {
  recipientEmail: 'rami@example.com',
  recipientName: 'Rami',
  organizationName: 'Northstar Studio',
  actorName: 'Lina Samir',
  subjectTitle: 'Homepage concept',
  projectName: 'Website relaunch',
  versionNumber: 2,
  dueDate: '18 August',
  checkNote: 'Approving starts content migration.',
  link: 'https://app.example/northstar/portal/deliverables/ver-2',
};

describe('approval_requested email (t8-b)', () => {
  it('carries title, version, sender, due date, check note and the portal link in English', () => {
    const mail = composeCollaborationEmail('approval_requested', facts);
    expect(mail.subject).toBe('Your approval is needed: Homepage concept, version 2');
    expect(mail.text).toContain(
      'Lina Samir asked for your approval on Homepage concept, version 2.',
    );
    expect(mail.text).toContain('"Approving starts content migration."');
    expect(mail.text).toContain('Requested by 18 August.');
    expect(mail.text).toContain(facts.link);
    expect(mail.html).toContain(`href="${facts.link}"`);
    expect(mail.html).toContain('Review and decide');
    expect(mail.html).toContain('>LS</td>');
    expect(mail.html).toContain('This is an automatic notification');
    const client = composeCollaborationEmail('approval_requested', { ...facts, portal: true });
    expect(client.subject).toBe(
      'Northstar Studio: your approval is needed on Homepage concept, version 2',
    );
    expect(client.html).toContain('Sent by TManage on behalf of Northstar Studio.');
  });

  it('writes Arabic, right to left, for an ar locale', () => {
    const mail = composeCollaborationEmail('approval_requested', { ...facts, locale: 'ar-EG' });
    expect(mail.subject).toContain('مطلوب اعتمادك: Homepage concept، الإصدار 2');
    expect(mail.subject.startsWith(String.fromCharCode(0x20_0f))).toBe(true);
    expect(mail.text).toContain('مطلوب قبل 18 August.');
    expect(mail.html).toContain('dir="rtl"');
    expect(mail.html).toContain('Alexandria');
  });

  it('falls back to English for an unknown locale and escapes typed strings', () => {
    const mail = composeCollaborationEmail('approval_requested', {
      ...facts,
      locale: 'xx',
      subjectTitle: '<b>x</b>',
    });
    expect(mail.html).toContain('dir="ltr"');
    expect(mail.html).not.toContain('<b>x</b>');
  });
});
