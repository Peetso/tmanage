/**
 * OFFSITE-BACKUP. The off-site backup's settings, parsed once at the boundary (IP-2) from the
 * validated environment. Three outcomes, so a half-filled panel is never mistaken for "off":
 *
 * - `off`: no `BACKUP_OCI_*` variable is set. The job does nothing and `/healthz/deep` keeps
 *   saying `backups: not_configured`.
 * - `invalid`: some are set but not all, or one is malformed. The job records a failed run
 *   (so deep health says `failed`) and logs the problem; it never stops the app (RT-1 keeps
 *   boot refusals for settings the app cannot serve without; a backup is not one of them).
 * - `ready`: everything the upload needs.
 */
import { parseRecipient } from './age.js';
import { DEFAULT_OFFSITE_MAX_BYTES, FREE_TIER_BYTES } from './retention.js';

export interface OffsiteBackupEnv {
  /** The operator credential the dump reads with (always set where `loadEnv` ran). */
  readonly DATABASE_MIGRATION_URL?: string | undefined;
  readonly BACKUP_OCI_NAMESPACE?: string | undefined;
  readonly BACKUP_OCI_REGION?: string | undefined;
  readonly BACKUP_OCI_BUCKET?: string | undefined;
  readonly BACKUP_OCI_ACCESS_KEY_ID?: string | undefined;
  readonly BACKUP_OCI_SECRET_ACCESS_KEY?: string | undefined;
  readonly BACKUP_OCI_ENDPOINT?: string | undefined;
  readonly BACKUP_OCI_MAX_BYTES?: number | undefined;
  readonly BACKUP_AGE_RECIPIENT?: string | undefined;
}

export interface OffsiteBackupConfig {
  readonly databaseUrl: string;
  readonly endpoint: URL;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly recipients: readonly string[];
  readonly maxBytes: number;
}

export type ParsedBackupConfig =
  | { readonly status: 'off' }
  | {
      readonly status: 'invalid';
      readonly bucket: string | null;
      readonly problems: readonly string[];
    }
  | { readonly status: 'ready'; readonly config: OffsiteBackupConfig };

/** Oracle's default region for this deployment (Canada Southeast, Montreal). */
export const DEFAULT_OCI_REGION = 'ca-montreal-1';

/** OCI's dedicated S3-compatible endpoint (path style) for a namespace and region. */
export function ociEndpoint(namespace: string, region: string): URL {
  return new URL(`https://${namespace}.compat.objectstorage.${region}.oci.customer-oci.com`);
}

const REGION = /^[a-z]{2,3}-[a-z]+-\d{1,2}$/u;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{0,62}$/u;
// OCI bucket names: letters, digits, hyphens, underscores, periods; kept S3-safe here.
const BUCKET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;

const blank = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t === undefined || t === '' ? undefined : t;
};

export function parseBackupConfig(env: OffsiteBackupEnv): ParsedBackupConfig {
  const namespace = blank(env.BACKUP_OCI_NAMESPACE);
  const bucket = blank(env.BACKUP_OCI_BUCKET);
  const accessKeyId = blank(env.BACKUP_OCI_ACCESS_KEY_ID);
  const secretAccessKey = blank(env.BACKUP_OCI_SECRET_ACCESS_KEY);
  const recipientText = blank(env.BACKUP_AGE_RECIPIENT);
  const endpointText = blank(env.BACKUP_OCI_ENDPOINT);
  const regionText = blank(env.BACKUP_OCI_REGION);
  const anyOci = [namespace, bucket, accessKeyId, secretAccessKey, endpointText, regionText].some(
    (v) => v !== undefined,
  );
  if (!anyOci) return { status: 'off' };

  const problems: string[] = [];
  const region = regionText ?? DEFAULT_OCI_REGION;
  if (!REGION.test(region)) problems.push('BACKUP_OCI_REGION is not an OCI region identifier');
  if (bucket === undefined) problems.push('BACKUP_OCI_BUCKET is not set');
  else if (!BUCKET.test(bucket)) problems.push('BACKUP_OCI_BUCKET is not a valid bucket name');
  if (accessKeyId === undefined) problems.push('BACKUP_OCI_ACCESS_KEY_ID is not set');
  if (secretAccessKey === undefined) problems.push('BACKUP_OCI_SECRET_ACCESS_KEY is not set');

  let endpoint: URL | null = null;
  if (endpointText !== undefined) {
    try {
      const url = new URL(endpointText);
      if (
        url.protocol !== 'https:' ||
        url.username !== '' ||
        url.password !== '' ||
        url.search !== '' ||
        url.hash !== '' ||
        (url.pathname !== '/' && url.pathname !== '')
      ) {
        problems.push('BACKUP_OCI_ENDPOINT must be a bare https:// origin');
      } else endpoint = url;
    } catch {
      problems.push('BACKUP_OCI_ENDPOINT is not a URL');
    }
  } else if (namespace === undefined) {
    problems.push('BACKUP_OCI_NAMESPACE is not set');
  } else if (!NAMESPACE.test(namespace)) {
    problems.push('BACKUP_OCI_NAMESPACE is not a valid Object Storage namespace');
  } else if (REGION.test(region)) {
    endpoint = ociEndpoint(namespace, region);
  }

  // Plaintext never leaves the host: without a public key there is no off-site copy.
  const recipients = (recipientText ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (recipients.length === 0) problems.push('BACKUP_AGE_RECIPIENT is not set');
  for (const r of recipients) {
    try {
      parseRecipient(r);
    } catch {
      problems.push('BACKUP_AGE_RECIPIENT is not an age1… public key');
    }
  }

  const databaseUrl = blank(env.DATABASE_MIGRATION_URL);
  if (databaseUrl === undefined) problems.push('DATABASE_MIGRATION_URL is not set');

  const maxBytes = env.BACKUP_OCI_MAX_BYTES ?? DEFAULT_OFFSITE_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > FREE_TIER_BYTES) {
    problems.push('BACKUP_OCI_MAX_BYTES must be a positive byte count within the 20 GB free tier');
  }

  if (
    problems.length > 0 ||
    endpoint === null ||
    bucket === undefined ||
    databaseUrl === undefined
  ) {
    return { status: 'invalid', bucket: bucket ?? null, problems };
  }
  return {
    status: 'ready',
    config: {
      databaseUrl,
      endpoint,
      region,
      bucket,
      accessKeyId: accessKeyId ?? '',
      secretAccessKey: secretAccessKey ?? '',
      recipients,
      maxBytes,
    },
  };
}
