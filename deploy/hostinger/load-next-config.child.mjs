// Load a staged next.config.mjs the way the bundle's `next start` does, and print the resolved
// configuration as JSON on stdout. Run by build.mjs `loadStagedNextConfig` with the staged web
// directory as the working directory and the web child's environment; never imported.
//
// Usage: node load-next-config.child.mjs <web workspace dir>
//
// `next start` imports next.config.mjs from its working directory and, when the default export is
// a function, calls it with the production-server phase. Anything that throws there (a source
// file the bundle does not ship, a public-config value that does not validate) is what crash-loops
// the web child, so this exits non-zero with the error on stderr.
import { createRequire, register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const workspaceDir = process.argv[2];
if (!workspaceDir) throw new Error('usage: load-next-config.child.mjs <web workspace dir>');
const workspaceManifest = join(workspaceDir, 'package.json');

register('./workspace-resolve.hooks.mjs', import.meta.url, {
  data: { workspaceParentURL: pathToFileURL(workspaceManifest).href },
});

const { PHASE_PRODUCTION_SERVER } = createRequire(workspaceManifest)('next/constants.js');
const { default: exported } = await import(
  pathToFileURL(join(process.cwd(), 'next.config.mjs')).href
);
const config =
  typeof exported === 'function'
    ? await exported(PHASE_PRODUCTION_SERVER, { defaultConfig: {} })
    : exported;

// The route rules are functions; `next start` calls them while it boots, so they are resolved too.
const resolved = { ...config };
for (const key of ['redirects', 'rewrites', 'headers']) {
  if (typeof config[key] === 'function') resolved[key] = await config[key]();
}
process.stdout.write(JSON.stringify(resolved));
