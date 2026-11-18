// Module resolve hooks for loading the staged bundle locally (load-next-config.child.mjs).
//
// The stage holds no node_modules: Hostinger's `npm install` provides them, pinned to the exact
// versions the web workspace resolved (build.mjs `exactVersion`). So a package the staged code
// imports that the stage cannot resolve is resolved from the web workspace instead, which is the
// same version the bundle installs. Relative and absolute specifiers are never redirected, so a
// staged file that is missing still fails exactly as it would on the server.

/** @type {string} file URL of a file inside the web workspace, the fallback resolution parent */
let workspaceParentURL;

/** @param {{ workspaceParentURL: string }} data */
export function initialize(data) {
  workspaceParentURL = data.workspaceParentURL;
}

/** A bare package specifier (`next/constants.js`), as opposed to a path or URL. */
function isBareSpecifier(specifier) {
  return !/^(?:\.{0,2}\/|[a-z][a-z0-9+.-]*:)/i.test(specifier);
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !isBareSpecifier(specifier)) throw error;
    return nextResolve(specifier, { ...context, parentURL: workspaceParentURL });
  }
}
