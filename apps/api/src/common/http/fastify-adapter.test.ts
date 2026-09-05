import { describe, expect, it } from 'vitest';
import { createPartAdmission, derivePartSigningKey, mintPartToken } from '@tmanage/storage';
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
const PART_SIZE = 64;
const NOW = 1_800_000_000_000;

function tokenFor(partNumber: number, expiresAtMs = NOW + 60_000): string {
  return mintPartToken(derivePartSigningKey(SECRET), {
    providerUploadId: HANDLE,
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
