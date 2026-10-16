/**
 * @tmanage/contracts — versioned event schemas and shared contract types (R12).
 *
 * The first real step of R12: event payload schemas hosted under `packages/` rather than
 * `docs/planning/contracts/events/`, so build lanes may author and version them. The schemas
 * describe payloads the api/worker already emit; they are additive and do not change what is
 * emitted. OpenAPI/DTO codegen is a later, separate decision (see the build INDEX).
 */
export * from './events/index.js';
