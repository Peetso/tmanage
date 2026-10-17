// Local proof that the Hostinger bundle actually runs: unzip it OUTSIDE the repo, npm install
// it, point it at a private MariaDB 11.8 (the engine Hostinger runs: 11.8.9-MariaDB-log, binary
// logging on) started by the repo's own scripts/db/mariadb-server.mjs, start it EXACTLY as Hostinger would — `node server.mjs` with PORT and
// the panel environment — and exercise the real paths end to end.
//
// Run from the repo root:  node deploy/hostinger/smoke.mjs
//
// It provisions ONE MariaDB user for the database (what Hostinger gives a Node.js web app) and
// hands the bundle only DATABASE_URL — with a `localhost` host and a percent-encoded password, as
// Hostinger writes it — so single-user mode and the 127.0.0.1 rewrite are exercised. It applies
// the schema once up front, seeds the two-tenant world plus a password, then lets the bundle's
// own start apply migrations again (proving the second run is a no-op) and serve. It drives:
//   GET /            — the app renders
//   GET /sign-in     — the sign-in page loads
//   GET /healthz     — liveness
//   POST /v1/auth/password + GET /v1/auth/factors — real cookie sign-in and an authenticated call
import { spawn, spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import {
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  lstatSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from 'mysql2/promise';
import { hash as argonHash } from '@node-rs/argon2';
import { startMariaDb } from '../../scripts/db/mariadb-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const ZIP = join(HERE, 'out', 'tmanage-hostinger.zip');
// Where the bundle is unpacked and the report written — OUTSIDE the repo (an artefact, not a
// project copy). Override with TMANAGE_DEPLOY_CHECK_DIR.
const CHECK = process.env['TMANAGE_DEPLOY_CHECK_DIR'] ?? join(tmpdir(), 'tmanage-deploy-check');
const BUNDLE = join(CHECK, 'bundle');
const REPORT = join(CHECK, 'REPORT.md');

const PORT = 3390;
// A local stand-in for Hostinger's TLS-terminating reverse proxy: HTTPS on this port, one hop,
// forwarding to PORT with X-Forwarded-* — so a real browser signs in over https exactly as it
// would at https://tmanage.peetrix.com (the hostname is mapped to 127.0.0.1 in the browser).
const TLS_PORT = 3443;
const HOST = 'tmanage.peetrix.com';
const ORIGIN = `https://${HOST}:${TLS_PORT}`;
const DB = 'tmanage';
// The single user, named and password-shaped as Hostinger makes them (prefix; symbols that must
// be percent-encoded in a URL).
const DB_USER = 'u123456789_tmanage';
const DB_PASSWORD = 'Smoke p@ss:w/rd#1';
// Real, distinct, non-placeholder secrets (no 'local_dev_only'/'example'/... markers that
// production rejects). base64url of fixed bytes — fine for a throwaway local MariaDB.
const SECRET = (tag) => Buffer.from(`smoke-${tag}-${'x'.repeat(40)}`).toString('base64url');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}\n`);
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: 'pipe',
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...opts,
  });
  return r;
}

function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((done, fail) => {
    const tryOnce = () => {
      const s = createConnection(port, '127.0.0.1');
      s.once('connect', () => {
        s.destroy();
        done();
      });
      s.once('error', () => {
        s.destroy();
        if (Date.now() > deadline) fail(new Error(`port ${port} never opened`));
        else setTimeout(tryOnce, 400);
      });
    };
    tryOnce();
  });
}

// A minimal cookie jar: remember name=value from Set-Cookie, resend them all (Secure/Path
// semantics are irrelevant to this same-process http client).
const jar = new Map();
function remember(setCookie) {
  for (const line of setCookie ?? []) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
async function hit(path, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (jar.size) headers['cookie'] = cookieHeader();
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...init,
    headers,
    redirect: 'manual',
  });
  remember(res.headers.getSetCookie?.() ?? res.headers.raw?.()['set-cookie']);
  return res;
}

async function main() {
  let server;
  let db;
  try {
    // 1. Unzip the bundle outside the repo.
    if (!existsSync(ZIP)) throw new Error(`bundle not found: ${ZIP} (run pnpm deploy:hostinger)`);
    rmSync(BUNDLE, { recursive: true, force: true });
    mkdirSync(BUNDLE, { recursive: true });
    const unzip = sh('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path '${ZIP}' -DestinationPath '${BUNDLE}' -Force`,
    ]);
    check(
      'bundle unzips',
      unzip.status === 0 && existsSync(join(BUNDLE, 'server.mjs')),
      unzip.stderr?.slice(0, 200),
    );
    // Security review §3: no source maps and no grant script in what is uploaded.
    const shipped = readdirSync(BUNDLE, { recursive: true }).map(String);
    const maps = shipped.filter((file) => file.endsWith('.map'));
    check(
      'zip ships no *.map and no db/users.sql',
      maps.length === 0 && !existsSync(join(BUNDLE, 'db', 'users.sql')),
      maps.length ? `${maps.length} map(s), e.g. ${maps[0]}` : `${shipped.length} entries`,
    );

    // 2. npm install in the unzipped bundle (Linux-correct native deps on Hostinger; here the
    //    local platform's are fetched).
    const npm = sh('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: BUNDLE,
      timeout: 600_000,
    });
    check(
      'npm install',
      npm.status === 0,
      (npm.stderr || '').split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300),
    );
    if (npm.status !== 0) throw new Error('npm install failed');

    // Hostinger's build sandbox refuses symlinks (EACCES), so the install must copy the vendored
    // file: packages and create no node_modules/.bin links (the bundle's .npmrc asks for both).
    const linked = readdirSync(join(BUNDLE, 'node_modules/@tmanage')).filter((name) =>
      lstatSync(join(BUNDLE, 'node_modules/@tmanage', name)).isSymbolicLink(),
    );
    check(
      'install creates no symlinks (Hostinger refuses them)',
      linked.length === 0 && !existsSync(join(BUNDLE, 'node_modules/.bin')),
      linked.length ? `linked: ${linked.join(', ')}` : 'vendored packages copied, no .bin',
    );

    // 3. A real MariaDB 11.8 (Hostinger's engine and major version), private to this run.
    db = await startMariaDb({ dbName: DB, logLevel: 'ERROR' });
    const rootUrl = `mysql://${db.username}@127.0.0.1:${db.port}/${DB}`;
    const auth = `${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}`;
    const url = (host) => `mysql://${auth}@${host}:${db.port}/${DB}`;

    // 4. Provision the one user, with all privileges on this one database — the shape Hostinger
    //    produces for a web app's database.
    const admin = createPool({ uri: rootUrl, connectionLimit: 2, multipleStatements: true });
    const [[engine]] = await admin.query(
      'SELECT VERSION() AS version, @@log_bin AS logBin, @@version_comment AS comment',
    );
    process.stdout.write(
      `engine: ${engine.version} (${engine.comment}), log_bin=${engine.logBin}\n`,
    );
    check(
      'engine is MariaDB 11.8.x with binary logging on (as Hostinger)',
      /^11\.8\.\d+-MariaDB/.test(engine.version) && Number(engine.logBin) === 1,
      `${engine.version}, log_bin=${engine.logBin}`,
    );
    // The schema creates triggers. MariaDB 11.8 with binary logging on refuses CREATE TRIGGER /
    // CREATE FUNCTION from a user without SUPER (ERROR 1419) unless log_bin_trust_function_creators
    // is ON — proved here 2026-10-17 on 11.8.9-MariaDB-log, under MIXED and ROW binlog formats.
    // Hostinger's one database user has no SUPER, yet its first live deploy created the triggers
    // of migrations 0001-0010, so the host runs with this ON. Mirror that: the host's setting,
    // made once by the server owner (root here), never by the app's user. Fail loudly if it
    // cannot be set rather than letting migrations fail later with a confusing error.
    await admin.query('SET GLOBAL log_bin_trust_function_creators = 1');
    await admin.query(`CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?`, [DB_USER, DB_PASSWORD]);
    await admin.query(`GRANT ALL PRIVILEGES ON \`${DB}\`.* TO ?@'%'`, [DB_USER]);
    await admin.query('FLUSH PRIVILEGES');
    check('one db user provisioned', true, DB_USER);

    // 5. Apply the schema once, up front, as the migrator — the operator's prep step.
    const mig = sh('pnpm', ['--filter', '@tmanage/api', 'db:migrate'], {
      cwd: REPO,
      env: { ...process.env, DATABASE_MIGRATION_URL: url('127.0.0.1') },
      timeout: 300_000,
    });
    const firstApplied = /applied \d+ migration/.test(mig.stdout || '');
    check(
      'migrations applied (first run)',
      mig.status === 0 && firstApplied,
      (mig.stdout || '').trim().split('\n').pop(),
    );

    // 6. Seed the two-tenant world, then give one user a password so the real sign-in works.
    const seed = sh('pnpm', ['--filter', '@tmanage/api', 'exec', 'tsx', 'test/seed-cli.ts'], {
      cwd: REPO,
      env: { ...process.env, TMANAGE_SEED_DATABASE_URL: rootUrl },
      timeout: 300_000,
    });
    check('seed two-tenant world', seed.status === 0);
    const email = 'maya.hassan@northstar.example';
    const password = 'smoke-correct-horse-battery';
    const phc = await argonHash(password, {
      algorithm: 2,
      version: 1,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
    });
    const [[row]] = await admin.query('SELECT id FROM users WHERE email = ?', [email]);
    if (!row) throw new Error('seed user not found');
    await admin.query('INSERT INTO user_passwords (user_id, password_hash) VALUES (?, ?)', [
      row.id,
      phc,
    ]);
    check('password seeded for sign-in', true, email);
    await admin.end();

    // 7. Start the bundle EXACTLY as Hostinger would: node server.mjs, with PORT and env.
    // NODE_ENV deliberately NOT set: the bundle must force production by itself (security
    // review 2026-10-17, HIGH) — proved below by the log line and the 404 on /v1/dev/sessions.
    const env = {
      ...process.env,
      PORT: String(PORT),
      API_PUBLIC_URL: ORIGIN,
      WEB_PUBLIC_URL: ORIGIN,
      CORS_ALLOWED_ORIGINS: ORIGIN,
      TRUSTED_PROXY_ADDRESSES: '127.0.0.1,::1',
      // Only what Hostinger's database setup writes: one URL, host `localhost`.
      DATABASE_URL: url('localhost'),
      WORKER_INPROCESS: '1',
      DATABASE_POOL_MAX: '5',
      SESSION_SECRET: SECRET('session'),
      CSRF_SECRET: SECRET('csrf'),
      AUTH_MFA_SEED_KEYS: `1:${Buffer.from('smoke-mfa-key-000000000000000000').toString('base64url')}`,
      AUTH_TOTP_ISSUER: 'TManage',
      EMAIL_DRIVER: 'smtp',
      EMAIL_FROM_ADDRESS: 'no-reply@tmanage.peetrix.com',
      EMAIL_FROM_NAME: 'TManage',
      SMTP_HOST: 'localhost',
      STORAGE_DRIVER: 's3',
      STORAGE_BUCKET: 'smoke-bucket',
      STORAGE_REGION: 'us-east-1',
      STORAGE_ACCESS_KEY_ID: 'smoke-access-key',
      STORAGE_SECRET_ACCESS_KEY: 'smoke-secret-key',
      MALWARE_SCAN_DRIVER: 'none',
      QUEUE_DRIVER: 'redis',
      CACHE_DRIVER: 'redis',
    };
    let stderr = '';
    delete env.NODE_ENV;
    server = spawn('node', ['server.mjs'], { cwd: BUNDLE, env });
    server.stdout.on('data', (b) => (stderr += b.toString()));
    server.stderr.on('data', (b) => (stderr += b.toString()));
    server.on('exit', (code) => (stderr += `\n[server exited ${code}]\n`));
    await waitPort(PORT, 180_000).catch((e) => {
      process.stdout.write(`\n----- server output -----\n${stderr}\n-------------------------\n`);
      throw e;
    });
    await waitFor(
      () => /listening on :/.test(stderr),
      60_000,
      'server did not report listening',
    ).catch(() => {});

    // 8. The second migration run — the bundle's own on-start — must be a no-op.
    check(
      'migrations no-op (second run)',
      /nothing to apply/.test(stderr),
      firstMatch(stderr, /migrations: .*/),
    );

    check(
      'single db user + localhost rewritten to 127.0.0.1',
      /single-user mode/.test(stderr) && /rewritten to 127\.0\.0\.1/.test(stderr),
      /in-process worker on/.test(stderr) ? 'in-process worker on' : 'worker did not start',
    );

    // 9. The HTTP journey.
    const before = stderr.length;
    const home = await hit('/');
    check('GET / renders', home.status >= 200 && home.status < 400, `status ${home.status}`);
    if (home.status >= 400) {
      const body = (await home.text())
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 400);
      process.stdout.write(
        `\n---- GET / server log ----\n${stderr.slice(before)}\n---- body ----\n${body}\n----\n`,
      );
    }
    const signIn = await hit('/sign-in');
    check('GET /sign-in loads', signIn.status === 200, `status ${signIn.status}`);
    const health = await hit('/healthz');
    const healthBody = await health.text();
    check('GET /healthz ok', health.status === 200 && /"status":"ok"/.test(healthBody));

    // Security review fixes, end to end in the bundle.
    const dev = await hit('/v1/dev/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: '00000000-0000-7000-8000-000000000000' }),
    });
    check(
      'NODE_ENV unset → production; POST /v1/dev/sessions is 404',
      dev.status === 404 && /running as production/.test(stderr),
      `status ${dev.status}`,
    );
    const hsts = home.headers.get('strict-transport-security') ?? '';
    const csp = home.headers.get('content-security-policy-report-only') ?? '';
    check(
      'GET / carries HSTS (1y, includeSubDomains) and a report-only CSP',
      /max-age=31536000/.test(hsts) && /includeSubDomains/.test(hsts) && /default-src/.test(csp),
      hsts,
    );
    const maintenance = await hit('/public/site/maintenance');
    const contactStatuses = [];
    for (let i = 0; i < 6; i += 1) {
      const contact = await hit('/public/site/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Smoke Test',
          email: 'smoke@example.com',
          message: `smoke ${i}`,
        }),
      });
      contactStatuses.push(contact.status);
    }
    check(
      '/public/site/* reaches the API; contact is rate-limited (6th → 429)',
      maintenance.status === 200 &&
        contactStatuses.slice(0, 5).every((code) => code === 201) &&
        contactStatuses[5] === 429,
      `maintenance ${maintenance.status}, contact ${contactStatuses.join(',')}`,
    );

    const login = await hit('/v1/auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const loginBody = await login.json().catch(() => ({}));
    check(
      'POST /v1/auth/password → authenticated',
      login.status === 200 && loginBody.status === 'authenticated',
      `status ${login.status}`,
    );

    const factors = await hit('/v1/auth/factors', {
      headers: loginBody.csrfToken ? { 'x-csrf-token': loginBody.csrfToken } : {},
    });
    check(
      'authenticated GET /v1/auth/factors with cookies',
      factors.status === 200,
      `status ${factors.status}`,
    );

    // 10. A real browser, through the TLS proxy: sign in on the page, land on the
    //     authenticated organization list, which fetches /v1/organizations with the cookies.
    const browserResult = await browserSignIn(email, password).catch((error) => ({
      ok: false,
      detail: String(error).split('\n')[0].slice(0, 200),
    }));
    check('browser sign-in → authenticated page', browserResult.ok, browserResult.detail);
  } finally {
    if (server && !server.killed) {
      if (process.platform === 'win32') sh('taskkill', ['/PID', String(server.pid), '/T', '/F']);
      else server.kill('SIGTERM');
    }
    if (db) await db.stop().catch(() => {});
  }

  const passed = results.filter((r) => r.ok).length;
  const summary = `smoke ${passed}/${results.length}`;
  writeReport(passed, summary);
  process.stdout.write(`\n${summary}\n`);
  process.exit(passed === results.length ? 0 : 1);
}

