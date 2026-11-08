/**
 * The Trusted Types `default` policy (56-01, r47 L2) — the first inline `<head>` script of every
 * page (`lib/boot-scripts.ts`), so it is in place before any chunk can touch a DOM sink.
 *
 * The page policy says `require-trusted-types-for 'script'` (`lib/csp.ts`): every plain string that
 * reaches a script-capable sink goes through this policy, and a `null` answer blocks it (enforce)
 * or reports it (report-only). What it lets through, sink by sink:
 *
 *  - HTML (`innerHTML`, `outerHTML`, `insertAdjacentHTML`, `createContextualFragment`,
 *    `document.write`): markup that cannot run script — no `<script>`, `<iframe>`, `<object>`,
 *    `<embed>`, no `on…=` handler inside a tag, no `javascript:`, no `srcdoc`. Text, `""` (the
 *    usual "clear this node") and styled markup (wavesurfer's shadow template) pass. Exactly
 *    `<script></script>` passes too: React's own scaffold for creating a script element, which
 *    never runs. `DOMParser.parseFromString` passes whole: it builds an inert document (the
 *    Basecamp import in `lib/import-sources.ts`, the OOXML previews read XML through it).
 *  - Script URLs (`script.src`, `new Worker`, `serviceWorker.register`): this origin (Turbopack's
 *    chunks, `/sw.js`, same-origin `blob:`) and the Google Picker loader. Nothing else.
 *  - Script text (`eval`, `new Function`, `script.text`): only the text of an inline script the
 *    page already carries (a client re-render of these boot scripts); in development everything,
 *    because React's dev build rebuilds stacks with `eval` (`'unsafe-eval'` is dev-only too).
 *
 * The text below is plain ES5 and self-contained, takes the window as its argument (so the unit
 * test runs the very same string against a stand-in window), and does nothing in a browser without
 * `trustedTypes` or when a default policy already exists. Its SHA-256 is computed from this
 * function by `src/proxy.ts` and read from the built HTML for prerendered pages — never copied.
 */

/** Script URLs allowed from another origin: the Google Picker loader (`lib/google-picker.ts`). */
export const TRUSTED_SCRIPT_URL_PREFIXES = ['https://apis.google.com/js/'] as const;

export function trustedTypesBootScript(development: boolean): string {
  const data = JSON.stringify({ u: TRUSTED_SCRIPT_URL_PREFIXES, d: development }).replace(
    /</g,
    '\\u003c',
  );
  return (
    '(function(w,c){try{var t=w.trustedTypes;' +
    'if(!t||typeof t.createPolicy!=="function"||t.defaultPolicy)return;' +
    'var bad=/<\\s*\\/?\\s*(script|iframe|object|embed|frame|frameset)\\b|<[^>]*\\son[a-z]+\\s*=|javascript\\s*:|srcdoc/i;' +
    'function inline(v){var s=w.document.scripts;' +
    'for(var i=0;i<s.length;i++){if(!s[i].src&&s[i].text===v)return true;}return false;}' +
    't.createPolicy("default",{' +
    'createHTML:function(v,_t,k){v=String(v);' +
    'if(typeof k==="string"&&k.indexOf("parseFromString")>-1)return v;' +
    // React's scaffold, spelled with `\u003c` so this inline script never holds a closing tag.
    'if(v==="\\u003cscript>\\u003c/script>"||!bad.test(v))return v;return null;},' +
    'createScriptURL:function(v){v=String(v);try{var u=new w.URL(v,w.location.href);' +
    'if(u.origin===w.location.origin)return v;' +
    'for(var i=0;i<c.u.length;i++){if(u.href.indexOf(c.u[i])===0)return v;}}catch(e){}return null;},' +
    'createScript:function(v){v=String(v);return c.d||inline(v)?v:null;}' +
    '});}catch(e){}})(window,' +
    data +
    ');'
  );
}
