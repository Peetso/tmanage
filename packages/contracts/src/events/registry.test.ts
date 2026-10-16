import { describe, it, expect } from 'vitest';
import {
  REGISTERED_EVENT_TYPES,
  isRegisteredEventType,
  getEventSchema,
  type RegisteredEventType,
} from './registry.js';
import { STORAGE_BYTES_METRIC, type UsageStorageReservedPayload } from './usage.js';

describe('EVENT_SCHEMA_REGISTRY', () => {
  it('resolves every registered name to a schema with a pinned version', () => {
    expect(REGISTERED_EVENT_TYPES.length).toBeGreaterThan(0);
    for (const type of REGISTERED_EVENT_TYPES) {
      const entry = getEventSchema(type);
      expect(Number.isInteger(entry.version)).toBe(true);
      expect(entry.version).toBeGreaterThanOrEqual(1);
      expect(entry.schema.type).toBe('object');
      expect(entry.schema.required.length).toBeGreaterThan(0);
      // The schema's declared properties must cover everything it marks required.
      for (const key of entry.schema.required) {
        expect(Object.keys(entry.schema.properties)).toContain(key);
      }
    }
  });

  it("keeps the name's .vN suffix in step with the pinned version", () => {
    for (const type of REGISTERED_EVENT_TYPES) {
      const suffix = type.match(/\.v(\d+)$/);
      expect(suffix, `${type} is not a .vN event name`).not.toBeNull();
      expect(getEventSchema(type).version).toBe(Number(suffix?.[1]));
    }
  });

  it('exposes a type guard that agrees with the registry keys', () => {
    for (const type of REGISTERED_EVENT_TYPES) {
      expect(isRegisteredEventType(type)).toBe(true);
    }
    expect(isRegisteredEventType('usage.storage_reserved.v2')).toBe(false);
    expect(isRegisteredEventType('not.an.event')).toBe(false);
  });

  it('shape-checks a representative payload against its schema (storage_reserved.v1)', () => {
    const type: RegisteredEventType = 'usage.storage_reserved.v1';
    const schema = getEventSchema(type).schema;

    // A valid payload the api would emit, typed to the exported payload type.
    const payload: UsageStorageReservedPayload = {
      uploadSessionId: '11111111-1111-4111-8111-111111111111',
      metricKey: STORAGE_BYTES_METRIC,
      deltaBytes: 4096,
    };

    // Every required field is present…
    for (const key of schema.required) {
      expect(payload).toHaveProperty(key);
    }
    // …and the payload introduces no field the schema does not declare (additionalProperties: false).
    expect(schema.additionalProperties).toBe(false);
    for (const key of Object.keys(payload)) {
      expect(Object.keys(schema.properties)).toContain(key);
    }
    // The pinned const value is the one the api sends.
    expect(schema.properties.metricKey?.const).toBe(payload.metricKey);
  });
});
