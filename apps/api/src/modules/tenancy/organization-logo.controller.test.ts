import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { OrganizationLogoController } from './organization-logo.controller.js';
import type {
  OrganizationLogoInput,
  OrganizationLogoRepository,
} from './organization-logo.repository.js';
import { acceptLogo } from './organization-logo-image.js';

/** C6 — the organization-scoped company logo routes over fakes, with the real `authorize`. */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const context = { organizationId: ORG, userId: 'u1' } as unknown as TenantContext;

function principal(role: Principal['role']): Principal {
  return {
    userId: '00000000-0000-4000-8000-0000000000c1',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: '00000000-0000-4000-8000-0000000000e1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

class FakeLogos {
  stored: OrganizationLogoInput | null = null;
  removed = 0;
  findInfo() {
    return Promise.resolve(
      this.stored
        ? {
            mimeType: this.stored.mimeType,
            sizeBytes: this.stored.sizeBytes,
            version: 1,
            updatedAt: new Date('2026-10-25T10:00:00.000Z'),
          }
        : null,
    );
  }
  findImage() {
    return Promise.resolve(null);
  }
  upsert(_r: unknown, _c: unknown, input: OrganizationLogoInput) {
    this.stored = input;
    return Promise.resolve();
  }
  remove() {
    this.removed += 1;
    this.stored = null;
    return Promise.resolve();
  }
}

function controllerWith(logos: FakeLogos, audit: { action: string; metadata: unknown }[] = []) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const auditService = {
    record: (_tx: unknown, _c: unknown, event: { action: string; metadata: unknown }) => {
      audit.push({ action: event.action, metadata: event.metadata });
      return Promise.resolve({});
    },
  };
  return new OrganizationLogoController(
    database,
    logos as unknown as OrganizationLogoRepository,
    auditService as never,
  );
}

async function errorOf(promise: Promise<unknown>): Promise<ApiError | undefined> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  return error instanceof ApiError ? error : undefined;
}

describe('OrganizationLogoController', () => {
  it('stores a PNG for the organization, with no project, and audits it', async () => {
    const logos = new FakeLogos();
    const audit: { action: string; metadata: unknown }[] = [];
    const view = await controllerWith(logos, audit).upload(context, principal('owner'), {
      mimeType: 'image/png',
      dataBase64: PNG.toString('base64'),
    });
    expect(view.logo?.mimeType).toBe('image/png');
    expect(logos.stored?.contentBase64).toBe(PNG.toString('base64'));
    expect(audit).toEqual([
      { action: 'organization.logo_changed', metadata: { change: 'set', sanitized: false } },
    ]);
  });

  it('stores the sanitised SVG, never the bytes that were sent', async () => {
    const logos = new FakeLogos();
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" onload="steal()"><script>x()</script><circle r="3"/></svg>';
    await controllerWith(logos).upload(context, principal('org_admin'), {
      mimeType: 'image/svg+xml',
      dataBase64: Buffer.from(svg).toString('base64'),
    });
    const stored = Buffer.from(logos.stored!.contentBase64, 'base64').toString('utf8');
    expect(stored).toBe('<svg xmlns="http://www.w3.org/2000/svg"><circle r="3"/></svg>');
    expect(logos.stored?.mimeType).toBe('image/svg+xml');
  });

  it('refuses an SVG that cannot be made safe, with a message the card can show', async () => {
    const logos = new FakeLogos();
    const error = await errorOf(
      controllerWith(logos).upload(context, principal('owner'), {
        mimeType: 'image/svg+xml',
        dataBase64: Buffer.from('<!DOCTYPE svg [<!ENTITY a "b">]><svg/>').toString('base64'),
      }),
    );
    expect(error?.status).toBe(400);
    expect(error?.message).toMatch(/cannot be made safe/);
    expect(logos.stored).toBeNull();
  });

  it('refuses a file whose bytes are not the image type it claims', async () => {
    const error = await errorOf(
      controllerWith(new FakeLogos()).upload(context, principal('owner'), {
        mimeType: 'image/png',
        dataBase64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),
      }),
    );
    expect(error?.status).toBe(400);
  });

  it('refuses a member without org.manage before reading the body', async () => {
    const logos = new FakeLogos();
    const error = await errorOf(
      controllerWith(logos).upload(context, principal('member'), { mimeType: 'image/png' }),
    );
    expect(error?.status).toBe(403);
    expect(await errorOf(controllerWith(logos).remove(context, principal('member')))).toBeDefined();
    expect(logos.removed).toBe(0);
  });

  it('Remove deletes the logo and audits it', async () => {
    const logos = new FakeLogos();
    const audit: { action: string; metadata: unknown }[] = [];
    expect(await controllerWith(logos, audit).remove(context, principal('owner'))).toEqual({
      logo: null,
    });
    expect(logos.removed).toBe(1);
    expect(audit[0]).toEqual({
      action: 'organization.logo_changed',
      metadata: { change: 'removed' },
    });
  });
});

describe('acceptLogo', () => {
  it('accepts JPEG and WebP by signature and refuses GIF and oversize files', () => {
    expect(acceptLogo('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])).ok).toBe(true);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
    expect(acceptLogo('image/webp', webp).ok).toBe(true);
    expect(acceptLogo('image/gif', Buffer.from('GIF89a....')).ok).toBe(false);
    const big = Buffer.concat([PNG, Buffer.alloc(512 * 1024)]);
    expect(acceptLogo('image/png', big)).toMatchObject({ ok: false, code: 'too_large' });
  });
});
