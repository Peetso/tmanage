import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { describe, expect, it } from 'vitest';

import { decryptStream, encryptStream, generateIdentity, parseRecipient } from './age.js';

/**
 * C2SP CCTV age test vectors (https://github.com/C2SP/CCTV/tree/main/age/testdata; "the
 * license allows this without attribution"): `x25519`, `x25519_bad_tag`,
 * `x25519_multiple_recipients`, verbatim, base64 of the whole vector file.
 */
const VECTORS = {
  x25519:
    'ZXhwZWN0OiBzdWNjZXNzCnBheWxvYWQ6IDAxM2Y1NDQwMGM4MmRhMDgwMzc3NTlhZGE5MDdhOGI4NjRlOTdkZTgxYzA4OGExODIwNjJjNGI1NjIyZmQyYWIKZmlsZSBrZXk6IDU5NDU0YzRjNGY1NzIwNTM1NTQyNGQ0MTUyNDk0ZTQ1CmlkZW50aXR5OiBBR0UtU0VDUkVULUtFWS0xRUdUWlZGRlYyMDgzNU5XWVY2MjcwTFhZVksyVktOWDJNTURLV1lLTE1HUjQ4VUFXWDQwUTJQMkxNMAoKYWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBURWlGMHlwcXIrYnB2Y3FYTnlDVkpwTDdPdXdQZFZ3UEw3S1FFYkZET0NjCmhqYWJHWHdTTFE5YzNTNkx3MmkrUzJUdTJmaXdRSEhzbGJCTjZCNDFGTEUKLS0tIFd5SnA5Ri85Rk9aaDdnSmRoZXEyV0lKY3dIZ1ljOE5JVmgzZGR3aHJjTmcK7s9ix86RtDMnTmjU8vkTTLdMW/73vqpSyPC8DpksHoMx+2Y=',
  x25519_bad_tag:
    'ZXhwZWN0OiBubyBtYXRjaApmaWxlIGtleTogNTk0NTRjNGM0ZjU3MjA1MzU1NDI0ZDQxNTI0OTRlNDUKaWRlbnRpdHk6IEFHRS1TRUNSRVQtS0VZLTFFR1RaVkZGVjIwODM1TldZVjYyNzBMWFlWSzJWS05YMk1NREtXWUtMTUdSNDhVQVdYNDBRMlAyTE0wCmNvbW1lbnQ6IHRoZSBDaGFDaGEyMFBvbHkxMzA1IGF1dGhlbnRpY2F0aW9uIHRhZyBvbiB0aGUgYm9keSBvZiB0aGUgWDI1NTE5IHN0YW56YSBpcyB3cm9uZwoKYWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBURWlGMHlwcXIrYnB2Y3FYTnlDVkpwTDdPdXdQZFZ3UEw3S1FFYkZET0NjCmhqYWJHWHdTTFE5YzNTNkx3MmkrUzJUdTJmaXdRSEhzbGJCTjZCNDFGRTQKLS0tIHpPQ0hweW5WMGFWN3A0UjZjK2JPYXBncHE5VHRwRmdHZ1lnaFEyK1BJWDgK7s9ix86RtDMnTmjU8vkTTLdMW/73vqpSyPC8DpksHoMx+2Y=',
  x25519_multiple_recipients:
    'ZXhwZWN0OiBzdWNjZXNzCnBheWxvYWQ6IDAxM2Y1NDQwMGM4MmRhMDgwMzc3NTlhZGE5MDdhOGI4NjRlOTdkZTgxYzA4OGExODIwNjJjNGI1NjIyZmQyYWIKZmlsZSBrZXk6IDU5NDU0YzRjNGY1NzIwNTM1NTQyNGQ0MTUyNDk0ZTQ1CmlkZW50aXR5OiBBR0UtU0VDUkVULUtFWS0xRUdUWlZGRlYyMDgzNU5XWVY2MjcwTFhZVksyVktOWDJNTURLV1lLTE1HUjQ4VUFXWDQwUTJQMkxNMAoKYWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBhanRxQXZERWtWTnIyQjd6VU90cTJtQVFYRFNCbE5yVkF1TS9kS2I1c1Q0CjBldnJLL0hRWFZzUTRZYURlKzY1OWw1T1F6dkF6RDJ5dExHSFFMUWlxeGcKLT4gWDI1NTE5IDBxQzd1NkFiTHh1d25NOHRQRk9XVnRXWm4vWlplN3o3Z2NzUDVrZ0EwRkkKWTNPemV2TG0yM1Z4N1BOOWszM0Y5eStlcmNXZS9iY1pKTHFocUEzaDQwOAotLS0gODU1cEtibFF6WjNvYWJEb3d4UkRRdlNqL3hvNDdaU2g1V1Rqa21LMEkwVQrwuBi+DzVUQjmZIK2AhJZLb5XDbbNeT1nY+J488m8tH6VCEw==',
} as const;

