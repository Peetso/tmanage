import { describe, expect, it, vi } from 'vitest';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformAdminRepository } from '../platform-admin.repository.js';
import { IntegrationsService, integrationView } from './integrations.service.js';
import type { IntegrationCounts, PlatformSettingsRepository } from './settings.repository.js';

/** PA-10 · D1 integrations: configured = env present (read only), switch, counts, last error. */

const ctx = { correlationId: 'c', ip: null, userAgent: null };
const actor: PlatformAdminActor = {
  account: {
    userId: 'u',
    email: 'peter@example.com',
    displayName: 'Peter',
    emailVerified: true,
    mfaEnabled: true,
  },
  sessionId: 's',
  stepUp: null,
};
const GOOGLE = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' };

const counts: IntegrationCounts = {
  storage: {
    google_drive: {
      connected: 41,
      lastSuccessAt: new Date('2026-10-28T10:00:00Z'),
      lastErrorAt: null,
      lastErrorCode: null,
    },
    onedrive: {
      connected: 17,
      lastSuccessAt: null,
      lastErrorAt: new Date('2026-10-28T08:00:00Z'),
      lastErrorCode: 'token_refresh_failed',
    },
  },
  calendar: {
    google: { connected: 33, lastSuccessAt: null, lastErrorAt: null, lastErrorCode: null },
  },
  grants: { connected: 2, lastSuccessAt: null, lastErrorAt: null, lastErrorCode: null },
};

describe('integrationView', () => {
  it('configured when the server keys are present, enabled by default, with the counts', () => {
    const view = integrationView('google_drive', GOOGLE, undefined, counts);
    expect(view).toMatchObject({
      configured: true,
      missingEnvironment: [],
      enabled: true,
      connectedOrganizations: 41,
      lastSuccessAt: '2026-10-28T10:00:00.000Z',
    });
  });

  it('not configured names the missing variables and is never enabled', () => {
    const view = integrationView('microsoft_calendar', {}, undefined, counts);
    expect(view.configured).toBe(false);
    expect(view.enabled).toBe(false);
    expect(view.missingEnvironment).toEqual(['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET']);
    expect(view.connectedOrganizations).toBe(0);
  });

  it('the stored switch turns it off; the last error is reported', () => {
    const env = { MICROSOFT_CLIENT_ID: 'id', MICROSOFT_CLIENT_SECRET: 's' };
    const view = integrationView(
      'onedrive',
      env,
      { value: 'off', updatedAt: null, updatedBy: null },
      counts,
    );
    expect(view.enabled).toBe(false);
    expect(view.lastErrorCode).toBe('token_refresh_failed');
    expect(view.connectedOrganizations).toBe(17);
  });

  it('MCP is forced off by TMANAGE_MCP_DISABLED', () => {
    const view = integrationView('mcp', { TMANAGE_MCP_DISABLED: '1' }, undefined, counts);
    expect(view).toMatchObject({ configured: true, environmentForcedOff: true, enabled: false });
  });
});

describe('IntegrationsService.setEnabled', () => {
  function harness(env: NodeJS.ProcessEnv) {
    const store = {
      readAll: vi.fn(async () => new Map()),
      integrationCounts: vi.fn(async () => counts),
    } as unknown as PlatformSettingsRepository;
    const writeSetting = vi.fn(async () => undefined);
    const repository = { writeSetting } as unknown as PlatformAdminRepository;
    return { service: new IntegrationsService(store, repository, env), writeSetting };
  }

  it('needs a reason (400, nothing written)', async () => {
    const { service, writeSetting } = harness(GOOGLE);
    await expect(
      service.setEnabled(actor, 'google_drive', { enabled: false }, ctx),
    ).rejects.toMatchObject({ status: 400 });
    expect(writeSetting).not.toHaveBeenCalled();
  });

  it('writes integration.<key> with the audit row', async () => {
    const { service, writeSetting } = harness(GOOGLE);
    await service.setEnabled(
      actor,
      'google_drive',
      { enabled: false, reason: 'Google outage today' },
      ctx,
    );
    expect(writeSetting).toHaveBeenCalledWith(
      'integration.google_drive',
      'off',
      expect.objectContaining({ action: 'platform.integration_disabled' }),
    );
  });

  it('the MCP row writes the platform AI switch', async () => {
    const { service, writeSetting } = harness({});
    await service.setEnabled(actor, 'mcp', { enabled: false, reason: 'Pause AI apps' }, ctx);
    expect(writeSetting).toHaveBeenCalledWith('ai_access', 'off', expect.anything());
  });

  it('refuses a switch without server keys (409) and an unknown integration (404)', async () => {
    const { service, writeSetting } = harness({});
    await expect(
      service.setEnabled(actor, 'onedrive', { enabled: true, reason: 'Turn it on' }, ctx),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.setEnabled(actor, 'dropbox', { enabled: true, reason: 'Turn it on' }, ctx),
    ).rejects.toMatchObject({ status: 404 });
    expect(writeSetting).not.toHaveBeenCalled();
  });
});