/** Generate a throwaway self-signed certificate for HOST (outside the repo). */
function selfSignedCert() {
  const dir = join(CHECK, 'tls');
  mkdirSync(dir, { recursive: true });
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  const r = sh('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-keyout',
    key,
    '-out',
    cert,
    '-subj',
    `/CN=${HOST}`,
  ]);
  if (r.status !== 0) throw new Error(`openssl failed: ${(r.stderr || '').slice(0, 200)}`);
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

/** HTTPS → http://127.0.0.1:PORT, one hop, with the X-Forwarded-* a hosting proxy adds. */
function startTlsProxy() {
  const proxy = createHttpsServer(selfSignedCert(), (req, res) => {
    const headers = {
      ...req.headers,
      'x-forwarded-for': req.socket.remoteAddress ?? '127.0.0.1',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': req.headers.host ?? HOST,
    };
    const up = httpRequest(
      { host: '127.0.0.1', port: PORT, method: req.method, path: req.url, headers },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  return new Promise((done) => proxy.listen(TLS_PORT, '127.0.0.1', () => done(proxy)));
}

async function browserSignIn(email, password) {
  // Playwright lives in the e2e workspace package; resolve it from there.
  const { chromium } = createRequire(join(REPO, 'e2e', 'package.json'))('@playwright/test');
  const proxy = await startTlsProxy();
  const browser = await chromium.launch({
    args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`],
  });
  try {
    const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
    await page.goto(`${ORIGIN}/sign-in`);
    await page.getByLabel('Work email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('**/organizations', { timeout: 30_000 });
    await page.getByText('Northstar Studio').first().waitFor({ timeout: 30_000 });
    return { ok: true, detail: 'signed in on /sign-in, /organizations lists Northstar Studio' };
  } finally {
    await browser.close();
    await new Promise((done) => proxy.close(done));
  }
}

function firstMatch(text, re) {
  return (text.match(re) ?? [''])[0];
}
function waitFor(pred, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((done, fail) => {
    const tick = () => {
      if (pred()) return done();
      if (Date.now() > deadline) return fail(new Error(message));
      setTimeout(tick, 300);
    };
    tick();
  });
}

function writeReport(passed, summary) {
  const zipMb = existsSync(ZIP) ? (readFileSync(ZIP).length / (1024 * 1024)).toFixed(1) : '?';
  const lines = [
    '# Hostinger bundle — local deploy check',
    '',
    `Result: **${summary}**, zip ${zipMb} MB`,
    '',
    '| check | result |',
    '| --- | --- |',
    ...results.map(
      (r) => `| ${r.name} | ${r.ok ? 'PASS' : 'FAIL'}${r.detail ? ` (${r.detail})` : ''} |`,
    ),
    '',
    'Hostinger build settings: app_type `other` (or `express`, never `next`), node_version 22,',
    'root_directory `./`, output_directory empty, package_manager npm, build_script',
    '`npm run build` (prebuilt, prints only), entry_file `server.mjs`.',
    'Env: DATABASE_URL / DB_* set by Hostinger (one user → single-user mode, localhost →',
    '127.0.0.1); NEXT_PUBLIC_* baked at bundle build (same-origin), none needed in the panel.',
    'Security review fixes covered above: NODE_ENV forced/asserted production + dev sign-in',
    'needs ALLOW_DEV_SIGN_IN (refused in production); /public/site/* routed + contact limiter;',
    'HSTS + report-only CSP; no *.map, no db/users.sql in the zip.',
    'Run: unpacked outside the repo, `node server.mjs`, private MariaDB 11.8 (log-bin on), every',
    'process stopped afterwards. Not proven: the real hPanel, SMTP delivery, S3 uploads.',
    '',
  ];
  mkdirSync(CHECK, { recursive: true });
  writeFileSync(REPORT, lines.join('\n'));
}

main().catch((error) => {
  check('smoke harness', false, String(error).slice(0, 300));
  writeReport(results.filter((r) => r.ok).length, 'smoke ERRORED');
  process.exit(1);
});
