#!/usr/bin/env node
/**
 * Off-site copy of a backup to the operator's Google Drive ("TManage Ops" folder), 56-12 item (2)
 * brought forward to R0 by 56-29. Plain Node + the Drive REST API: no rclone, no SDK, nothing paid.
 *
 * Only ciphertext leaves the host: `backup.mjs --offsite` uploads the `.age` files written for
 * `BACKUP_AGE_RECIPIENT` plus the two manifests (names, sizes, hashes — no data, no secrets).
 * Scope is `drive.file`: the token can see and delete only the files this tool created.
 *
 * Env (all four, else off-site is skipped and the backup still succeeds):
 *   BACKUP_DRIVE_CLIENT_ID, BACKUP_DRIVE_CLIENT_SECRET  — a Google OAuth "Desktop app" client
 *   BACKUP_DRIVE_REFRESH_TOKEN                          — printed once by `authorize` below
 *   BACKUP_DRIVE_FOLDER_ID                              — printed once by `authorize` below
 *
 *   node scripts/ops/offsite-drive.mjs authorize   # on the operator's own PC, once
 *   node scripts/ops/offsite-drive.mjs list        # stamps present off-site
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, resolve } from 'node:path';
import { URLSearchParams, fileURLToPath } from 'node:url';

import { isStamp, selectOffsiteForPruning } from './backup-plan.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
/** Resumable-upload chunk: a multiple of 256 KiB, small enough for a shared host's memory. */
const PART = 8 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

export function driveConfig(env = process.env) {
  const c = {
    clientId: env.BACKUP_DRIVE_CLIENT_ID,
    clientSecret: env.BACKUP_DRIVE_CLIENT_SECRET,
    refreshToken: env.BACKUP_DRIVE_REFRESH_TOKEN,
    folderId: env.BACKUP_DRIVE_FOLDER_ID,
  };
  return Object.values(c).every((v) => typeof v === 'string' && v !== '') ? c : null;
}

async function call(url, init = {}) {
  const res = await fetch(url, { ...init, signal: globalThis.AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok && res.status !== 308) {
    // Google's error body names the reason; it never echoes the token.
    const body = (await res.text()).slice(0, 300);
    throw new Error(
      `Drive ${init.method ?? 'GET'} ${new URL(url).pathname} -> ${res.status} ${body}`,
    );
  }
  return res;
}

export async function accessToken(c) {
  const res = await call(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
    }),
  });
  return (await res.json()).access_token;
}

/** Resumable upload in `PART`-sized pieces; returns the Drive file id. */
export async function uploadFile(token, folderId, path, stamp) {
  const size = statSync(path).size;
  const start = await call(`${UPLOAD}?uploadType=resumable&fields=id`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': 'application/octet-stream',
      'x-upload-content-length': String(size),
    },
    body: JSON.stringify({
      name: `${stamp}-${basename(path)}`,
      parents: [folderId],
      appProperties: { tmanageBackup: '1', stamp },
    }),
  });
  const session = start.headers.get('location');
  if (!session) throw new Error('Drive gave no upload session');
  const fd = openSync(path, 'r');
  try {
    let offset = 0;
    do {
      const buf = Buffer.alloc(Math.min(PART, size - offset));
      readSync(fd, buf, 0, buf.length, offset);
      const end = offset + buf.length - 1;
      const res = await call(session, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-range': size === 0 ? 'bytes */0' : `bytes ${offset}-${end}/${size}`,
        },
        body: buf,
      });
      offset += buf.length;
      if (res.status !== 308) return (await res.json()).id;
    } while (offset < size);
    throw new Error('Drive upload ended without a file id');
  } finally {
    closeSync(fd);
  }
}

