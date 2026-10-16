/**
 * A deliberately small JSON Schema shape — enough to express the flat event payloads
 * this package hosts and to be the JSON representation of each schema, without pulling in
 * a schema library (R12 foundation, not a codegen/validation pipeline).
 *
 * It is a structural type, not a validator: the registry's own invariants are asserted in
 * {@link ../registry.test.ts}, and runtime validation against these objects belongs to
 * whatever consumer (api/worker) later adopts them — those consumers already emit the
 * payloads, so these schemas describe what is emitted rather than gate it.
 */

/** A scalar JSON Schema `type` token, or a two-member nullable union as used in the envelope. */
export type JsonSchemaType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null'
  | readonly JsonSchemaType[];

/** One property's schema. Only the keywords the payloads here actually use are modelled. */
export interface JsonSchemaProperty {
  readonly type?: JsonSchemaType;
  readonly format?: string;
  readonly const?: string | number | boolean;
  readonly enum?: readonly (string | number)[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly items?: JsonSchemaProperty;
  readonly description?: string;
}

/** An object JSON Schema with explicit `required`, `properties`, and `additionalProperties`. */
export interface JsonObjectSchema {
  readonly $schema?: string;
  readonly $id?: string;
  readonly title?: string;
  readonly type: 'object';
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, JsonSchemaProperty>>;
  readonly additionalProperties: boolean;
}
