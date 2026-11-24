import { MAIL_LAYOUT_MARK } from '@tmanage/mail';
import { describe, expect, it } from 'vitest';
import type { PublicLinkCodeRow, PublicLinkRow } from '../../common/database/schema.js';
import { PublicLinkSecrets } from '../public-links/public-link-secrets.js';
import {
  PortalSignInService,
  type PortalSignInStore,
  type PortalSignInTx,
} from './portal-sign-in.service.js';

const CLIENT = { userId: 'u-1', membershipId: 'm-1', email: 'sara@client.com' };
const BODY = { orgSlug: 'northwind', email: 'Sara@Client.com' };

function harness() {
  let now = new Date('2026-11-08T10:00:00Z');
  const links = new Map<string, PublicLinkRow>();
  const codes = new Map<string, PublicLinkCodeRow>();
  const auth: { userId: string | null; outcome: string; reason: string | null }[] = [];
  const mail: { to: string; text: string; html?: string }[] = [];
  const tx: PortalSignInTx = {
    findLink: async (id) => links.get(id) ?? null,
    insertLink: async (row) => void links.set(row.id, { ...row }),
    revokeLiveFor: async () => 0,
    revoke: async (id, at) => {
      const l = links.get(id)!;
      if (l.revokedAt) return false;
      l.revokedAt = at;
      return true;
    },
    recordOpen: async (id) => {
      const l = links.get(id)!;
      if (l.uses >= (l.maxUses ?? Infinity)) return false;
      l.uses += 1;
      return true;
    },
    countIssuedSince: async () => 0,
    newestLiveFor: async () => [...links.values()].at(-1) ?? null,
    appendEvent: async () => undefined,
    putCode: async (linkId, codeHash, expiresAt, at) =>
      void codes.set(linkId, {
        linkId,
        organizationId: 'o-1',
        codeHash,
        expiresAt,
        attempts: 0,
        createdAt: at,
      }),
    findCode: async (id) => codes.get(id) ?? null,
    countCodeAttempt: async (id) => void (codes.get(id)!.attempts += 1),
    deleteCode: async (id) => void codes.delete(id),
    organizationName: async () => 'Northwind',
    organizationSlug: async () => 'northwind',
  };
  const secrets = new PublicLinkSecrets('test-pepper');
  const byHash = () => new Map([...links.values()].map((l) => [l.tokenHash, l]));
  const store: PortalSignInStore = {
    findOrganization: async (slug) => (slug === 'northwind' ? { id: 'o-1' } : null),
    findEligibleClient: async (_o, email) => (email === CLIENT.email ? CLIENT : null),
    stillEligible: async () => CLIENT,
    findLinkByHash: async (hash) => {
      const l = byHash().get(hash);
      return l ? { id: l.id, organizationId: l.organizationId } : null;
    },
    transaction: (_o, _c, work) => work(tx),
    recordAuthEvent: async (e) =>
      void auth.push({ userId: e.userId, outcome: e.outcome, reason: e.reason }),
    countFailedOpens: async () =>
      auth.filter((e) => e.outcome === 'failed' && e.reason?.startsWith('link_')).length,
  };
  const mailer = {
    send: async (m: { to: string; text: string; html?: string }) => void mail.push(m),
  };
  const service = new PortalSignInService({
    store,
    secrets,
    mailer: mailer as never,
    webOrigin: 'https://app.test',
    now: () => now,
  });
  const lastToken = () => /portal-sign-in\/(tmanage_lnk_[\w-]+)/u.exec(mail.at(-1)!.text)![1]!;
  const lastCode = () => /page instead: (\d{6})/u.exec(mail.at(-1)!.text)?.[1];
  const advance = (ms: number) => (now = new Date(now.getTime() + ms));
  return { service, auth, mail, lastToken, lastCode, advance };
}

describe('55-14 portal magic-link sign-in', () => {
  it('answers the same for a non-client and mails nobody', async () => {
    const h = harness();
    await expect(h.service.request({ ...BODY, email: 'x@else.com' }, {})).resolves.toEqual({
      status: 'sent',
    });
    expect(h.mail).toHaveLength(0);
    expect(h.auth[0]).toMatchObject({ outcome: 'failed', reason: 'magic_link_not_eligible' });
  });

  it('signs in once; a second use is the flat 404 of an unknown token', async () => {
    const h = harness();
    await h.service.request(BODY, {});
    const token = h.lastToken();
    await expect(h.service.consume(token, {})).resolves.toMatchObject({ userId: 'u-1' });
    expect(h.auth.at(-1)).toMatchObject({ userId: 'u-1', outcome: 'succeeded', reason: null });
    await expect(h.service.consume(token, {})).rejects.toMatchObject({ status: 404 });
    await expect(h.service.consume('tmanage_lnk_' + 'a'.repeat(43), {})).rejects.toMatchObject({
      status: 404,
    });
  });

  it('refuses a link after 15 minutes and records a failed open', async () => {
    const h = harness();
    await h.service.request(BODY, {});
    h.advance(15 * 60_000 + 1);
    await expect(h.service.preview(h.lastToken(), {})).resolves.toEqual({ state: 'expired' });
    await expect(h.service.consume(h.lastToken(), {})).rejects.toMatchObject({ status: 409 });
    expect(h.auth.filter((e) => e.reason === 'link_expired')).toHaveLength(2);
  });

  it('mails a 6-digit code only after three failed opens, and the code signs in once', async () => {
    const h = harness();
    for (let i = 0; i < 3; i += 1) {
      await h.service.request(BODY, {});
      expect(h.lastCode()).toBeUndefined();
      h.advance(16 * 60_000);
      await h.service.preview(h.lastToken(), {}).catch(() => undefined);
    }
    await h.service.request(BODY, {});
    const code = h.lastCode()!;
    expect(code).toMatch(/^\d{6}$/u);
    const wrong = code === '000000' ? '111111' : '000000';
    await expect(h.service.verifyCode({ ...BODY, code: wrong }, {})).rejects.toMatchObject({
      status: 400,
    });
    await expect(h.service.verifyCode({ ...BODY, code }, {})).resolves.toMatchObject({
      userId: 'u-1',
    });
    expect(h.auth.at(-1)).toMatchObject({ outcome: 'succeeded', reason: 'code_fallback' });
    await expect(h.service.verifyCode({ ...BODY, code }, {})).rejects.toMatchObject({
      status: 400,
    });
  });

  it('"Not you?" revokes the link and tells the address', async () => {
    const h = harness();
    await h.service.request(BODY, {});
    const token = h.lastToken();
    await h.service.notYou(token, {});
    expect(h.mail.at(-1)).toMatchObject({ to: 'sara@client.com' });
    expect(h.mail.at(-1)!.text).toContain('cancelled');
    // MAILDESIGN: both mails carry the shared layout beside the text part.
    expect(h.mail.at(-1)!.html).toContain(MAIL_LAYOUT_MARK);
    expect(h.mail.at(-2)!.html).toContain(MAIL_LAYOUT_MARK);
    expect(h.mail.at(-2)!.html).toContain(`href="https://app.test/portal-sign-in/${token}"`);
    await expect(h.service.preview(token, {})).resolves.toEqual({ state: 'revoked' });
    await expect(h.service.consume(token, {})).rejects.toMatchObject({ status: 409 });
  });
});
