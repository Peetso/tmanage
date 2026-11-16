import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  createPlatformGate,
  isPlatformPath,
  platformDecision,
  platformSignInLocation,
} from './platform-gate.mjs';

/** What the web child would send: the shell (with its menu) for a platform page, else a 404. */
const SHELL = '<nav>Overview Organizations Support People Content Activity Settings Team</nav>';
const NOT_FOUND = '<h1>We couldn’t find that page</h1>';

function fakeWeb(req, res) {
  if (req.url === '/_not-found') {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end(NOT_FOUND);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(SHELL);
}

async function serve(apiStatus, run) {
  const asked = [];
  const gate = createPlatformGate({
    inject: async (options) => {
      asked.push(options);
      if (apiStatus instanceof Error) throw apiStatus;
      return { statusCode: apiStatus };
    },
    proxyToWeb: fakeWeb,
  });
  const server = createServer(gate);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`, asked);
  } finally {
    await new Promise((done) => server.close(done));
  }
}

async function get(url, cookie) {
  const response = await fetch(url, {
    redirect: 'manual',
    headers: cookie === undefined ? {} : { cookie },
  });
  return {
    status: response.status,
    location: response.headers.get('location'),
    body: await response.text(),
  };
}

test('a signed-out visitor is sent to sign-in with no shell, without asking the API', async () => {
  await serve(200, async (base, asked) => {
    const root = await get(`${base}/platform`);
    const orgs = await get(`${base}/platform/organizations?x=1`);
    assert.deepEqual(
      [root, orgs].map(({ status, location, body }) => [
        status,
        location,
        body.includes('Overview'),
      ]),
      [
        [307, '/sign-in?next=%2Fplatform', false],
        [307, '/sign-in?next=%2Fplatform%2Forganizations', false],
      ],
    );
    assert.equal(asked.length, 0);
  });
});

test('an expired session (API 401) is sent to sign-in', async () => {
  await serve(401, async (base) => {
    const page = await get(`${base}/platform/orgs`, 'tmanage_session=old');
    assert.deepEqual(
      [page.status, page.location, page.body],
      [307, '/sign-in?next=%2Fplatform%2Forgs', ''],
    );
  });
});

test('a signed-in non-member gets the ordinary 404 page, never the menu', async () => {
  await serve(404, async (base, asked) => {
    const page = await get(`${base}/platform`, 'tmanage_session=s; tmanage_csrf=c');
    assert.deepEqual(
      [
        page.status,
        page.body.includes('find that page'),
        /Overview|Organizations|Team/.test(page.body),
      ],
      [404, true, false],
    );
    assert.deepEqual(
      [asked[0].method, asked[0].url, asked[0].headers.cookie],
      ['GET', '/v1/platform/me', 'tmanage_session=s; tmanage_csrf=c'],
    );
  });
});

test('a failed check fails closed (404)', async () => {
  await serve(new Error('boom'), async (base) => {
    assert.equal((await get(`${base}/platform`, 'tmanage_session=s')).status, 404);
  });
  await serve(500, async (base) => {
    assert.equal((await get(`${base}/platform`, 'tmanage_session=s')).status, 404);
  });
});

test('a platform member (200, or 403 still to confirm) sees the page', async () => {
  for (const status of [200, 403]) {
    await serve(status, async (base) => {
      const page = await get(`${base}/platform/people`, 'tmanage_session=s');
      assert.deepEqual([page.status, page.body], [200, SHELL]);
    });
  }
});

test('paths, return addresses and decisions', () => {
  assert.deepEqual(
    [
      '/platform',
      '/platform/',
      '/platform/a/b?q=1',
      '/platforms',
      '/x/platform',
      '/v1/platform/me',
    ].map(isPlatformPath),
    [true, true, true, false, false, false],
  );
  assert.deepEqual(
    ['/platform/team', '/platform/%2F%2Fevil.com', '/platform/a.b'].map(platformSignInLocation),
    ['/sign-in?next=%2Fplatform%2Fteam', '/sign-in', '/sign-in'],
  );
  assert.deepEqual([200, 403, 401, 404, 500].map(platformDecision), [
    'open',
    'open',
    'sign-in',
    'not-found',
    'not-found',
  ]);
});
