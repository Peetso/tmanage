// Run: node --test brand-icons.test.mjs
//
// Live on 2026-10-26, GET /favicon.ico answered 307 to /favicon.ico/home: with no file in
// apps/web/public, Next matched the `[orgSlug]` route and redirected to a workspace home. The
// Claude connector list (and browsers) found no icon. The icons are now static files in
// apps/web/public, which Next serves ahead of any dynamic route; server.mjs proxies every non-API
// path to the web child unchanged. This checks that each file is a real image of the size it
// claims, and that none of these paths is taken by the API side of the proxy.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isApiPath } from './boot-guards.mjs';

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), '../web/public');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from a PNG's IHDR chunk. */
function pngSize(bytes) {
  assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE), 'not a PNG');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

const PNGS = {
  '/icon.png': 512,
  '/apple-touch-icon.png': 180,
  '/brand/tmanage-icon-512.png': 512,
  '/brand/tmanage-icon-192.png': 192,
  '/brand/tmanage-icon-48.png': 48,
  '/brand/tmanage-icon-32.png': 32,
};

test('every icon PNG is a real PNG of its stated square size', () => {
  for (const [path, size] of Object.entries(PNGS)) {
    assert.deepEqual(pngSize(readFileSync(join(PUBLIC, path))), [size, size], path);
  }
});

test('favicon.ico is an ICO holding 16, 32 and 48 px PNG images', () => {
  const ico = readFileSync(join(PUBLIC, 'favicon.ico'));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1, 'type 1 = icon');
  const count = ico.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16;
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    const [w, h] = pngSize(ico.subarray(offset, offset + length));
    assert.equal(w, ico.readUInt8(entry), 'directory width matches the image');
    sizes.push(h);
  }
  assert.deepEqual(sizes, [16, 32, 48]);
});

test('the icon paths go to the web child, not the API', () => {
  for (const path of ['/favicon.ico', ...Object.keys(PNGS), '/brand/tmanage-maskable.svg']) {
    assert.equal(isApiPath(path), false, path);
  }
});
