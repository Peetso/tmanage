import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { QueueMailer, decodeQueuedMessage, recipientHash } from './queue-mailer.js';
import type { MailQueueEntry } from './queue-mailer.js';
import type { MailMessage } from './mailer.js';

function capture(): { entries: MailQueueEntry[]; mailer: QueueMailer } {
  const entries: MailQueueEntry[] = [];
  const at = new Date('2026-10-29T10:00:00.000Z');
  const mailer = new QueueMailer(
    { enqueue: (entry) => Promise.resolve(void entries.push(entry)) },
    { now: () => at, newId: () => `id-${String(entries.length)}` },
  );
  return { entries, mailer };
}

describe('QueueMailer', () => {
  it('enqueues a hashed recipient, the template lane and an auth deadline', async () => {
    const { entries, mailer } = capture();
    const result = await mailer.send({
      to: ' Ada@Example.com ',
      subject: 'Reset',
      text: 'link',
      templateKey: 'password_reset',
    });
    expect(result).toBe('sent');
    const entry = entries[0] as MailQueueEntry;
    expect(entry.lane).toBe('auth');
    expect(entry.mailbox).toBe('security');
    expect(entry.toHash).toBe(recipientHash('ada@example.com'));
    expect(entry.toHash).toHaveLength(64);
    expect(entry.deadlineAt?.toISOString()).toBe('2026-10-29T11:00:00.000Z');
    expect(decodeQueuedMessage(entry.payloadJson, entry.templateKey)?.to).toBe(' Ada@Example.com ');
  });

  it('SEC56-31: a caller cannot set the lane — only templateKey decides', async () => {
    const { entries, mailer } = capture();
    const forged = { to: 'a@b.c', subject: 's', text: 't', lane: 'auth', mailbox: 'security' };
    await mailer.send(forged as unknown as MailMessage);
    await mailer.send({ ...forged, templateKey: 'made_up' } as unknown as MailMessage);
    expect(entries.map((e) => e.lane)).toEqual(['transactional', 'transactional']);
    expect(entries.every((e) => e.deadlineAt === null)).toBe(true);
    expect(entries[0]?.payloadJson).not.toContain('lane');
  });
});

describe('only the drainer submits to SMTP', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const allowed = new Set(['apps/worker/src/jobs/mail-drainer.ts']);
  const direct =
    /\b(?:smtp\w*|SmtpMailer)\s*\.\s*(?:send|submit)\s*\(|new\s+SmtpMailer\([^)]*\)\s*\.\s*send/iu;

  function walk(dir: string, out: string[]): void {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, out);
      else if (/\.(?:ts|mts|mjs)$/u.test(name) && !/\.test\.|\.d\.ts$/u.test(name)) out.push(path);
    }
  }

  it('finds no direct SmtpMailer send outside apps/worker/src/jobs/mail-drainer.ts', () => {
    const files: string[] = [];
    for (const dir of ['apps/api/src', 'apps/worker/src', 'packages/mail/src']) {
      walk(join(root, dir), files);
    }
    for (const name of readdirSync(join(root, 'apps/server'))) {
      if (name.endsWith('.mjs') && !name.includes('.test.'))
        files.push(join(root, 'apps/server', name));
    }
    const offenders = files
      .map((file) => relative(root, file).replaceAll('\\', '/'))
      .filter((file) => !allowed.has(file) && !file.includes('/test/'))
      .filter((file) => direct.test(readFileSync(join(root, file), 'utf8')));
    expect(offenders).toEqual([]);
  }, 30_000);
});
