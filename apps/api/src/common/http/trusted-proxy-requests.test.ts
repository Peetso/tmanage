import { describe, expect, it } from 'vitest';
import { loadEnv } from '@tmanage/config';
import { PART_CONTENT_TYPE, createFastifyAdapter } from './fastify-adapter.js';
import { createFixedWindowLimiter } from './rate-limiter.js';
import { createSignInAbuseControl } from '../../modules/identity/sign-in-abuse-control.js';

/**
 * D09, proved at request level rather than at the option.
 *
 * `fastify-adapter.test.ts` proves that the adapter hands Fastify the operator's list and that
 * Fastify obeys it, reading `request.ip` off a bare `/whoami` route. That is one link short of
 * the claim the slice exists for, which is about a **control**: an untrusted client cannot
 * choose the address, host or protocol that anything counts against. The finding was
 * reproduced as *two accepted requests from one socket peer using two different forwarded
 * addresses against a one-request-per-address limiter*; the cases below run that reproduction
 * again, inverted, through the two address-keyed controls this repository actually has.
 *
 * Every case drives the whole configured chain the composition root drives — a raw environment
 * bag, through `loadEnv` (`TRUSTED_PROXY_ADDRESSES`, parsed and refused in `packages/config`),
 * into `createFastifyAdapter`, into Fastify, out as `request.ip`, into the control — and injects
 * with Fastify's own `inject`, choosing the socket peer per request. The one link no test in
 * this file can see is `main.ts`'s literal, which the two text assertions at the foot of
 * `fastify-adapter.test.ts` pin instead.
 *
 * No database and no Nest pipeline: the routes here are the two shapes the production code
 * keys on the address (`fastify-adapter.ts`'s own `admitClient` inside the part parser, and
 * `sign-in-abuse-control.ts` as `authentication.service.ts` calls it, `ip: request.ip ?? null`).
 * What that leaves unproven is written down in `.superpowers/sdd/d09-task-3-report.md` rather
 * than implied by a green run: chiefly the `authentication_events.ip` insert, which is task 4.
 *
 * **Why each case carries a contrasting half.** The property under test is a biconditional —
 * the forwarded value is believed *if and only if* the operator named the peer — and only the
 * "if" half discriminates against the pre-fix tree. Before this slice `packages/config` had no
 * `TRUSTED_PROXY_ADDRESSES` at all, so a configured proxy was not expressible and the trusting
 * half of every case below fails; the "only if" half passed pre-fix at the adapter, because the
 * defect lived in `main.ts`'s literal. The halves are kept in one case each so the two cannot
 * drift apart, and `d09-t3-probe.log` records exactly which of them failed.
 */

/** A minimal valid environment; only `TRUSTED_PROXY_ADDRESSES` ever differs between cases. */
const BASE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  API_PUBLIC_URL: 'http://localhost:4000',
  WEB_PUBLIC_URL: 'http://localhost:3000',
  CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
  DATABASE_URL: 'mysql://tmanage_app:pw@localhost:3306/tmanage',
  DATABASE_MIGRATION_URL: 'mysql://tmanage_migrator:pw@localhost:3306/tmanage',
  STORAGE_BUCKET: 'tmanage-local',
  STORAGE_DRIVER: 'filesystem',
  SESSION_SECRET: 'a'.repeat(48),
  CSRF_SECRET: 'b'.repeat(48),
  STORAGE_LOCAL_SIGNING_SECRET: 'd'.repeat(48),
  AUTH_MFA_SEED_KEYS: `1:${'k'.repeat(43)}`,
  EMAIL_FROM_ADDRESS: 'no-reply@tmanage.example',
};

/** `undefined` is the operator who configured nothing — the variable absent, not empty. */
const rawEnv = (trust: string | undefined): NodeJS.ProcessEnv =>
  trust === undefined ? { ...BASE_ENV } : { ...BASE_ENV, TRUSTED_PROXY_ADDRESSES: trust };

/** The peer that opens the socket in most cases, and the one an operator may name. */
const EDGE = '203.0.113.7';
/** A second peer, one address along: near the edge, and not the edge. */
const OTHER_PEER = '203.0.113.8';
/** What a forged `X-Forwarded-For` claims to be. */
const FORGED_CLIENT = '198.51.100.99';
const FORGED_HOST = 'forged.example';
const ACCOUNT = 'ana@example.test';
const SIGN_IN_PATH = '/v1/auth/sign-in';
const HANDLE = '0123456789abcdef0123456789abcdef';
const NOW = 1_800_000_000_000;

