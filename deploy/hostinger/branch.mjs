// Write the built Hostinger bundle into a LOCAL build-only branch `hostinger-dist`, for the
// case where hPanel's "Create site → Web app" offers only a Git import and no ZIP upload.
//
// It commits the unpacked bundle (the same contents as the zip) as a single parentless commit
// on `hostinger-dist`, using git plumbing with a throwaway index so the real working tree, the
// real index, and HEAD are never touched. It does NOT push — Peter or the manager decides that,
// and master is never deployed. Run:  pnpm deploy:hostinger:branch
//
// Note on `npm install`: the branch keeps real dependencies (private @tmanage packages travel
// as file: links; the rest are registry deps) because @node-rs/argon2 and Next's swc are native
// and must be built for Hostinger's Linux by the install that runs there — a committed Windows
// node_modules would not run. There is no build step to run, only that dependency install.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const STAGE = join(HERE, 'out', 'stage');
const BRANCH = 'hostinger-dist';

function git(args, env = {}) {
  return execFileSync('git', args, {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trim();
}

if (!existsSync(join(STAGE, 'server.mjs'))) {
  process.stdout.write('No built bundle found — running the build first.\n');
  execFileSync('node', [join(HERE, 'build.mjs')], { cwd: REPO, stdio: 'inherit' });
}

// A throwaway index so nothing about the real checkout changes. --force because the bundle lives
// under the gitignored out/ and contains dist/ directories the repo's .gitignore would skip.
const indexFile = join(mkdtempSync(join(tmpdir(), 'tmanage-dist-')), 'index');
const env = { GIT_DIR: join(REPO, '.git'), GIT_WORK_TREE: STAGE, GIT_INDEX_FILE: indexFile };
try {
  git(['read-tree', '--empty'], env);
  git(['add', '-A', '--force'], env);
  const tree = git(['write-tree'], env);
  const stamp = new Date().toISOString();
  const commit = git(['commit-tree', tree, '-m', `build(hostinger): bundle ${stamp}`], env);
  git(['update-ref', `refs/heads/${BRANCH}`, commit], env);
  process.stdout.write(
    `\nBranch ${BRANCH} updated locally (commit ${commit.slice(0, 12)}), NOT pushed.\n` +
      `  Review:  git log --stat ${BRANCH} -1\n` +
      `  Push (only if you decide to):  git push -f origin ${BRANCH}\n`,
  );
} finally {
  rmSync(dirname(indexFile), { recursive: true, force: true });
}
