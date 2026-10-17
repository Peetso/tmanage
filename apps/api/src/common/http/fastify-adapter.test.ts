import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createPartAdmission, derivePartSigningKey, mintPartToken } from '@tmanage/storage';
import type { TrustedProxies } from '@tmanage/config';
import { PART_CONTENT_TYPE, createFastifyAdapter } from './fastify-adapter.js';
import { createFixedWindowLimiter } from './rate-limiter.js';

/**
 * The octet-stream parser, on its own Fastify instance with one echoing route: what
 * reaches a handler is what the parser chose to read. The security review of 2026-09-04
 * found that a body was buffered — up to a part size per connection — before anyone had
 * looked at the token, so an anonymous caller could hold memory with a token that verified
 * nothing. Now the admission runs first, and a body behind a token that does not verify is
 * never read: the handler sees zero bytes.
 */

const SECRET = 'a_signing_secret_that_is_long_enough_for_the_suite';
const HANDLE = '0123456789abcdef0123456789abcdef';
const ORGANIZATION_ID = '11111111-2222-4333-8444-555555555555';
const PART_SIZE = 64;
const NOW = 1_800_000_000_000;

function tokenFor(partNumber: number, expiresAtMs = NOW + 60_000): string {
  return mintPartToken(derivePartSigningKey(SECRET), {
    providerUploadId: HANDLE,
    organizationId: ORGANIZATION_ID,
    partNumber,
    expiresAtMs,
  });
}

async function instance(admit: boolean, clientMax?: number) {
  const adapter = createFastifyAdapter({
    uploadPartSizeBytes: PART_SIZE,
    admitPart: admit ? createPartAdmission(SECRET, () => NOW) : undefined,
    admitClient:
      clientMax === undefined
        ? undefined
        : createFixedWindowLimiter({ windowMs: 60_000, max: clientMax, now: () => NOW }),
  });
  const app = adapter.getInstance();
  app.put('/v1/uploads/:handle/parts/:n', async (request) => ({
    received: Buffer.isBuffer(request.body) ? request.body.length : -1,
  }));
  await app.ready();
  return app;
}

const put = (app: Awaited<ReturnType<typeof instance>>, url: string, size: number) =>
  app.inject({
    method: 'PUT',
    url,
    headers: { 'content-type': PART_CONTENT_TYPE },
    payload: Buffer.alloc(size, 'x'),
  });

describe('the part parser reads a body only behind a token that verifies', () => {
  it('hands the handler the whole body for a valid token, and nothing for a forged, expired or missing one', async () => {
    const app = await instance(true);
    const valid = await put(app, `/v1/uploads/${HANDLE}/parts/1?t=${tokenFor(1)}`, 40);
    expect(valid.json()).toEqual({ received: 40 });

    // Reversal: read the body before the admission and every one of these receives 40.
    for (const url of [
      `/v1/uploads/${HANDLE}/parts/1?t=pu1.${NOW + 60_000}.forged`,
      `/v1/uploads/${HANDLE}/parts/1?t=${tokenFor(1, NOW - 1)}`,
      `/v1/uploads/${HANDLE}/parts/2?t=${tokenFor(1)}`, // another part's token
      `/v1/uploads/${HANDLE}/parts/1`,
      `/v1/uploads/${HANDLE}/parts/0?t=${tokenFor(1)}`, // a part number that is not one
    ]) {
      const refused = await put(app, url, 40);
      expect(refused.json(), url).toEqual({ received: 0 });
    }
  });

  it('reads no body at all when no admission is configured — the s3 driver, or a suite with no sink', async () => {
    const app = await instance(false);
    const response = await put(app, `/v1/uploads/${HANDLE}/parts/1?t=${tokenFor(1)}`, 40);
    expect(response.json()).toEqual({ received: 0 });
  });

  it('admits a client max times per window and answers the next 429, before the token is even looked at', async () => {
    const app = await instance(true, 2);
    const url = `/v1/uploads/${HANDLE}/parts/1?t=${tokenFor(1)}`;
    expect((await put(app, url, 40)).json()).toEqual({ received: 40 });
    expect((await put(app, url, 40)).json()).toEqual({ received: 40 });
    // Reversal: consult the limiter after the admission and the forged request below is
    // 200 with 0 bytes — the flood reached the verifier (proved 2026-09-05); drop the
    // limiter altogether and this line is 200 with 40.
    expect((await put(app, url, 40)).statusCode).toBe(429);
    // A forged token from the same client is refused by the window too: the limiter came
    // first, so a flood of garbage never reaches the verifier.
    const forged = await put(app, `/v1/uploads/${HANDLE}/parts/1?t=pu1.${NOW + 60_000}.forged`, 40);
    expect(forged.statusCode).toBe(429);
  });

  it('still refuses a body over the limit, after the token, as 413', async () => {
    const app = await instance(true);
    const response = await put(
      app,
      `/v1/uploads/${HANDLE}/parts/1?t=${tokenFor(1)}`,
      PART_SIZE + 1_024 + 1,
    );
    expect(response.statusCode).toBe(413);
  });
});

