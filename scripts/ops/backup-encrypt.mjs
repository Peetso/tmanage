#!/usr/bin/env node
/**
 * Public-key encryption for backups in the `age` v1 file format (age-encryption.org/v1, X25519
 * recipients only), written with Node's built-in crypto so the shared host needs no `age` binary.
 *
 * The host holds only the public recipient (`BACKUP_AGE_RECIPIENT=age1...`); the private identity
 * (`AGE-SECRET-KEY-1...`) stays offline with the operator, so a stolen backup or a stolen off-site
 * token yields ciphertext only. Files written here are meant to open with the reference tool too
 * (`age -d -i key.txt db.sql.gz.age`); `decrypt` below does the same without it.
 *
 *   node scripts/ops/backup-encrypt.mjs keygen                      # prints identity + recipient
 *   node scripts/ops/backup-encrypt.mjs encrypt --in f --out f.age [--recipient age1...]
 *   node scripts/ops/backup-encrypt.mjs decrypt --in f.age --out f --identity key.txt
 *
 * Format summary: header `age-encryption.org/v1`, one `-> X25519 <share>` stanza per recipient
 * wrapping a random 16-byte file key (ChaCha20-Poly1305 under HKDF of the X25519 secret), a
 * header MAC, then a 16-byte nonce and 64 KiB ChaCha20-Poly1305 STREAM chunks.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const INTRO = 'age-encryption.org/v1';
const X25519_INFO = 'age-encryption.org/v1/X25519';
const CHUNK = 64 * 1024;
const TAG = 16;

// ---- bech32 (BIP-173, as age uses it: no 90-character limit) ----

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i += 1) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function hrpExpand(hrp) {
  const codes = [...hrp].map((c) => c.charCodeAt(0));
  return [...codes.map((c) => c >>> 5), 0, ...codes.map((c) => c & 31)];
}

function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const max = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >>> bits) & max);
    }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & max);
  else if (!pad && (bits >= from || ((acc << (to - bits)) & max) !== 0)) {
    throw new Error('bech32: bad padding');
  }
  return out;
}

export function bech32Encode(hrp, bytes) {
  const data = convertBits(bytes, 8, 5, true);
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const check = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...check].map((d) => CHARSET[d]).join('')}`;
}

export function bech32Decode(text) {
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) {
    throw new Error('bech32: mixed case');
  }
  const s = text.toLowerCase();
  const sep = s.lastIndexOf('1');
  if (sep < 1 || sep + 7 > s.length) throw new Error('bech32: malformed');
  const hrp = s.slice(0, sep);
  const data = [...s.slice(sep + 1)].map((c) => {
    const d = CHARSET.indexOf(c);
    if (d === -1) throw new Error('bech32: bad character');
    return d;
  });
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new Error('bech32: bad checksum');
  return { hrp, bytes: Buffer.from(convertBits(data.slice(0, -6), 5, 8, false)) };
}

// ---- X25519 keys from raw bytes ----

const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');

const privateFromRaw = (raw) =>
  createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' });
const publicFromRaw = (raw) =>
  createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' });
const rawPublic = (keyObject) => Buffer.from(keyObject.export({ format: 'jwk' }).x, 'base64url');

export function parseRecipient(text) {
  const { hrp, bytes } = bech32Decode(text.trim());
  if (hrp !== 'age' || bytes.length !== 32) throw new Error('not an age X25519 recipient');
  return bytes;
}

export function parseIdentity(text) {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('AGE-SECRET-KEY-1'));
  if (!line) throw new Error('no AGE-SECRET-KEY-1 line in the identity');
  const { hrp, bytes } = bech32Decode(line);
  if (hrp !== 'age-secret-key-' || bytes.length !== 32) throw new Error('not an age identity');
  return bytes;
}

/** A fresh key pair: `identity` is secret (keep it offline), `recipient` goes in env. */
export function generateIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const d = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  return {
    identity: bech32Encode('age-secret-key-', d).toUpperCase(),
    recipient: bech32Encode('age', rawPublic(publicKey)),
  };
}

// ---- primitives ----