export async function listBackupFiles(token, folderId) {
  const files = [];
  let pageToken;
  do {
    const q = `'${folderId.replace(/'/g, '')}' in parents and trashed = false and appProperties has { key='tmanageBackup' and value='1' }`;
    const params = new URLSearchParams({
      q,
      fields: 'nextPageToken, files(id, name, appProperties)',
      pageSize: '1000',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await call(`${API}/files?${params}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    files.push(...body.files);
    pageToken = body.nextPageToken;
  } while (pageToken);
  return files;
}

/**
 * Uploads `paths` under `stamp`, then prunes the off-site set (48 h + 30 daily + 12 monthly).
 * Returns `{ status, location, at, pruned }`; never throws — a failed upload is `failed`.
 */
export async function uploadBackup({
  paths,
  stamp,
  now = new Date(),
  env = process.env,
  log = console.log,
}) {
  const c = driveConfig(env);
  if (!c) return { status: 'skipped', location: null, at: null, pruned: 0 };
  try {
    const token = await accessToken(c);
    const ids = [];
    for (const p of paths) {
      ids.push(await uploadFile(token, c.folderId, p, stamp));
      log(`Off-site: uploaded ${basename(p)}`);
    }
    const files = await listBackupFiles(token, c.folderId);
    const drop = new Set(
      selectOffsiteForPruning(
        files.map((f) => f.appProperties?.stamp).filter((s) => isStamp(s ?? '')),
        now,
      ),
    );
    let pruned = 0;
    for (const f of files.filter((x) => drop.has(x.appProperties?.stamp))) {
      await call(`${API}/files/${encodeURIComponent(f.id)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
      pruned += 1;
    }
    if (pruned) log(`Off-site: pruned ${pruned} old file(s)`);
    return {
      status: 'uploaded',
      location: `gdrive:${c.folderId}/${stamp}`,
      at: new Date(),
      pruned,
      ids,
    };
  } catch (err) {
    return { status: 'failed', location: null, at: null, pruned: 0, error: err.message };
  }
}

/** One-time consent on the operator's PC: loopback redirect + PKCE, prints the env lines. */
async function authorize() {
  const clientId = process.env.BACKUP_DRIVE_CLIENT_ID;
  const clientSecret = process.env.BACKUP_DRIVE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'set BACKUP_DRIVE_CLIENT_ID and BACKUP_DRIVE_CLIENT_SECRET (Desktop app client) first',
    );
  }
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('hex');
  const server = createServer();
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const redirectUri = `http://127.0.0.1:${server.address().port}`;
  const url = `${AUTH_URL}?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  })}`;
  console.log(`Open this link in your browser and allow access:\n\n${url}\n`);
  const code = await new Promise((ok, fail) => {
    server.on('request', (req, res) => {
      const q = new URL(req.url, redirectUri).searchParams;
      if (!q.get('code') && !q.get('error')) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'text/plain' }).end('Done. You can close this tab.');
      server.close();
      if (q.get('state') !== state) fail(new Error('state mismatch'));
      else if (q.get('error')) fail(new Error(q.get('error')));
      else ok(q.get('code'));
    });
  });
  const res = await call(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  const tokens = await res.json();
  if (!tokens.refresh_token) throw new Error('Google returned no refresh token; run again');
  const folder = await call(`${API}/files?fields=id`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'TManage Ops backups',
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  const { id } = await folder.json();
  console.log('Add these to the cron line (and the password manager). Shown once:\n');
  console.log(`BACKUP_DRIVE_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log(`BACKUP_DRIVE_FOLDER_ID=${id}`);
}

async function list() {
  const c = driveConfig();
  if (!c) throw new Error('off-site is not configured (BACKUP_DRIVE_* missing)');
  const files = await listBackupFiles(await accessToken(c), c.folderId);
  const stamps = [...new Set(files.map((f) => f.appProperties?.stamp))].filter(Boolean).sort();
  for (const s of stamps) console.log(s);
  console.log(`${stamps.length} stamp(s), ${files.length} file(s) off-site`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const cmd = process.argv[2];
  const run = cmd === 'authorize' ? authorize : cmd === 'list' ? list : null;
  if (!run) {
    console.error('usage: offsite-drive.mjs authorize | list');
    process.exit(1);
  }
  run().catch((err) => {
    console.error(`offsite-drive failed: ${err.message}`);
    process.exit(1);
  });
}
