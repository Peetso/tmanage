/**
 * Versioned `usage.*` event payload schemas.
 *
 * These are the schemas the LEDGER blocked while they lived under `docs/planning/contracts/events/`
 * (a path build lanes may not edit); hosting them here, under `packages/`, is the agreed
 * "schemas outside docs/planning" resolution (R12). Each describes a payload the api already
 * emits — see `apps/api/src/modules/files/files.service.ts` (`storage_reserved` / `storage_committed`
 * / `storage_released`) and `apps/api/src/modules/files/usage-thresholds.ts` (`threshold_reached`).
 * They are additive and descriptive: they mirror what is emitted, they do not change it.
 *
 * `metricKey` is the single storage metric today (`storage.bytes`, from
 * `apps/api/src/modules/files/usage-counters.repository.ts`). It is pinned as a `const` so a
 * second metric is a deliberate, reviewed schema change rather than a silent widening.
 */
import type { JsonObjectSchema } from './json-schema.js';

/** The storage metric every `usage.*` event carries today. */
export const STORAGE_BYTES_METRIC = 'storage.bytes';

/** §6's four storage threshold boundaries; mirrors `usage-thresholds.ts` `STORAGE_THRESHOLD_BANDS`. */
export const USAGE_THRESHOLD_BANDS = [70, 85, 95, 100] as const;

/** Why an upload session's reserved bytes were released; mirrors `releaseInTransaction`'s `cause`. */
export const USAGE_RELEASE_CAUSES = ['cancelled', 'expired', 'failed'] as const;
export type UsageReleaseCause = (typeof USAGE_RELEASE_CAUSES)[number];

// ── Payload types ────────────────────────────────────────────────────────────

/** `usage.storage_reserved.v1` — a reservation added `deltaBytes` to the reserved counter. */
export interface UsageStorageReservedPayload {
  readonly uploadSessionId: string;
  readonly metricKey: typeof STORAGE_BYTES_METRIC;
  readonly deltaBytes: number;
}

/** `usage.storage_committed.v1` — a completed upload retired a reservation and added used bytes. */
export interface UsageStorageCommittedPayload {
  readonly uploadSessionId: string;
  readonly fileVersionId: string;
  readonly metricKey: typeof STORAGE_BYTES_METRIC;
  readonly deltaBytes: number;
  readonly reservedBytes: number;
}

/** `usage.storage_released.v1` — a cancelled/expired/failed session gave its reserved bytes back. */
export interface UsageStorageReleasedPayload {
  readonly uploadSessionId: string;
  readonly metricKey: typeof STORAGE_BYTES_METRIC;
  readonly deltaBytes: number;
  readonly cause: UsageReleaseCause;
}

/** `usage.threshold_reached.v1` — usage crossed up into a threshold band. */
export interface UsageThresholdReachedPayload {
  readonly organizationId: string;
  readonly band: (typeof USAGE_THRESHOLD_BANDS)[number];
  readonly used: number;
  readonly reserved: number;
  readonly quota: number;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
}

// ── JSON representations ──────────────────────────────────────────────────────

const CONTRACTS_BASE = 'https://contracts.tmanage.example/events';

export const USAGE_STORAGE_RESERVED_V1_SCHEMA: JsonObjectSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `${CONTRACTS_BASE}/usage.storage_reserved.v1.schema.json`,
  title: 'usage.storage_reserved.v1 payload',
  type: 'object',
  required: ['uploadSessionId', 'metricKey', 'deltaBytes'],
  properties: {
    uploadSessionId: { type: 'string', format: 'uuid' },
    metricKey: { type: 'string', const: STORAGE_BYTES_METRIC },
    deltaBytes: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
};

export const USAGE_STORAGE_COMMITTED_V1_SCHEMA: JsonObjectSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `${CONTRACTS_BASE}/usage.storage_committed.v1.schema.json`,
  title: 'usage.storage_committed.v1 payload',
  type: 'object',
  required: ['uploadSessionId', 'fileVersionId', 'metricKey', 'deltaBytes', 'reservedBytes'],
  properties: {
    uploadSessionId: { type: 'string', format: 'uuid' },
    fileVersionId: { type: 'string', format: 'uuid' },
    metricKey: { type: 'string', const: STORAGE_BYTES_METRIC },
    deltaBytes: { type: 'integer', minimum: 0 },
    reservedBytes: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
};

export const USAGE_STORAGE_RELEASED_V1_SCHEMA: JsonObjectSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `${CONTRACTS_BASE}/usage.storage_released.v1.schema.json`,
  title: 'usage.storage_released.v1 payload',
  type: 'object',
  required: ['uploadSessionId', 'metricKey', 'deltaBytes', 'cause'],
  properties: {
    uploadSessionId: { type: 'string', format: 'uuid' },
    metricKey: { type: 'string', const: STORAGE_BYTES_METRIC },
    deltaBytes: { type: 'integer', minimum: 0 },
    cause: { type: 'string', enum: USAGE_RELEASE_CAUSES },
  },
  additionalProperties: false,
};

export const USAGE_THRESHOLD_REACHED_V1_SCHEMA: JsonObjectSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `${CONTRACTS_BASE}/usage.threshold_reached.v1.schema.json`,
  title: 'usage.threshold_reached.v1 payload',
  type: 'object',
  required: ['organizationId', 'band', 'used', 'reserved', 'quota', 'idempotencyKey', 'occurredAt'],
  properties: {
    organizationId: { type: 'string', format: 'uuid' },
    band: { type: 'integer', enum: USAGE_THRESHOLD_BANDS },
    used: { type: 'integer', minimum: 0 },
    reserved: { type: 'integer', minimum: 0 },
    quota: { type: 'integer', minimum: 0 },
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 256 },
    occurredAt: { type: 'string', format: 'date-time' },
  },
  additionalProperties: false,
};