const b64 = (buf) => buf.toString('base64').replace(/=+$/, '');
const unb64 = (s) => {
  if (!/^[A-Za-z0-9+/]*$/.test(s)) throw new Error('age: bad base64');
  return Buffer.from(s, 'base64');
};
const hkdf = (ikm, salt, info) => Buffer.from(hkdfSync('sha256', ikm, salt, info, 32));

function seal(key, nonce, plain) {
  const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG });
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

function open(key, nonce, sealed) {
  if (sealed.length < TAG) throw new Error('age: truncated');
  const d = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG });
  d.setAuthTag(sealed.subarray(sealed.length - TAG));
  try {
    return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()]);
  } catch {
    throw new Error('age: authentication failed (wrong key or damaged file)');
  }
}

function chunkNonce(counter, last) {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(counter), 3);
  n[11] = last ? 1 : 0;
  return n;
}

function headerMac(fileKey, headerUpToDashes) {
  return createHmac('sha256', hkdf(fileKey, Buffer.alloc(0), 'header'))
    .update(headerUpToDashes)
    .digest();
}

function wrapBody(body) {
  const s = b64(body);
  const lines = [];
  for (let i = 0; i < s.length; i += 64) lines.push(s.slice(i, i + 64));
  if (s.length % 64 === 0) lines.push('');
  return lines.join('\n');
}

function buildHeader(fileKey, recipients) {
  let text = `${INTRO}\n`;
  for (const recipient of recipients) {
    const eph = generateKeyPairSync('x25519');
    const share = rawPublic(eph.publicKey);
    const secret = diffieHellman({
      privateKey: eph.privateKey,
      publicKey: publicFromRaw(recipient),
    });
    const wrapKey = hkdf(secret, Buffer.concat([share, recipient]), X25519_INFO);
    text += `-> X25519 ${b64(share)}\n${wrapBody(seal(wrapKey, Buffer.alloc(12), fileKey))}\n`;
  }
  text += '---';
  return Buffer.from(`${text} ${b64(headerMac(fileKey, Buffer.from(text)))}\n`);
}

/** Streaming encryptor to one or more `age1...` recipients. */
export function encryptStream(recipients) {
  const keys = recipients.map((r) => (typeof r === 'string' ? parseRecipient(r) : r));
  if (keys.length === 0) throw new Error('age: no recipient');
  const fileKey = randomBytes(16);
  const nonce = randomBytes(16);
  const payloadKey = hkdf(fileKey, nonce, 'payload');
  let pending = Buffer.alloc(0);
  let counter = 0;
  let started = false;
  const start = (self) => {
    if (started) return;
    started = true;
    self.push(buildHeader(fileKey, keys));
    self.push(nonce);
  };
  return new Transform({
    transform(chunk, _enc, done) {
      start(this);
      pending = Buffer.concat([pending, chunk]);
      while (pending.length > CHUNK) {
        this.push(seal(payloadKey, chunkNonce(counter, false), pending.subarray(0, CHUNK)));
        counter += 1;
        pending = pending.subarray(CHUNK);
      }
      done();
    },
    flush(done) {
      start(this);
      this.push(seal(payloadKey, chunkNonce(counter, true), pending));
      done();
    },
  });
}

function parseHeader(text) {
  const lines = text.split('\n');
  if (lines[0] !== INTRO) throw new Error('age: not an age v1 file');
  const stanzas = [];
  let i = 1;
  while (lines[i].startsWith('-> ')) {
    const args = lines[i].slice(3).split(' ');
    i += 1;
    let body = '';
    for (;;) {
      const l = lines[i];
      i += 1;
      body += l;
      if (l.length < 64) break;
    }
    stanzas.push({ args, body: unb64(body) });
  }
  if (!lines[i].startsWith('--- ')) throw new Error('age: malformed header');
  return { stanzas, mac: unb64(lines[i].slice(4)) };
}

function unwrapFileKey(stanzas, identity) {
  const priv = privateFromRaw(identity);
  const pub = rawPublic(createPublicKey(priv));
  for (const s of stanzas) {
    if (s.args[0] !== 'X25519' || s.args.length !== 2 || s.body.length !== 32) continue;
    const share = unb64(s.args[1]);
    const secret = diffieHellman({ privateKey: priv, publicKey: publicFromRaw(share) });
    if (secret.every((b) => b === 0)) throw new Error('age: low-order share');
    const wrapKey = hkdf(secret, Buffer.concat([share, pub]), X25519_INFO);
    try {
      return open(wrapKey, Buffer.alloc(12), s.body);
    } catch {
      // not ours; try the next stanza
    }
  }
  throw new Error('age: no stanza matches this identity');
}

