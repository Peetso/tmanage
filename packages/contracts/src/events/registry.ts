/**
 * The versioned event-schema registry: event name → { version, schema }.
 *
 * It maps every `type` string the api/worker already know (e.g. `usage.storage_reserved.v1`)
 * to the pinned payload-schema version and its JSON representation. The `.vN` suffix in the
 * name and the `version` field are kept in step by {@link ../registry.test.ts}; adding a `v2`
 * is a new entry, never an edit to an existing one, so a consumer pinned to `v1` is never moved
 * underneath it.
 */
import type { JsonObjectSchema } from './json-schema.js';
import {
  USAGE_STORAGE_RESERVED_V1_SCHEMA,
  USAGE_STORAGE_COMMITTED_V1_SCHEMA,
  USAGE_STORAGE_RELEASED_V1_SCHEMA,
  USAGE_THRESHOLD_REACHED_V1_SCHEMA,
  type UsageStorageReservedPayload,
  type UsageStorageCommittedPayload,
  type UsageStorageReleasedPayload,
  type UsageThresholdReachedPayload,
} from './usage.js';

/** A registry entry: the pinned schema version and the JSON Schema that defines the payload. */
export interface VersionedEventSchema {
  readonly version: number;
  readonly schema: JsonObjectSchema;
}

/**
 * The registry itself. Keyed by the fully qualified event `type` (with its `.vN` suffix), so a
 * name and the version it resolves to cannot drift apart.
 */
export const EVENT_SCHEMA_REGISTRY = {
  'usage.storage_reserved.v1': { version: 1, schema: USAGE_STORAGE_RESERVED_V1_SCHEMA },
  'usage.storage_committed.v1': { version: 1, schema: USAGE_STORAGE_COMMITTED_V1_SCHEMA },
  'usage.storage_released.v1': { version: 1, schema: USAGE_STORAGE_RELEASED_V1_SCHEMA },
  'usage.threshold_reached.v1': { version: 1, schema: USAGE_THRESHOLD_REACHED_V1_SCHEMA },
} as const satisfies Record<string, VersionedEventSchema>;

/** Every registered event `type` string. */
export type RegisteredEventType = keyof typeof EVENT_SCHEMA_REGISTRY;

/** The payload type each registered event name carries. */
export interface EventPayloadMap {
  'usage.storage_reserved.v1': UsageStorageReservedPayload;
  'usage.storage_committed.v1': UsageStorageCommittedPayload;
  'usage.storage_released.v1': UsageStorageReleasedPayload;
  'usage.threshold_reached.v1': UsageThresholdReachedPayload;
}

/** The registered event names, as a value — the keys of {@link EVENT_SCHEMA_REGISTRY}. */
export const REGISTERED_EVENT_TYPES = Object.keys(
  EVENT_SCHEMA_REGISTRY,
) as readonly RegisteredEventType[];

/** Type guard: is `type` an event name the registry knows? */
export function isRegisteredEventType(type: string): type is RegisteredEventType {
  return Object.prototype.hasOwnProperty.call(EVENT_SCHEMA_REGISTRY, type);
}

/** The registry entry for a known event name. */
export function getEventSchema(type: RegisteredEventType): VersionedEventSchema {
  return EVENT_SCHEMA_REGISTRY[type];
}
