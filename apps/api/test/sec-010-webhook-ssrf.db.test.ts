import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { WebhooksController } from '../src/modules/automations/webhooks.controller.js';
import { WebhooksRepository } from '../src/modules/automations/webhooks.repository.js';
import { checkWebhookUrl } from '../src/modules/automations/url-guard.js';
import { ApiError } from '../src/common/http/errors.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * SEC-010 — the outbound-webhook SSRF boundary (write-time), against a real server.
 *
 * The register surface is an SSRF vector: a URL stored here is one the server would later POST to,
 * from inside the deployment's network. This suite proves the boundary two ways that only together
 * are convincing:
 *
 * 1. **The guard's matrix** — {@link checkWebhookUrl} directly, every rejection class and the one
 *    allow, so a regression in a single branch is named.
 * 2. **The real write path** — {@link WebhooksController.register} against local MySQL: a rejected
 *    URL is a 400 whose only `details` entry is the `url` field, and (the point) leaves NO
 *    `webhook_endpoints` row; the one allowed URL is a 201-shaped view and the single row written.
 *
 * ## Scope (honest)
 *
 * The guard is **literal** by design — it judges the scheme and the host as written and does not
 * resolve DNS. DNS rebinding (a public name that resolves private at delivery) and redirect
 * following are delivery-time TOCTOU problems a write-time name check cannot close; they belong to
 * the delivery egress slice (wave 2, Needs-Peter) and are deliberately NOT asserted here. This
 * suite does not weaken the guard to "pass" either, and no bypass was found: url-guard.ts is
 * unchanged by this slice.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let ownerCtx: TenantContext;
let owner: Principal;
let controller: WebhooksController;

const VALID_SECRET = 'a-signing-secret-long-enough';
const VALID_EVENT_KIND = 'work.created';

async function countEndpoints(): Promise<number> {
  const [rows] = await db.admin.query<RowDataPacket[]>(
    `select count(*) as n from webhook_endpoints where organization_id = ?`,
    [world.northstar.organizationId],
  );
  return Number(rows[0]?.['n']);
}

/**
 * Register through the real controller path with a candidate URL, holding the event kind and secret
 * valid so the URL is the only thing that can fail. Returns the thrown ApiError, or throws if the
 * register unexpectedly succeeded.
 */
async function expectRejected(url: string): Promise<ApiError> {
  const before = await countEndpoints();
  try {
    await controller.register(ownerCtx, owner, {
      url,
      eventKind: VALID_EVENT_KIND,
      secret: VALID_SECRET,
    });
  } catch (error) {
    expect(error, `register(${url}) should throw ApiError`).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status, `register(${url}) status`).toBe(400);
    expect(apiError.code).toBe('validation_failed');
    // The ONLY reason for the refusal must be the URL — not a stray secret/eventKind complaint.
    expect(apiError.details ?? []).toHaveLength(1);
    expect(apiError.details?.[0]?.field).toBe('url');
    // And no row was written: the register is the whole boundary.
    expect(await countEndpoints(), `register(${url}) must write no row`).toBe(before);
    return apiError;
  }
  throw new Error(`expected register(${url}) to be refused, but it succeeded`);
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });

  ownerCtx = createTenantContext({
    organizationId: world.northstar.organizationId,
    userId: world.northstar.owner.id,
    membershipId: world.northstar.owner.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-08-30',
    correlationId: uuidv7(),
  });
  owner = {
    userId: ownerCtx.userId,
    organizationId: ownerCtx.organizationId,
    kind: 'internal',
    role: 'owner',
    membershipId: ownerCtx.membershipId,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };

  controller = new WebhooksController(tenant, new WebhooksRepository());
});

afterAll(async () => {
  await db?.stop();
});

/**
 * The pure guard matrix. No DB — but this is where every rejection class and the single allow are
 * pinned individually, so a regression in one branch of url-guard.ts fails by name here even if the
 * write-path cases below only sample each class.
 */
