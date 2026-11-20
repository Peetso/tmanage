import { describe, expect, it } from 'vitest';

import { generateIdentity } from './age.js';
import { parseBackupConfig } from './backup-config.js';

const RECIPIENT = generateIdentity().recipient;
const FULL = {
  DATABASE_MIGRATION_URL: 'mysql://owner:pw@127.0.0.1:3306/u1_tmanage',
  BACKUP_OCI_NAMESPACE: 'axaxnpcrorw5',
  BACKUP_OCI_BUCKET: 'tmanage-db-backups',
  BACKUP_OCI_ACCESS_KEY_ID: '0123456789abcdef0123456789abcdef01234567',
  BACKUP_OCI_SECRET_ACCESS_KEY: 'c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlYw==',
  BACKUP_AGE_RECIPIENT: RECIPIENT,
};

describe('parseBackupConfig (OFFSITE-BACKUP)', () => {
  it('is off when no BACKUP_OCI_* variable is set, even with an age key from the cron scripts', () => {
    expect(parseBackupConfig({ DATABASE_MIGRATION_URL: FULL.DATABASE_MIGRATION_URL })).toEqual({
      status: 'off',
    });
    expect(
      parseBackupConfig({
        ...FULL,
        BACKUP_OCI_NAMESPACE: undefined,
        BACKUP_OCI_BUCKET: ' ',
        BACKUP_OCI_ACCESS_KEY_ID: undefined,
        BACKUP_OCI_SECRET_ACCESS_KEY: '',
      }),
    ).toEqual({ status: 'off' });
  });

  it('derives the dedicated path-style endpoint in ca-montreal-1 by default', () => {
    const parsed = parseBackupConfig(FULL);
    expect(parsed.status).toBe('ready');
    if (parsed.status !== 'ready') return;
    expect(parsed.config.endpoint.href).toBe(
      'https://axaxnpcrorw5.compat.objectstorage.ca-montreal-1.oci.customer-oci.com/',
    );
    expect(parsed.config.region).toBe('ca-montreal-1');
    expect(parsed.config.maxBytes).toBe(8_589_934_592);
    expect(parsed.config.databaseUrl).toBe(FULL.DATABASE_MIGRATION_URL);
  });

  it('accepts the legacy oraclecloud.com endpoint as an override', () => {
    const parsed = parseBackupConfig({
      ...FULL,
      BACKUP_OCI_NAMESPACE: undefined,
      BACKUP_OCI_ENDPOINT:
        'https://axaxnpcrorw5.compat.objectstorage.ca-montreal-1.oraclecloud.com',
    });
    expect(parsed.status === 'ready' && parsed.config.endpoint.host).toBe(
      'axaxnpcrorw5.compat.objectstorage.ca-montreal-1.oraclecloud.com',
    );
  });

  it('names every problem of a half-filled setup instead of switching off', () => {
    const parsed = parseBackupConfig({
      DATABASE_MIGRATION_URL: FULL.DATABASE_MIGRATION_URL,
      BACKUP_OCI_BUCKET: 'tmanage-db-backups',
      BACKUP_AGE_RECIPIENT: 'AGE-SECRET-KEY-1NOTAPUBLICKEY',
      BACKUP_OCI_MAX_BYTES: 25_000_000_000,
    });
    expect(parsed.status).toBe('invalid');
    if (parsed.status !== 'invalid') return;
    expect(parsed.bucket).toBe('tmanage-db-backups');
    expect(parsed.problems).toEqual([
      'BACKUP_OCI_ACCESS_KEY_ID is not set',
      'BACKUP_OCI_SECRET_ACCESS_KEY is not set',
      'BACKUP_OCI_NAMESPACE is not set',
      'BACKUP_AGE_RECIPIENT is not an age1… public key',
      'BACKUP_OCI_MAX_BYTES must be a positive byte count within the 10 GiB free tier',
    ]);
  });

  it('accepts a budget of exactly 10 GiB and refuses one byte more (Standard-tier free limit)', () => {
    expect(parseBackupConfig({ ...FULL, BACKUP_OCI_MAX_BYTES: 10_737_418_240 }).status).toBe(
      'ready',
    );
    const over = parseBackupConfig({ ...FULL, BACKUP_OCI_MAX_BYTES: 10_737_418_241 });
    expect(over.status).toBe('invalid');
    if (over.status !== 'invalid') return;
    expect(over.problems).toEqual([
      'BACKUP_OCI_MAX_BYTES must be a positive byte count within the 10 GiB free tier',
    ]);
  });

  it('refuses an endpoint that is not a bare https origin, and a bad region', () => {
    for (const endpoint of [
      'http://x.example',
      'https://u:p@x.example',
      'https://x.example/path',
    ]) {
      const parsed = parseBackupConfig({ ...FULL, BACKUP_OCI_ENDPOINT: endpoint });
      expect(parsed.status).toBe('invalid');
    }
    expect(parseBackupConfig({ ...FULL, BACKUP_OCI_REGION: 'montreal' }).status).toBe('invalid');
  });

  it('never puts a secret into a problem message', () => {
    const parsed = parseBackupConfig({ ...FULL, BACKUP_OCI_REGION: 'bad region' });
    expect(JSON.stringify(parsed)).not.toContain(FULL.BACKUP_OCI_SECRET_ACCESS_KEY);
  });
});
