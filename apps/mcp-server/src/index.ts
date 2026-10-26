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
export { serverIdentity, SERVER_ICON_PATHS } from './server-identity.js';
export {
  registerCatalog,
  buildCatalogServer,
  wrapUntrusted,
  structuredToolResult,
  errorToolResult,
  UNTRUSTED_NOTE,
  CATALOG_SERVER_NAME,
  CATALOG_SERVER_VERSION,
} from './catalog.js';
export type {
  Catalog,
  CatalogProfile,
  CatalogTool,
  CatalogResource,
  CatalogPrompt,
  CatalogRuntime,
  ToolAnnotations,
  McpToolResult,
  RunResult,
  ResourceReadResult,
} from './catalog.js';