function vector(name: keyof typeof VECTORS): {
  readonly headers: Readonly<Record<string, string>>;
  readonly file: Buffer;
} {
  const raw = Buffer.from(VECTORS[name], 'base64');
  const split = raw.indexOf('\n\n');
  const headers: Record<string, string> = {};
  for (const line of raw.subarray(0, split).toString('utf8').split('\n')) {
    const at = line.indexOf(': ');
    headers[line.slice(0, at)] = line.slice(at + 2);
  }
  return { headers, file: raw.subarray(split + 2) };
}

const run = (stream: NodeJS.ReadWriteStream, data: Buffer): Promise<Buffer> =>
  buffer(Readable.from([data]).pipe(stream));

describe('age v1 decryption against the C2SP CCTV vectors', () => {
  for (const name of ['x25519', 'x25519_multiple_recipients'] as const) {
    it(`${name}: decrypts to the vector's payload`, async () => {
      const { headers, file } = vector(name);
      const plain = await run(decryptStream(headers['identity'] ?? ''), file);
      expect(createHash('sha256').update(plain).digest('hex')).toBe(headers['payload']);
    });
  }

  it('x25519_bad_tag: refuses a stanza whose authentication tag is wrong', async () => {
    const { headers, file } = vector('x25519_bad_tag');
    await expect(run(decryptStream(headers['identity'] ?? ''), file)).rejects.toThrow(
      /no stanza matches/u,
    );
  });
});

describe('age v1 encryption', () => {
  it('round-trips across the 64 KiB chunk boundaries and to several recipients', async () => {
    const a = generateIdentity();
    const b = generateIdentity();
    for (const size of [0, 1, 65_536, 65_537, 200_000]) {
      const plain = Buffer.alloc(size, size % 251);
      const sealed = await run(encryptStream([a.recipient, b.recipient]), plain);
      expect((await run(decryptStream(a.identity), sealed)).equals(plain)).toBe(true);
      expect((await run(decryptStream(b.identity), sealed)).equals(plain)).toBe(true);
    }
  });

  it('refuses a wrong key, a flipped byte and a truncated file', async () => {
    const me = generateIdentity();
    const sealed = await run(encryptStream([me.recipient]), Buffer.alloc(70_000, 9));
    await expect(run(decryptStream(generateIdentity().identity), sealed)).rejects.toThrow(
      /no stanza/u,
    );
    const flipped = Buffer.from(sealed);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    await expect(run(decryptStream(me.identity), flipped)).rejects.toThrow(/authentication/u);
    // 70,000 bytes seal as one full chunk + a final one of 4,464 (+16 tag). Cutting the final
    // chunk off leaves a full non-final chunk, which must not pass as the end of the file.
    for (const cut of [4_480, 1_000]) {
      await expect(
        run(decryptStream(me.identity), sealed.subarray(0, sealed.length - cut)),
      ).rejects.toThrow(/authentication/u);
    }
  });

  it('never writes the plaintext into the ciphertext', async () => {
    const me = generateIdentity();
    const secret = Buffer.from("users row ('u1', 'alice@example.com')");
    const sealed = await run(encryptStream([me.recipient]), secret);
    expect(sealed.includes(secret)).toBe(false);
    expect(sealed.includes(Buffer.from('alice@example.com'))).toBe(false);
  });

  it('refuses a recipient that is not an age1 X25519 key', () => {
    expect(() => parseRecipient('age1notakey')).toThrow();
    expect(() => encryptStream([])).toThrow(/no recipient/u);
  });
});

describe('the TypeScript twin and scripts/ops/backup-encrypt.mjs agree', () => {
  // A string path keeps the untyped .mjs out of the type checker; vitest resolves it at run time.
  const cliPath = new URL('../../../../scripts/ops/backup-encrypt.mjs', import.meta.url).href;
  interface Cli {
    encryptStream(recipients: string[]): NodeJS.ReadWriteStream;
    decryptStream(identity: string): NodeJS.ReadWriteStream;
    generateIdentity(): { identity: string; recipient: string };
  }

  it('each decrypts what the other encrypts', async () => {
    const cli = (await import(/* @vite-ignore */ cliPath)) as Cli;
    const plain = Buffer.alloc(150_000, 7);
    const mine = generateIdentity();
    const theirs = cli.generateIdentity();
    const fromMine = await run(encryptStream([theirs.recipient]), plain);
    expect((await run(cli.decryptStream(theirs.identity), fromMine)).equals(plain)).toBe(true);
    const fromTheirs = await run(cli.encryptStream([mine.recipient]), plain);
    expect((await run(decryptStream(mine.identity), fromTheirs)).equals(plain)).toBe(true);
  });
});
