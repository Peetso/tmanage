/**
 * @tmanage/test-kit — synthetic data for suites, and nothing else.
 *
 * `18-REPOSITORY-STRUCTURE`: "test-kit contains synthetic data only." No driver, no SQL,
 * no fixtures that reach a network. A suite imports shapes and inserts them itself.
 */

export {
  SYNTHETIC_AUDIENCES,
  SYNTHETIC_WORK_STATES,
  syntheticWorkItemRows,
} from './work-volume.js';
export type { SyntheticWorkItemRow, SyntheticWorkVolumeInput } from './work-volume.js';

/**
 * The hand-written restatement of `12-PERMISSION-MATRIX.md` §2. Synthetic in the same sense
 * as the rest of this package: a literal the suites read, produced by a human rather than by
 * the code under test. See `permission-matrix.ts` for why it exists and how to edit it.
 */
export {
  ACCEPTED_CEILING_DIVERGENCES,
  PERMISSION_MATRIX,
  expectedCeilingFor,
  expectedCeilingGrants,
} from './permission-matrix.js';
export type { CeilingDivergence, RolePermissionRow } from './permission-matrix.js';

/**
 * The generated role × operation grid for TEST-001's §11 harness. Built from the domain's real
 * capability and role tables, so a newly declared capability with no operation fails loudly
 * rather than going untested. See `role-operation-grid.ts` for the design and why each cell's
 * verdict comes from the transcription above rather than the live ceiling.
 */
export {
  GRID_ROLES,
  GUARDED_OPERATIONS,
  UNGUARDED_CAPABILITIES,
  assertCatalogCoversEveryCapability,
  buildRoleOperationGrid,
  expectedGuardDenialCount,
} from './role-operation-grid.js';
export type {
  GuardedOperation,
  HttpMethod,
  OperationSurface,
  RoleOperationCell,
  UnguardedCapability,
} from './role-operation-grid.js';
