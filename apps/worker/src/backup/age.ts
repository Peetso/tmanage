/**
 * OFFSITE-BACKUP. Public-key encryption of a backup in the age v1 file format
 * (https://age-encryption.org/v1, C2SP), X25519 recipients only, on Node's built-in crypto.
 *
 * Why age and not AES-256-GCM with a key in env: the app holds only the **public** recipient
 * (`BACKUP_AGE_RECIPIENT=age1…`). The private identity (`AGE-SECRET-KEY-1…`) stays offline with
 * the operator, so whoever reads the app's environment, the host's disk or the bucket gets
 * ciphertext only. A symmetric key in env would decrypt every backup for anyone who can read
 * env. age also fixes the file format (chunked ChaCha20-Poly1305 STREAM, header MAC), so a
 * restore can use the reference `age -d` as well as this module; a home-made GCM framing would
 * have no second implementation to check it against.
 *
 * This is the TypeScript twin of `scripts/ops/backup-encrypt.mjs` (the host-side CLI, which has
 * no build step). `age.test.ts` decrypts the C2SP CCTV vectors and round-trips with that CLI,
 * so the two cannot drift apart unnoticed.
 *
 * Format: `age-encryption.org/v1`, one `-> X25519 <share>` stanza per recipient wrapping a random
 * 16-byte file key (ChaCha20-Poly1305 under HKDF-SHA-256 of the X25519 secret), the header MAC,
 * then a 16-byte nonce and 64 KiB ChaCha20-Poly1305 chunks, the last one flagged.
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
import type { KeyObject } from 'node:crypto';
import { Transform } from 'node:stream';

const INTRO = 'age-encryption.org/v1';
const X25519_INFO = 'age-encryption.org/v1/X25519';
const CHUNK = 64 * 1024;
const TAG = 16;

// ---- bech32 (BIP-173 as age uses it: no 90-character limit) ----

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3] as const;

function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i += 1) if ((top >>> i) & 1) chk ^= GEN[i] ?? 0;
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const codes = [...hrp].map((c) => c.charCodeAt(0));
  return [...codes.map((c) => c >>> 5), 0, ...codes.map((c) => c & 31)];
}

function convertBits(data: Iterable<number>, from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
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

export function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const data = convertBits(bytes, 8, 5, true);
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const check = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...check].map((d) => CHARSET[d] ?? '').join('')}`;
}

export function bech32Decode(text: string): { readonly hrp: string; readonly bytes: Buffer } {
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

const privateFromRaw = (raw: Buffer): KeyObject =>
  createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' });
const publicFromRaw = (raw: Buffer): KeyObject =>
  createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' });

function rawPublic(key: KeyObject): Buffer {
  const { x } = key.export({ format: 'jwk' });
  if (typeof x !== 'string') throw new Error('age: not an X25519 key');
  return Buffer.from(x, 'base64url');
}

/** The 32 raw bytes of an `age1…` recipient; throws on anything else. */
export function parseRecipient(text: string): Buffer {
  const { hrp, bytes } = bech32Decode(text.trim());
  if (hrp !== 'age' || bytes.length !== 32) throw new Error('not an age X25519 recipient');
  return bytes;
}

/** The 32 raw bytes of the first `AGE-SECRET-KEY-1…` line of an identity file. */
export function parseIdentity(text: string): Buffer {
  const line = text
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .find((l) => l.startsWith('AGE-SECRET-KEY-1'));
  if (line === undefined) throw new Error('no AGE-SECRET-KEY-1 line in the identity');
  const { hrp, bytes } = bech32Decode(line);
  if (hrp !== 'age-secret-key-' || bytes.length !== 32) throw new Error('not an age identity');
  return bytes;
}

/** A fresh key pair: `identity` is secret (keep it offline), `recipient` goes in env. */
export function generateIdentity(): { readonly identity: string; readonly recipient: string } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const { d } = privateKey.export({ format: 'jwk' });
  if (typeof d !== 'string') throw new Error('age: key generation failed');
  return {
    identity: bech32Encode('age-secret-key-', Buffer.from(d, 'base64url')).toUpperCase(),
    recipient: bech32Encode('age', rawPublic(publicKey)),
  };
}

// ---- primitives ----

const b64 = (buf: Buffer): string => buf.toString('base64').replace(/=+$/u, '');
function unb64(s: string): Buffer {
  // age uses canonical unpadded base64; anything else is a malformed header.
  if (!/^[A-Za-z0-9+/]*$/u.test(s)) throw new Error('age: bad base64');
  const out = Buffer.from(s, 'base64');
  if (b64(out) !== s) throw new Error('age: non-canonical base64');
  return out;
}
const hkdf = (ikm: Buffer, salt: Buffer, info: string): Buffer =>
  Buffer.from(hkdfSync('sha256', ikm, salt, info, 32));

function seal(key: Buffer, nonce: Buffer, plain: Buffer): Buffer {
  const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG });
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

function open(key: Buffer, nonce: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < TAG) throw new Error('age: truncated');
  const d = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG });
  d.setAuthTag(sealed.subarray(sealed.length - TAG));
  try {
    return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()]);
  } catch {
    throw new Error('age: authentication failed (wrong key or damaged file)');
  }
}

function chunkNonce(counter: number, last: boolean): Buffer {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(counter), 3);
  n[11] = last ? 1 : 0;
  return n;
}