interface Outcome {
  readonly statusCode: number;
  readonly ip: string;
  readonly hostname: string;
  readonly protocol: string;
  readonly admitted: boolean;
  readonly reason: string | null;
}

interface OriginOptions {
  /** The raw `TRUSTED_PROXY_ADDRESSES` value; absent means the operator configured nothing. */
  readonly trust?: string | undefined;
  readonly maxPerSource?: number;
  readonly maxPerSourceAccount?: number;
}

/**
 * An origin with one route that decides exactly as `authentication.service.ts` decides:
 * the abuse control is asked first, with `ip: request.ip ?? null`, and a refusal is the 429
 * `rate_limited` the controller renders. An admitted attempt answers 401 — it reached the
 * password check, which this proof does not run and does not need.
 */
async function signInOrigin(options: OriginOptions = {}) {
  const env = loadEnv(rawEnv(options.trust));
  const control = createSignInAbuseControl({
    windowMs: 300_000,
    maxPerSource: options.maxPerSource ?? 1_000,
    maxPerSourceAccount: options.maxPerSourceAccount ?? 1_000,
    // Wide enough that no case below can reach it: the global key is not what is under test.
    maxGlobal: 1_000_000,
    now: () => NOW,
  });
  const adapter = createFastifyAdapter({
    trustProxy: env.TRUSTED_PROXY_ADDRESSES,
    uploadPartSizeBytes: env.UPLOAD_PART_SIZE_BYTES,
  });
  const app = adapter.getInstance();
  app.post(SIGN_IN_PATH, async (request, reply) => {
    const body = request.body as { readonly email?: string } | undefined;
    const verdict = control.admit({ ip: request.ip ?? null, account: body?.email });
    return reply.code(verdict.admitted ? 401 : 429).send({
      ip: request.ip,
      hostname: request.hostname,
      protocol: request.protocol,
      admitted: verdict.admitted,
      reason: verdict.admitted ? null : verdict.reason,
    });
  });
  await app.ready();
  return app;
}

interface Attempt {
  /** The socket peer this request comes from. */
  readonly from: string;
  /** What its forged `X-Forwarded-For` claims. */
  readonly claiming?: string;
  readonly account?: string;
}

async function signIn(
  app: Awaited<ReturnType<typeof signInOrigin>>,
  attempt: Attempt,
): Promise<Outcome> {
  const response = await app.inject({
    method: 'POST',
    url: SIGN_IN_PATH,
    remoteAddress: attempt.from,
    headers: {
      'x-forwarded-for': attempt.claiming ?? FORGED_CLIENT,
      'x-forwarded-host': FORGED_HOST,
      'x-forwarded-proto': 'https',
    },
    payload: { email: attempt.account ?? ACCOUNT, password: 'not-the-one' },
  });
  return { statusCode: response.statusCode, ...response.json<Omit<Outcome, 'statusCode'>>() };
}

/**
 * The other address-keyed control, and the one the finding was originally reproduced
 * against: `createFixedWindowLimiter` consulted inside the adapter's own part parser, keyed
 * by `request.ip`, before the token and before a byte of body.
 */
async function partOrigin(options: { trust?: string | undefined; max: number }) {
  const env = loadEnv(rawEnv(options.trust));
  const adapter = createFastifyAdapter({
    trustProxy: env.TRUSTED_PROXY_ADDRESSES,
    uploadPartSizeBytes: 64,
    admitClient: createFixedWindowLimiter({ windowMs: 60_000, max: options.max, now: () => NOW }),
  });
  const app = adapter.getInstance();
  app.put('/v1/uploads/:handle/parts/:n', async (request) => ({ ip: request.ip }));
  await app.ready();
  return app;
}

const part = (app: Awaited<ReturnType<typeof partOrigin>>, from: string, claiming: string) =>
  app.inject({
    method: 'PUT',
    url: `/v1/uploads/${HANDLE}/parts/1`,
    remoteAddress: from,
    headers: { 'content-type': PART_CONTENT_TYPE, 'x-forwarded-for': claiming },
    payload: Buffer.alloc(16, 'x'),
  });