/** Streaming decryptor for one identity (raw 32 bytes or the `AGE-SECRET-KEY-1` text). */
export function decryptStream(identity) {
  const secret = typeof identity === 'string' ? parseIdentity(identity) : identity;
  let pending = Buffer.alloc(0);
  let payloadKey = null;
  let counter = 0;
  const SEALED = CHUNK + TAG;
  const readHeader = () => {
    const end = pending.indexOf('\n--- ');
    if (end === -1) return false;
    const eol = pending.indexOf('\n', end + 1);
    if (eol === -1) return false;
    const headerText = pending.subarray(0, eol).toString('latin1');
    const { stanzas, mac } = parseHeader(headerText);
    const fileKey = unwrapFileKey(stanzas, secret);
    const expected = headerMac(fileKey, pending.subarray(0, end + 4));
    if (mac.length !== 32 || !timingSafeEqual(mac, expected))
      throw new Error('age: bad header MAC');
    if (pending.length < eol + 1 + 16) return false;
    payloadKey = hkdf(fileKey, pending.subarray(eol + 1, eol + 17), 'payload');
    pending = pending.subarray(eol + 17);
    return true;
  };
  return new Transform({
    transform(chunk, _enc, done) {
      try {
        pending = Buffer.concat([pending, chunk]);
        if (payloadKey === null && !readHeader()) return done();
        while (pending.length > SEALED) {
          this.push(open(payloadKey, chunkNonce(counter, false), pending.subarray(0, SEALED)));
          counter += 1;
          pending = pending.subarray(SEALED);
        }
        done();
      } catch (err) {
        done(err);
      }
    },
    flush(done) {
      try {
        if (payloadKey === null && !readHeader()) throw new Error('age: truncated header');
        const plain = open(payloadKey, chunkNonce(counter, true), pending);
        if (plain.length === 0 && counter > 0) throw new Error('age: empty final chunk');
        this.push(plain);
        done();
      } catch (err) {
        done(err);
      }
    },
  });
}

export async function encryptFile(input, output, recipients) {
  await pipeline(createReadStream(input), encryptStream(recipients), createWriteStream(output));
}

export async function decryptFile(input, output, identity) {
  await pipeline(createReadStream(input), decryptStream(identity), createWriteStream(output));
}

async function cli(argv) {
  const [cmd, ...rest] = argv;
  const { parseArgs } = await import('./backup-plan.mjs');
  if (cmd === 'keygen') {
    const { identity, recipient } = generateIdentity();
    console.log(`# created: ${new Date().toISOString()}`);
    console.log(`# public key: ${recipient}`);
    console.log(identity);
    return;
  }
  const args = parseArgs(rest, {
    in: 'string',
    out: 'string',
    recipient: 'string',
    identity: 'string',
  });
  if (!args.in || !args.out) throw new Error('--in and --out are required');
  if (cmd === 'encrypt') {
    const r = args.recipient ?? process.env.BACKUP_AGE_RECIPIENT;
    if (!r) throw new Error('no recipient: pass --recipient or set BACKUP_AGE_RECIPIENT');
    await encryptFile(
      args.in,
      args.out,
      r
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } else if (cmd === 'decrypt') {
    const file = args.identity ?? process.env.BACKUP_AGE_IDENTITY_FILE;
    if (!file)
      throw new Error('no identity: pass --identity <file> or set BACKUP_AGE_IDENTITY_FILE');
    await decryptFile(args.in, args.out, readFileSync(file, 'utf8'));
  } else {
    throw new Error('usage: backup-encrypt.mjs keygen | encrypt | decrypt');
  }
  console.log(`${cmd}ed ${args.in} -> ${args.out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  cli(process.argv.slice(2)).catch((err) => {
    console.error(`backup-encrypt failed: ${err.message}`);
    process.exit(1);
  });
}
