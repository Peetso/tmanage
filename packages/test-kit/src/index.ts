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