function headerMac(fileKey: Buffer, headerUpToDashes: Buffer): Buffer {
  return createHmac('sha256', hkdf(fileKey, Buffer.alloc(0), 'header'))
    .update(headerUpToDashes)
    .digest();
}

function wrapBody(body: Buffer): string {
  const s = b64(body);
  const lines: string[] = [];
  for (let i = 0; i < s.length; i += 64) lines.push(s.slice(i, i + 64));
  if (s.length % 64 === 0) lines.push('');
  return lines.join('\n');
}

function buildHeader(fileKey: Buffer, recipients: readonly Buffer[]): Buffer {
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

/** A streaming encryptor to one or more recipients (`age1…` text or 32 raw bytes). */
export function encryptStream(recipients: readonly (string | Buffer)[]): Transform {
  const keys = recipients.map((r) => (typeof r === 'string' ? parseRecipient(r) : r));
  if (keys.length === 0) throw new Error('age: no recipient');
  const fileKey = randomBytes(16);
  const nonce = randomBytes(16);
  const payloadKey = hkdf(fileKey, nonce, 'payload');
  let pending = Buffer.alloc(0);
  let counter = 0;
  let started = false;
  const start = (self: Transform): void => {
    if (started) return;
    started = true;
    self.push(buildHeader(fileKey, keys));
    self.push(nonce);
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      start(this);
      pending = Buffer.concat([pending, chunk]);
      // A full chunk is sealed only once more data follows: the last chunk carries the flag.
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

interface Stanza {
  readonly args: readonly string[];
  readonly body: Buffer;
}

function parseHeader(text: string): { readonly stanzas: readonly Stanza[]; readonly mac: Buffer } {
  const lines = text.split('\n');
  if (lines[0] !== INTRO) throw new Error('age: not an age v1 file');
  const stanzas: Stanza[] = [];
  let i = 1;
  while ((lines[i] ?? '').startsWith('-> ')) {
    const args = (lines[i] ?? '').slice(3).split(' ');
    i += 1;
    let body = '';
    for (;;) {
      const l = lines[i];
      if (l === undefined) throw new Error('age: malformed header');
      i += 1;
      if (l.length > 64) throw new Error('age: malformed header');
      body += l;
      if (l.length < 64) break;
    }
    stanzas.push({ args, body: unb64(body) });
  }
  const last = lines[i] ?? '';
  if (!last.startsWith('--- ')) throw new Error('age: malformed header');
  return { stanzas, mac: unb64(last.slice(4)) };
}

function unwrapFileKey(stanzas: readonly Stanza[], identity: Buffer): Buffer {
  const priv = privateFromRaw(identity);
  const pub = rawPublic(createPublicKey(priv));
  for (const s of stanzas) {
    if (s.args[0] !== 'X25519') continue;
    if (s.args.length !== 2) throw new Error('age: malformed X25519 stanza');
    const share = unb64(s.args[1] ?? '');
    if (share.length !== 32) throw new Error('age: malformed X25519 stanza');
    if (s.body.length !== 32) throw new Error('age: malformed X25519 stanza');
    const secret = diffieHellman({ privateKey: priv, publicKey: publicFromRaw(share) });
    if (secret.every((b) => b === 0)) throw new Error('age: low-order share');
    const wrapKey = hkdf(secret, Buffer.concat([share, pub]), X25519_INFO);
    try {
      return open(wrapKey, Buffer.alloc(12), s.body);
    } catch {
      // Not this identity's stanza; try the next one.
    }
  }
  throw new Error('age: no stanza matches this identity');
}

/** A streaming decryptor for one identity (raw 32 bytes or the `AGE-SECRET-KEY-1` text). */
export function decryptStream(identity: string | Buffer): Transform {
  const secret = typeof identity === 'string' ? parseIdentity(identity) : identity;
  let pending = Buffer.alloc(0);
  let payloadKey: Buffer | null = null;
  let counter = 0;
  const sealedChunk = CHUNK + TAG;
  const readHeader = (): boolean => {
    const end = pending.indexOf('\n--- ');
    if (end === -1) return false;
    const eol = pending.indexOf('\n', end + 1);
    if (eol === -1) return false;
    const { stanzas, mac } = parseHeader(pending.subarray(0, eol).toString('latin1'));
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
    transform(chunk: Buffer, _encoding, done) {
      try {
        pending = Buffer.concat([pending, chunk]);
        if (payloadKey === null && !readHeader()) {
          done();
          return;
        }
        const key = payloadKey;
        if (key === null) throw new Error('age: truncated header');
        while (pending.length > sealedChunk) {
          this.push(open(key, chunkNonce(counter, false), pending.subarray(0, sealedChunk)));
          counter += 1;
          pending = pending.subarray(sealedChunk);
        }
        done();
      } catch (error) {
        done(error as Error);
      }
    },
    flush(done) {
      try {
        if (payloadKey === null && !readHeader()) throw new Error('age: truncated header');
        const key = payloadKey;
        if (key === null) throw new Error('age: truncated header');
        const plain = open(key, chunkNonce(counter, true), pending);
        if (plain.length === 0 && counter > 0) throw new Error('age: empty final chunk');
        this.push(plain);
        done();
      } catch (error) {
        done(error as Error);
      }
    },
  });
}