describe('checkWebhookUrl — the literal guard matrix', () => {
  it('rejects every non-https scheme', () => {
    for (const url of [
      'http://example.com/hook',
      'ftp://example.com/hook',
      'file:///etc/passwd',
      'gopher://example.com/',
    ]) {
      const verdict = checkWebhookUrl(url);
      expect(verdict.ok, url).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('must use https');
    }
  });

  it('rejects embedded user:pass credentials', () => {
    for (const url of ['https://user:pass@example.com/hook', 'https://user@example.com/hook']) {
      const verdict = checkWebhookUrl(url);
      expect(verdict.ok, url).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('must not embed credentials');
    }
  });

  it('rejects localhost, *.localhost and *.local', () => {
    for (const host of ['localhost', 'api.localhost', 'printer.local', 'host.sub.local']) {
      const verdict = checkWebhookUrl(`https://${host}/hook`);
      expect(verdict.ok, host).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('must not point at an internal host');
    }
  });

  it('rejects private / loopback / link-local / CGNAT IPv4 literals', () => {
    for (const host of [
      '0.0.0.0',
      '10.0.0.1',
      '127.0.0.1',
      '169.254.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1',
    ]) {
      const verdict = checkWebhookUrl(`https://${host}/hook`);
      expect(verdict.ok, host).toBe(false);
      if (!verdict.ok)
        expect(verdict.reason).toBe('must not point at a private, loopback or metadata address');
    }
  });

  it('rejects the cloud metadata literal 169.254.169.254', () => {
    const verdict = checkWebhookUrl('https://169.254.169.254/latest/meta-data/');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok)
      expect(verdict.reason).toBe('must not point at a private, loopback or metadata address');
  });

  it('rejects IPv6 loopback, ULA, link-local and IPv4-mapped literals', () => {
    for (const host of [
      '[::1]',
      '[::]',
      '[fc00::1]',
      '[fd12:3456::1]',
      '[fe80::1]',
      '[::ffff:127.0.0.1]',
      '[::ffff:169.254.169.254]',
    ]) {
      const verdict = checkWebhookUrl(`https://${host}/hook`);
      expect(verdict.ok, host).toBe(false);
      if (!verdict.ok)
        expect(verdict.reason).toBe('must not point at a private, loopback or metadata address');
    }
  });

  it('rejects a malformed URL', () => {
    const verdict = checkWebhookUrl('not a url');
    expect(verdict.ok).toBe(false);
  });

  it('allows a plain public https host, and a public IP literal', () => {
    for (const url of [
      'https://hooks.example.com/path?x=1',
      'https://8.8.8.8/hook',
      'https://[2606:4700:4700::1111]/hook',
    ]) {
      expect(checkWebhookUrl(url).ok, url).toBe(true);
    }
  });
});

/**
 * The real write path. Each rejected target is a 400 whose only field is `url`, and leaves no row;
 * the one allowed target is the single row written and a view that never echoes the secret.
 */
describe('the register write path refuses SSRF targets and writes no row', () => {
  it('starts from an empty endpoint table for this tenant', async () => {
    expect(await countEndpoints()).toBe(0);
  });

  it('rejects a non-https scheme (400, no row)', async () => {
    const error = await expectRejected('http://example.com/hook');
    expect(error.details?.[0]?.message).toBe('must use https');
  });

  it('rejects embedded credentials (400, no row)', async () => {
    const error = await expectRejected('https://user:pass@example.com/hook');
    expect(error.details?.[0]?.message).toBe('must not embed credentials');
  });

  it('rejects localhost (400, no row)', async () => {
    const error = await expectRejected('https://localhost/hook');
    expect(error.details?.[0]?.message).toBe('must not point at an internal host');
  });

  it('rejects a *.local host (400, no row)', async () => {
    await expectRejected('https://nas.local/hook');
  });

  it('rejects a private IPv4 (400, no row)', async () => {
    await expectRejected('https://10.0.0.5/hook');
  });

  it('rejects a loopback IPv4 (400, no row)', async () => {
    await expectRejected('https://127.0.0.1/hook');
  });

  it('rejects a CGNAT IPv4 (400, no row)', async () => {
    await expectRejected('https://100.64.0.1/hook');
  });

  it('rejects the metadata literal 169.254.169.254 (400, no row)', async () => {
    const error = await expectRejected('https://169.254.169.254/latest/meta-data/');
    expect(error.details?.[0]?.message).toBe(
      'must not point at a private, loopback or metadata address',
    );
  });

  it('rejects an IPv6 ULA literal (400, no row)', async () => {
    await expectRejected('https://[fd00::1]/hook');
  });

  it('rejects an IPv6 link-local literal (400, no row)', async () => {
    await expectRejected('https://[fe80::1]/hook');
  });

  it('rejects an IPv4-mapped IPv6 loopback literal (400, no row)', async () => {
    await expectRejected('https://[::ffff:127.0.0.1]/hook');
  });

  it('still has written no rows after the whole rejection matrix', async () => {
    expect(await countEndpoints()).toBe(0);
  });

  it('allows a plain public https host: the one row written, secret never echoed', async () => {
    const view = await controller.register(ownerCtx, owner, {
      url: 'https://hooks.example.com/tmanage',
      eventKind: VALID_EVENT_KIND,
      secret: VALID_SECRET,
    });

    expect(view.url).toBe('https://hooks.example.com/tmanage');
    expect(view.eventKind).toBe(VALID_EVENT_KIND);
    expect(view.enabled).toBe(true);
    // The projection cannot carry the secret — prove it structurally and by value.
    expect(JSON.stringify(view)).not.toContain(VALID_SECRET);
    const viewRecord = view as unknown as Record<string, unknown>;
    // Create answers `secret: null` when the caller supplied their own (they already hold it);
    // only a generated secret is shown, once.
    expect(viewRecord['secret']).toBeNull();
    expect(viewRecord['secretHash']).toBeUndefined();

    expect(await countEndpoints()).toBe(1);

    // What landed is the hash, never the plaintext.
    const [rows] = await db.admin.query<RowDataPacket[]>(
      `select url, secret_hash from webhook_endpoints where organization_id = ? and id = ?`,
      [world.northstar.organizationId, view.id],
    );
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.['url'])).toBe('https://hooks.example.com/tmanage');
    expect(String(rows[0]?.['secret_hash'])).toBe(
      createHash('sha256').update(VALID_SECRET, 'utf8').digest('hex'),
    );
  });
});