/**
 * D09 — what the adapter hands Fastify as `trustProxy`.
 *
 * Until this slice `main.ts` passed `trustProxy: true`, so every `X-Forwarded-*` header was
 * believed no matter who sent it: any client that could reach the process could name the
 * address every address-keyed control counts against, rotate it per request, and spend D08's
 * global sign-in budget on its own. The option now carries the operator's configured list
 * (`TRUSTED_PROXY_ADDRESSES`, parsed and refused in `packages/config`) and nothing else.
 *
 * Each case asserts the option through Fastify rather than reading it back off the adapter:
 * an injected request carries forwarded headers from a chosen socket peer, and `request.ip`
 * — the key the limiter and the abuse control use — says whose word Fastify took. Reading the
 * option back would prove it was stored; this proves it was obeyed.
 */

/** One forged set of forwarded headers, reused: only the socket peer changes per case. */
const FORWARDED = {
  'x-forwarded-for': '198.51.100.99',
  'x-forwarded-host': 'forged.example',
  'x-forwarded-proto': 'https',
};

interface WhoAmI {
  readonly ip: string;
  readonly hostname: string;
  readonly protocol: string;
}

async function trusting(trustProxy: TrustedProxies | undefined) {
  const adapter = createFastifyAdapter({ trustProxy, uploadPartSizeBytes: PART_SIZE });
  const app = adapter.getInstance();
  app.get('/whoami', async (request) => ({
    ip: request.ip,
    hostname: request.hostname,
    protocol: request.protocol,
  }));
  await app.ready();
  return app;
}

async function whoami(
  app: Awaited<ReturnType<typeof trusting>>,
  remoteAddress: string,
): Promise<WhoAmI> {
  const response = await app.inject({
    method: 'GET',
    url: '/whoami',
    remoteAddress,
    headers: FORWARDED,
  });
  return response.json<WhoAmI>();
}

describe('the adapter trusts exactly the peers the operator configured', () => {
  it('trusts nobody when nothing is configured: the socket peer is the client, headers and all', async () => {
    const app = await trusting(undefined);

    const seen = await whoami(app, '203.0.113.7');

    // Reversal: `trustProxy: true` here — what `main.ts` passed — and all three flip to the
    // forged values, which is finding D09 exactly.
    expect(seen.ip).toBe('203.0.113.7');
    expect(seen.hostname).not.toBe('forged.example');
    expect(seen.protocol).toBe('http');
  });

  it('believes one configured proxy, and refuses the same header from any other peer', async () => {
    const app = await trusting(['203.0.113.7']);

    expect((await whoami(app, '203.0.113.7')).ip).toBe('198.51.100.99');
    // The neighbouring address is not the proxy, and saying so does not make it one.
    expect((await whoami(app, '203.0.113.8')).ip).toBe('203.0.113.8');
  });

  it('believes several configured proxies, IPv4 and IPv6 together', async () => {
    const app = await trusting(['203.0.113.7', '198.51.100.4', '2001:db8::1']);

    for (const proxy of ['203.0.113.7', '198.51.100.4', '2001:db8::1']) {
      expect((await whoami(app, proxy)).ip, proxy).toBe('198.51.100.99');
    }
    expect((await whoami(app, '192.0.2.5')).ip).toBe('192.0.2.5');
  });

  it('believes a CIDR range, which is how a proxy fleet is named', async () => {
    const app = await trusting(['10.0.0.0/8']);

    expect((await whoami(app, '10.4.5.6')).ip).toBe('198.51.100.99');
    // One bit outside the range is outside it.
    expect((await whoami(app, '11.4.5.6')).ip).toBe('11.4.5.6');
  });
});

/**
 * The composition root, statically. The adapter can only trust what it is handed, so the
 * literal `true` in `main.ts` was the whole of D09 — and a literal is exactly what no
 * behavioural test in this file can see. `users-sql.test.ts` reads a file for the same
 * reason: what is not compared is what silently comes back.
 */
const MAIN_TS = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../main.ts'),
  'utf8',
);

describe('the composition root hands the adapter the configured trust', () => {
  it('passes the validated setting, not a literal', () => {
    expect(MAIN_TS).toMatch(/trustProxy:\s*env\.TRUSTED_PROXY_ADDRESSES\b/);
  });

  it('never trusts every peer unconditionally', () => {
    expect(MAIN_TS).not.toMatch(/trustProxy:\s*(?:true|\d)/);
  });
});
