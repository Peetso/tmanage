import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import { ensureRequestState } from '../../common/http/request-state.js';
import type { RequestState } from '../../common/http/request-state.js';
import type { HeaderWriter } from '../files/download-response.js';
import { signReauthToken } from '../identity/reauth-token.js';
import { AdminPrivacyController, MyPrivacyController } from './privacy.controller.js';
import type { PrivacyService } from './privacy.service.js';
import { PRIVACY_REAUTH_HEADER, PrivacyStepUp } from './privacy-step-up.js';

/**
 * S13 / F28 regression: the data-rights acts refuse a bound token (a leaked personal access token
 * or the connector's grant) before the service runs, and the export and deletion requests need a
 * re-authentication token bound to this very cookie session.
 */

const SECRET = 'local_dev_only_session_secret_for_privacy_step_up_test_xxxxxxxx';
const USER = '0190c0de-0000-7000-8000-000000000001';
const SESSION = '0190c0de-0000-7000-8000-0000000000aa';
const OTHER_SESSION = '0190c0de-0000-7000-8000-0000000000bb';
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);

const context = { organizationId: 'org', correlationId: 'c' } as unknown as TenantContext;
const principal = { userId: USER, role: 'owner' } as unknown as Principal;
const reply = { header: () => reply } as unknown as HeaderWriter;

function token(sessionId = SESSION, expiresAtMs = NOW + 60_000): string {
  return signReauthToken({ userId: USER, sessionId, expiresAt: new Date(expiresAtMs) }, SECRET);
}

function request(
  authScheme: NonNullable<RequestState['authScheme']>,
  reauth?: string,
): { headers: Record<string, string> } {
  const req = { headers: reauth === undefined ? {} : { [PRIVACY_REAUTH_HEADER]: reauth } };
  const state = ensureRequestState(req);
  state.authScheme = authScheme;
  state.session = { userId: USER, sessionId: SESSION };
  return req;
}

function fakeService() {
  const view = Promise.resolve({});
  const download = Promise.resolve({
    stream: { pipe: () => undefined },
    sizeBytes: 1,
    fileName: 'a.json.gz',
    scanStatus: 'clean',
  });
  return {
    requestOwnerExport: vi.fn(() => view),
    requestCompanyDeletion: vi.fn(() => view),
    cancelCompanyDeletion: vi.fn(() => view),
    requestMyExport: vi.fn(() => view),
    requestMyDeletion: vi.fn(() => view),
    cancelMyDeletion: vi.fn(() => view),
    download: vi.fn(() => download),
  };
}

function controllers() {
  const service = fakeService();
  const guard = new PrivacyStepUp(SECRET, () => NOW);
  const asService = service as unknown as PrivacyService;
  return {
    service,
    admin: new AdminPrivacyController(asService, guard),
    mine: new MyPrivacyController(asService, guard),
  };
}

type Call = (
  c: ReturnType<typeof controllers>,
  req: { headers: Record<string, string> },
) => Promise<unknown>;

/** Every data-rights act, by route, and the service method it must never reach on refusal. */
const ACTS: readonly (readonly [string, Call, keyof ReturnType<typeof fakeService>, boolean])[] = [
  [
    'POST admin/privacy/exports',
    (c, r) => c.admin.requestExport(context, principal, { kind: 'company' }, r),
    'requestOwnerExport',
    true,
  ],
  [
    'GET admin/privacy/exports/:id/download',
    (c, r) => c.admin.download(context, principal, 'e1', reply, r),
    'download',
    false,
  ],
  [
    'POST admin/privacy/deletion',
    (c, r) => c.admin.requestDeletion(context, principal, { confirmName: 'Acme' }, r),
    'requestCompanyDeletion',
    true,
  ],
  [
    'POST admin/privacy/deletion/cancel',
    (c, r) => c.admin.cancelDeletion(context, principal, r),
    'cancelCompanyDeletion',
    false,
  ],
  [
    'POST me/privacy/exports',
    (c, r) => c.mine.requestExport(context, principal, r),
    'requestMyExport',
    true,
  ],
  [
    'GET me/privacy/exports/:id/download',
    (c, r) => c.mine.download(context, principal, 'e1', reply, r),
    'download',
    false,
  ],
  [
    'POST me/privacy/deletion',
    (c, r) => c.mine.requestDeletion(context, principal, r),
    'requestMyDeletion',
    true,
  ],
  [
    'POST me/privacy/deletion/cancel',
    (c, r) => c.mine.cancelDeletion(context, principal, r),
    'cancelMyDeletion',
    false,
  ],
];

async function refusal(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('F28 — a bound token never reaches a data-rights act', () => {
  for (const [route, call, method] of ACTS) {
    for (const scheme of ['personal_access_token', 'ai_grant'] as const) {
      it(`${route} with ${scheme} (even carrying a valid reauth token) → 403, service untouched`, async () => {
        const c = controllers();
        const error = await refusal(() => call(c, request(scheme, token())));
        expect(error.status).toBe(403);
        expect(error.code).toBe('forbidden');
        expect(error.auditCode).toBe('session_required_for_data_rights');
        expect(c.service[method]).not.toHaveBeenCalled();
      });
    }
  }
});

describe('F28 — step-up on the export and deletion requests', () => {
  for (const [route, call, method, stepUp] of ACTS) {
    if (stepUp) {
      it(`${route}: a cookie session without fresh proof → 403 reauthentication_required`, async () => {
        const c = controllers();
        for (const presented of [
          undefined,
          'r1.reauth.x.y.1.z',
          token(OTHER_SESSION),
          token(SESSION, NOW - 1),
        ]) {
          const error = await refusal(() => call(c, request('cookie', presented)));
          expect(error.status).toBe(403);
          expect(error.code).toBe('reauthentication_required');
        }
        expect(c.service[method]).not.toHaveBeenCalled();
      });
      it(`${route}: a cookie session with this session's reauth token → reaches the service`, async () => {
        const c = controllers();
        await call(c, request('cookie', token()));
        expect(c.service[method]).toHaveBeenCalledTimes(1);
      });
    } else {
      it(`${route}: a cookie session → reaches the service (no step-up)`, async () => {
        const c = controllers();
        await call(c, request('cookie'));
        expect(c.service[method]).toHaveBeenCalledTimes(1);
      });
    }
  }
});
