#!/usr/bin/env node
// LANE-X (2026-11-22). Print one FIELD_CIPHER_KEYS entry: `<id>:<base64url 32 bytes>`.
//
//   node scripts/gen-field-cipher-key.mjs           -> 1:<43 base64url characters>
//   node scripts/gen-field-cipher-key.mjs --id 2    -> 2:<...>   (the next key, for a rotation)
//
// 32 bytes from the OS CSPRNG (node:crypto randomBytes): AES-256, ASVS 5.0 11.2.3 (at least
// 128 bits of security). base64url has no "=", "+" or "/", and the line has no ";", so
// Hostinger's .env writer keeps it whole (it cuts a value at ";"). With more than one key, join
// the entries with "," (never ";"): `1:<old>,2:<new>`.
//
// The key goes to stdout only, once. Paste it into hPanel and keep it in no file, chat or
// commit; it must also differ from every AUTH_MFA_SEED_KEYS key (the API refuses a shared key
// at boot). The procedure is in docs/runbooks/deploy.md, "Setting FIELD_CIPHER_KEYS".
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
let id = '1';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--id' && i + 1 < args.length) {
    id = args[i + 1];
    i += 1;
  } else {
    process.stderr.write(
      'usage: node scripts/gen-field-cipher-key.mjs [--id <positive integer>]\n',
    );
    process.exit(2);
  }
}
// The same id rule as parseFieldCipherKeys (packages/domain/src/security/field-cipher.ts).
if (!/^[1-9]\d{0,8}$/.test(id)) {
  process.stderr.write('--id must be a positive integer (1 to 999999999, no leading zero)\n');
  process.exit(2);
}

const key = randomBytes(32).toString('base64url');
const line = `${id}:${key}`;
// Self-check against the format the API accepts, so a bad line never reaches hPanel.
if (!/^[1-9]\d{0,8}:[A-Za-z0-9_-]{43}$/.test(line) || Buffer.from(key, 'base64url').length !== 32) {
  process.stderr.write('internal error: generated key does not have the expected format\n');
  process.exit(1);
}
process.stdout.write(`${line}\n`);
