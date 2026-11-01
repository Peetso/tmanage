import { expect, it, vi } from 'vitest';
import type { IpLookupRow } from '../../../common/database/schema.js';
import { intelOf } from './session-intel.js';
import { SessionIntelReader } from './session-intel.service.js';
import { MeSessionTrailController } from '../session.controller.js';
import { ensureRequestState } from '../../../common/http/request-state.js';

const row = (fields: Partial<IpLookupRow>) =>
  ({
    asn: null,
    networkOwner: null,
    isTor: false,
    vpnOrProxy: 'unknown',
    ...fields,
  }) as IpLookupRow;
const CHROME = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0';

it('R12 intel: no lookup, a local address, hosting + Tor, and a bot agent', () => {
  expect(intelOf(null, CHROME, null)).toMatchObject({ location: null, network: null });
  const local = intelOf(row({ networkKind: 'local', countryCode: null }), null, null);
  expect([local.location, local.network?.kind, local.device.deviceType]).toEqual([
    null,
    'local',
    'unknown',
  ]);
  const tor = row({ networkKind: 'hosting', isTor: true, vpnOrProxy: 'likely', countryCode: 'DE' });
  const view = intelOf({ ...tor, source: 'mmdb', asn: 24940 }, 'curl/8.4', {
    score: 70,
    reasons: ['ua_tool'],
  });
  expect(view.location).toMatchObject({
    countryCode: 'DE',
    approximate: true,
    attribution: 'DB-IP',
  });
  expect(view.network).toEqual({
    asn: 24940,
    owner: null,
    kind: 'hosting',
    tor: true,
    vpnOrProxy: 'likely',
  });
  expect([view.device.deviceType, view.automation?.verdict]).toEqual(['bot', 'likely_automated']);
});

it("R12 me trail: another person's session id is a 404", async () => {
  vi.spyOn(SessionIntelReader.prototype, 'sessionTrail').mockImplementation(
    async (_c, _id, mayRead) => (mayRead('someone-else') ? 'csv' : null),
  );
  const controller = new MeSessionTrailController({} as never);
  const request = { headers: {} };
  ensureRequestState(request);
  const call = controller.trail({ userId: 'me' } as never, 's-1', request, { header: () => 0 });
  await expect(call).rejects.toMatchObject({ status: 404 });
});