describe('a request from an untrusted peer cannot choose the address a control counts', () => {
  it('binds a forged forwarded header to the socket peer when nothing is configured — address, host and protocol', async () => {
    const origin = await signInOrigin();

    const seen = await signIn(origin, { from: EDGE });

    // Reversal: `trustProxy: true` — what `main.ts` passed until this slice — and all three
    // of these become the attacker's, which is finding D09 in one line.
    expect(seen.ip).toBe(EDGE);
    expect(seen.hostname).not.toBe(FORGED_HOST);
    expect(seen.protocol).toBe('http');
    // The forwarded value is not merely disbelieved for the address and then read for the
    // host: with nothing configured Fastify builds a request with no forwarded overrides at
    // all, so none of the three moves.
    expect(seen.ip).not.toBe(FORGED_CLIENT);

    // The other half of the biconditional, and the half that discriminates: naming that same
    // peer is what buys the forwarded values, and it is an operator's decision, not a
    // client's. Before this slice the variable did not exist and this half could not happen.
    const configured = await signInOrigin({ trust: EDGE });
    const proxied = await signIn(configured, { from: EDGE });
    expect(proxied.ip).toBe(FORGED_CLIENT);
    expect(proxied.hostname).toBe(FORGED_HOST);
    expect(proxied.protocol).toBe('https');
  });

  it('resolves the forwarded address for a request from a configured trusted proxy, by address and by range', async () => {
    const named = await signInOrigin({ trust: EDGE });
    expect((await signIn(named, { from: EDGE })).ip).toBe(FORGED_CLIENT);

    // A fleet is named as a range, which is the shape an operator actually has.
    const fleet = await signInOrigin({ trust: '10.0.0.0/8' });
    expect((await signIn(fleet, { from: '10.4.5.6' })).ip).toBe(FORGED_CLIENT);
    // One bit outside the range is outside it.
    expect((await signIn(fleet, { from: '11.4.5.6' })).ip).toBe('11.4.5.6');
  });

  it('still binds a different, untrusted peer to its socket address while a proxy is configured', async () => {
    const origin = await signInOrigin({ trust: EDGE });

    const impostor = await signIn(origin, { from: OTHER_PEER });

    // Saying you are the proxy does not make you one, and the neighbouring address is the
    // cheapest possible lie.
    expect(impostor.ip).toBe(OTHER_PEER);
    expect(impostor.hostname).not.toBe(FORGED_HOST);
    expect(impostor.protocol).toBe('http');
    // The same header from the peer that *is* configured is believed, in the same process
    // and the same window: the difference is the peer, not the header.
    expect((await signIn(origin, { from: EDGE })).ip).toBe(FORGED_CLIENT);
  });
});

describe('the finding, inverted: two forwarded addresses from one peer are one source', () => {
  it("reproduces the finding's own case — a one-request-per-address limiter now refuses the second", async () => {
    const origin = await partOrigin({ max: 1 });

    const first = await part(origin, EDGE, '198.51.100.1');
    const second = await part(origin, EDGE, '198.51.100.2');

    // The finding: both of these were admitted, because the two forged addresses were two
    // keys. One socket peer is one key now, and the window it used is spent.
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    // Not the limiter being exhausted for everybody: a genuinely different peer still has
    // its own window.
    expect((await part(origin, OTHER_PEER, '198.51.100.3')).statusCode).toBe(200);

    // Discriminating half. Name the peer and the two forwarded addresses are two sources
    // again — which is correct behind a real proxy, and is now reachable only by an operator
    // who wrote that peer down.
    const proxied = await partOrigin({ trust: EDGE, max: 1 });
    expect((await part(proxied, EDGE, '198.51.100.1')).statusCode).toBe(200);
    expect((await part(proxied, EDGE, '198.51.100.2')).statusCode).toBe(200);
  });

  it("counts both attempts against one key in the sign-in abuse control's source budget", async () => {
    const origin = await signInOrigin({ maxPerSource: 1 });

    const first = await signIn(origin, { from: EDGE, claiming: '198.51.100.1' });
    const second = await signIn(origin, { from: EDGE, claiming: '198.51.100.2' });

    expect(first.admitted).toBe(true);
    expect(second.admitted).toBe(false);
    expect(second.reason).toBe('source_throttled');
    expect(second.statusCode).toBe(429);
    // Both attempts were keyed on the socket peer, which is why they met.
    expect(first.ip).toBe(EDGE);
    expect(second.ip).toBe(EDGE);
    // And a different peer is a different budget, so the refusal is about the key.
    expect((await signIn(origin, { from: OTHER_PEER, claiming: '198.51.100.3' })).admitted).toBe(
      true,
    );

    // Discriminating half, as above: behind a configured proxy the forwarded addresses are
    // two sources, which is what a proxy is for.
    const proxied = await signInOrigin({ trust: EDGE, maxPerSource: 1 });
    expect((await signIn(proxied, { from: EDGE, claiming: '198.51.100.1' })).admitted).toBe(true);
    expect((await signIn(proxied, { from: EDGE, claiming: '198.51.100.2' })).admitted).toBe(true);
  });

  it('counts them against one source+account key too, which is the other budget the address rotates', async () => {
    const origin = await signInOrigin({ maxPerSourceAccount: 1 });

    const first = await signIn(origin, { from: EDGE, claiming: '198.51.100.1' });
    const second = await signIn(origin, { from: EDGE, claiming: '198.51.100.2' });

    // `sa:<ip>:<hash>` contains the address, so rotating the header used to rotate this
    // budget as well as the source one — the sharper half of D08's dependency on D09.
    expect(first.admitted).toBe(true);
    expect(second.admitted).toBe(false);
    expect(second.reason).toBe('source_account_throttled');
    // A second account from the same peer still has its own budget: the key is the pair.
    expect(
      (await signIn(origin, { from: EDGE, claiming: '198.51.100.2', account: 'bo@example.test' }))
        .admitted,
    ).toBe(true);

    const proxied = await signInOrigin({ trust: EDGE, maxPerSourceAccount: 1 });
    expect((await signIn(proxied, { from: EDGE, claiming: '198.51.100.1' })).admitted).toBe(true);
    expect((await signIn(proxied, { from: EDGE, claiming: '198.51.100.2' })).admitted).toBe(true);
  });
});

