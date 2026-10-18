/** Public surface of `@tmanage/mcp-server`, re-exported for tests and embedders. */
export { loadConfig, ConfigError } from './config.js';
export type { McpServerConfig, McpTransport } from './config.js';
export { createHttpApiClient, ApiError } from './api-client.js';
export type {
  TManageApiClient,
  OrganizationSummary,
  SearchResult,
  WorkItem,
  MyDayEntry,
  InboxItem,
  Project,
  TManageDocument,
  WorkComment,
  CreateWorkItemInput,
} from './api-client.js';
export { registerTools } from './tools.js';
export { buildServer, buildServerForToken, SERVER_NAME, SERVER_VERSION } from './server.js';
export { createHttpHandler, runHttp, serveMcpRequest } from './transports/http.js';
export { runStdio } from './transports/stdio.js';
