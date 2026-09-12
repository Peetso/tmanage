<!--
Paragraph for docs/implementation-status.md. Written here, not into that file,
because several branches are open against it at once and this change should not
be the one that causes the merge conflict it exists to prevent. Move it into
docs/implementation-status.md when this branch is integrated.
-->

## Line endings are decided by `.gitattributes`, not by whatever `core.autocrlf` a checkout has

**Finding** (measured on this machine on 2026-09-12, not theorised). Every checkout of this
repository here carries `core.autocrlf=true`, while `.prettierrc.json` sets
`"endOfLine": "lf"`. Nothing reconciled the two, and the cost was paid repeatedly and by
different agents: a clean `git merge` wrote its merged files back out as CRLF, so
`pnpm format:check` failed immediately after the merge on files nobody had edited, and two
separate merge runs had to repair them by hand with `git show :<path> > <path>`; a fresh
`git worktree add` off `master` came out with every tracked text file CRLF in the working
tree — 671 of them, confirmed by `git ls-files --eol` in `tmanage-x4` before this change — so
the format gate was red before any work started, and one run converted all of them to LF just
to get a readable signal; the main checkout reported roughly 84 files as modified whose
content is byte-identical to the index, with `git diff` and `git diff --ignore-all-space` both
empty, which left `git status` there with almost no signal; and reports had acquired a
standing "whole-repo `format:check` fails at base, not my doing" exception, which is precisely
the kind of note that hides a real failure when one finally appears.

**What was added** (branch `x4-gitattributes-lf`, one commit). A root `.gitattributes`. Its
baseline is `* text=auto eol=lf`: `text=auto` leaves the text-versus-binary decision to Git's
content heuristic (binary if a NUL byte appears in the first 8000 bytes) and `eol=lf` pins the
working-tree ending for everything judged text, overriding `core.autocrlf` and `core.eol`.
Since Git 2.10 `eol` no longer defeats that detection, so binaries survive the baseline line;
Git here is 2.53.0.windows.1. What the baseline does **not** do is why the rest of the file
exists: it does not renormalise history or an existing working tree, it does not add a missing
final newline, it does not touch trailing whitespace, and it says nothing about how binaries
are diffed or merged. So every binary format actually present was enumerated from
`git ls-files` rather than left to the heuristic — 108 `.png` (largely the Storybook
visual-regression baselines, where one converted byte fails every shot), 24 `.ttf`, 12
`.woff2`, 12 `.woff`, 12 `.eot`, 10 `.otf`, 3 `.webp`, 3 `.jpg`, and
`docs/design/source/project/.thumbnail`, which is a WebP file whose name is nothing but an
extension — and each is marked with Git's `binary` macro (`-text -diff -merge`). There is no
`.ico`, no PDF and no archive tracked today; those, and a short list of other formats a single
CRLF substitution corrupts, are listed anyway so nobody has to notice after the fact. There is
no `.bat` and no `.cmd` either, checked rather than assumed, so `*.bat`/`*.cmd text eol=crlf`
changes nothing today and protects the first one committed — `cmd.exe` mis-parses labels and
`GOTO` in a batch file with bare LF. `*.sh`/`*.bash` are pinned to LF for the same
forward-looking reason: with CRLF the kernel reads the shebang as `/usr/bin/env bash\r` and
fails with "bad interpreter". `pnpm-lock.yaml` is pinned explicitly because pnpm writes it with
LF and rewrites it wholesale when it finds CRLF, and because it is in `.prettierignore`, so the
format gate could never have caught that churn. `*.sql` is pinned explicitly too; it is safe to
do so because `apps/api/src/common/database/migrator.ts` already collapses `\r\n` to `\n`
before hashing, so no checksum already recorded in `schema_migrations` is invalidated by the
change. The immutable material under `docs/planning/` and `docs/design/source/` is left in the
LF baseline deliberately: every one of its blobs is already LF in the index, so an LF working
copy reproduces the committed bytes exactly and the CRLF working copy this machine produces
today does not — the change improves byte-fidelity there rather than threatening it.

**A `.gitattributes` does not renormalise a working tree that already exists.** Attributes act
at check-in and checkout, so an existing checkout keeps its CRLF files until Git writes them
again. Each checkout's owner must run the sequence below **once**, from its own root, after
this change reaches its branch. It is safe to run in any checkout, including the main one and
including one showing the phantom-dirty files, but only on a clean tree: step 2 discards
uncommitted work.

```sh
# 0. Guard. `git status` cannot be trusted here, so read the diffs instead.
#    If either of these prints anything, that is real work: commit it, or stash
#    it and remember that `pnpm format` rewrites CRLF files and a later
#    `git stash pop` then refuses — apply by hand with `git apply`.
git diff --stat
git diff --cached --stat

# 1. Re-hash every tracked file through the new attributes. Every text blob in
#    this repository is already LF, so this stages nothing. If it ever does
#    stage something, that file was committed with CRLF and the diff is worth
#    reading before it is committed.
git add --renormalize .
git status --porcelain     # expect: empty (or only untracked files)
git reset                  # drop the empty staging, keep the tree

# 2. Rewrite the working copies. This is the step that clears the CRLF, and the
#    step that clears the phantom-dirty entries with it, because it makes the
#    file on disk match what the filter would produce.
git rm --cached -r -q .
git reset --hard

# 3. Confirm. The first command should print only `w/lf` and `w/-text`.
git ls-files --eol | awk '{print $2}' | sort | uniq -c
pnpm format:check
```

No `git config` change is needed anywhere: `eol=lf` in `.gitattributes` overrides
`core.autocrlf`, so leaving it at `true` is now harmless. Worktrees created _after_ this change
is on their base branch need nothing at all — they check out LF from the start.

**Verification** (recorded in `C:/Users/Peter/Documents/ChatGPT/TManage/next-slices-2026-09-12/`,
each log ending with its exit code). Before the change, in `tmanage-x4`:
`git ls-files --eol` reported 671 text files as `i/lf w/crlf` and 185 binaries as `i/-text`, and
`prettier --check` on a five-file sample failed all five on line endings alone
(`x4-before-state.log`, `x4-prettier-sample-before.log`). `git add --renormalize .` with the new
file in place staged nothing, proving the commit changes no blob (`x4-renormalize-check.log`).
`git check-attr` over every tracked path resolves to 674 `text: set` and 185 `text: unset` with
no path left to the heuristic (`x4-attr-resolution.log`). A scratch clone taken with
`core.autocrlf=true` explicitly set, checked out at this branch, came out entirely LF and passed
`prettier --check` on the same sample, while the same clone checked out at `master` came out
entirely CRLF and failed it; the scratch directory was removed afterwards
(`x4-scratch-clone.log`).