/**
 * The long forged header.
 *
 * `authentication_events.ip` is `VARCHAR(45)`, and the plan's acceptance line is that a forged
 * header far longer than that "produces a refusal or a clean failure, never a 500". These two
 * cases assert what happens **at this layer** and nothing beyond it: the request path does not
 * crash, and the abuse control's own `MAX_SOURCE_KEY_LENGTH` clamp holds. The insert itself is
 * untouched by this slice so far — see the report for what that leaves open.
 */
const LONG_FORGERY = 'A'.repeat(300);

describe('a forged forwarded header far longer than an address', () => {
  it('is discarded entirely from an untrusted peer: the control never sees it, and nothing 500s', async () => {
    const origin = await signInOrigin();

    const seen = await signIn(origin, { from: EDGE, claiming: LONG_FORGERY });

    expect(seen.statusCode).toBe(401);
    expect(seen.statusCode).not.toBe(500);
    expect(seen.ip).toBe(EDGE);
    expect(seen.ip.length).toBeLessThanOrEqual(45);

    // Contrasting half, as in every case above: the discard is a property of the *peer*, not
    // of the header's length. Nothing here inspects or bounds the forwarded value — name the
    // peer and all three hundred characters arrive intact, which is the next case.
    const configured = await signInOrigin({ trust: EDGE });
    expect((await signIn(configured, { from: EDGE, claiming: LONG_FORGERY })).ip).toBe(
      LONG_FORGERY,
    );
  });

  it('reaches the control verbatim through a configured proxy, and is clamped to one key at 45', async () => {
    const proxied = await signInOrigin({ trust: EDGE, maxPerSource: 1 });

    const through = await signIn(proxied, { from: EDGE, claiming: LONG_FORGERY });

    // No refusal is manufactured here and none is claimed: a trusted hop's forwarded value
    // is whatever it forwarded — arbitrary text, never validated as an address by Fastify or
    // by `@fastify/proxy-addr` — and it arrives at `request.ip` at its full length.
    expect(through.statusCode).toBe(401);
    expect(through.statusCode).not.toBe(500);
    expect(through.ip).toBe(LONG_FORGERY);
    expect(through.ip.length).toBe(300);

    // The control clamps before it keys, so two 300-character forgeries that agree on their
    // first 45 characters are one source and not two: the maps grow in entries, not bytes.
    const twin = await signIn(proxied, {
      from: EDGE,
      claiming: `${'A'.repeat(45)}${'Z'.repeat(9)}`,
    });
    expect(twin.admitted).toBe(false);
    expect(twin.reason).toBe('source_throttled');
    expect(twin.statusCode).toBe(429);
    // Differing inside the first 45 characters is a different key, which is what makes the
    // line above an assertion about the clamp rather than about the budget being spent.
    const apart = await signInOrigin({ trust: EDGE, maxPerSource: 1 });
    expect((await signIn(apart, { from: EDGE, claiming: LONG_FORGERY })).admitted).toBe(true);
    expect((await signIn(apart, { from: EDGE, claiming: `B${'A'.repeat(299)}` })).admitted).toBe(
      true,
    );
  });
});
