# Putting TManage online at tmanage.peetrix.com (Hostinger)

A click-by-click guide for the site owner. You do not need to be technical. hPanel is Hostinger's
control panel. Its wording changes from time to time, so where this guide says **look for**
something, pick the nearest match on your screen.

What you need before you start:

- **The ZIP file** `tmanage-hostinger.zip` (the team builds it with `pnpm deploy:hostinger`; it is
  in `deploy/hostinger/out/`). This guide, `.env.example` and `generate-secret.mjs` are inside it.
- **About 30 minutes**, and a notepad to write down the database names and passwords you choose.

There are three parts: **Part 1** prepares the subdomain and the database, **Part 2** creates the
app and turns it on, **Part 3** covers updates, rollback, limits and a fallback.

---

## Part 1 — Prepare the subdomain and the database

Today `tmanage.peetrix.com` is a **PHP/HTML** website showing a placeholder page. It has to become
a **Web app (Node.js)** instead, the same type as `peetrix.com`.

1. **Back up the current files.** In hPanel open **Websites**, then **Manage** next to
   `tmanage.peetrix.com`, then **File manager** (look for it under _Files_). Select everything in
   the site's folder (usually `public_html`) and choose **Download** (or **Compress** first, then
   download the archive). Keep it on your computer. The placeholder page is not important, but it
   costs nothing to keep.
2. **Check whether the type can simply be changed.** Still in **Manage** for
   `tmanage.peetrix.com`, look for an option such as _Change website type_ or _Convert to Web
   app_. If there is one, use it, choose **Web app / Node.js**, and skip step 3.
3. **Otherwise remove the PHP/HTML site.** Go back to **Websites**, open the **⋮** (three dots)
   menu next to `tmanage.peetrix.com` and look for _Delete website_ / _Remove_.
   **This cannot be undone** — that is why you made the backup in step 1. Your domain
   `peetrix.com` and its own Web app are not touched by this.
4. **The database.** Hostinger gives the Web app **one** MySQL database with **one** user, and
   when the database is created as part of the Web app's setup, Hostinger **writes the connection
   settings into the app for you** (`DATABASE_URL` and `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`,
   `DB_PASSWORD`). You never type or see that password. So:
   - **Best:** create the database from the Web app's own screen (Part 2, step 6 — look for
     _Database_ in the app's settings). Nothing to write down.
   - **If you already created it** under **Databases → MySQL Databases**: note the full database
     name and user (Hostinger adds a prefix such as `u123456789_`) and the password you chose. You
     will type one setting yourself in Part 2 (`DATABASE_URL`).

   TManage normally prefers three separate database users (app, schema changes, background jobs).
   With Hostinger's one user it runs everything with that one user — see "Known limits".

---

## Part 2 — Create the Web app and turn it on

1. Go to **Websites** and click **Create site** (or _Add website_).
2. Choose **Web app** (look for _Node.js_).
3. When it offers to **connect GitHub, do not connect it.** Look for **Upload files** / _Upload
   your website files_ / _Upload ZIP_ instead, and choose `tmanage-hostinger.zip`.
   If you truly see no upload choice at all, stop here and read "GitHub-only fallback" at the end.
4. **Domain:** pick the existing subdomain `tmanage.peetrix.com`.
5. **Build settings** (look for _Framework_, _Node version_, _Entry file_ / _Start command_).
   Use exactly these values:

   | Setting                      | Value                                                      |
   | ---------------------------- | ---------------------------------------------------------- |
   | Framework / app type         | **Other** (if missing: **Express**) — never _Next.js_      |
   | Node version                 | **22**                                                     |
   | Root directory               | `./` (the top of the ZIP, where `server.mjs` is)           |
   | Output directory             | leave empty (or `./` if required)                          |
   | Package manager              | **npm**                                                    |
   | Build command / build script | `npm run build` (it only prints "prebuilt"; empty is fine) |
   | Entry file                   | `server.mjs` (if it asks for a start command: `npm start`) |

   Why "Other" and not "Next.js": the ZIP is already built, and one program serves both the pages
   and the API. A Next.js preset would try to build it again.

6. **Database, then environment variables.** If the app's settings offer **Database** (look for
   _Create database_ / _Connect database_), create the database there first — Hostinger then adds
   the database rows of the table below by itself. Then open **Environment variables** (on the
   same screen or under the app's settings). Add each row below. **Do not add `PORT`** — Hostinger sets it for you.

   | Name                                                                      | What it is                                  | Where to get it / what to type                                                                           |
   | ------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
   | `DATABASE_URL`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | The database connection                     | **Set automatically** by Hostinger's database setup — do not type or change them                         |
   | `NODE_ENV`                                                                | Tells the app it is live                    | `production` (if you leave it out the app uses production anyway; any other word stops it from starting) |
   | `API_PUBLIC_URL`                                                          | The site address                            | `https://tmanage.peetrix.com`                                                                            |
   | `WEB_PUBLIC_URL`                                                          | The same address                            | `https://tmanage.peetrix.com`                                                                            |
   | `CORS_ALLOWED_ORIGINS`                                                    | Which site may use the app                  | `https://tmanage.peetrix.com`                                                                            |
   | `TRUSTED_PROXY_ADDRESSES`                                                 | Hostinger's one proxy in front of the app   | `127.0.0.1,::1`                                                                                          |
   | `DATABASE_POOL_MAX`                                                       | How many database connections at once       | `5`                                                                                                      |
   | `SESSION_SECRET`                                                          | Protects sign-ins                           | a fresh secret (see below) — you enter it                                                                |
   | `CSRF_SECRET`                                                             | Protects forms — must differ from the above | another fresh secret — you enter it                                                                      |
   | `AUTH_MFA_SEED_KEYS`                                                      | Protects two-step sign-in codes             | a fresh `--mfa` secret (see below) — you enter it                                                        |
   | `SETUP_TOKEN`                                                             | Creates the first owner account, once       | a fresh secret from `node generate-secret.mjs` — add it only for the first setup, then delete it         |
   | `AUTH_TOTP_ISSUER`                                                        | Name shown in authenticator apps            | `TManage`                                                                                                |
   | `EMAIL_DRIVER`                                                            | How email is sent                           | `smtp`                                                                                                   |
   | `EMAIL_FROM_ADDRESS`                                                      | The sender address                          | a mailbox you own, e.g. `no-reply@peetrix.com`                                                           |
   | `EMAIL_FROM_NAME`                                                         | The sender name                             | `TManage`                                                                                                |
   | `SMTP_HOST`                                                               | Mail server                                 | hPanel **Emails** → your mailbox → look for _SMTP_ (often `smtp.hostinger.com`)                          |
   | `SMTP_PORT` / `SMTP_SECURE`                                               | Mail port and encryption                    | `465` and `true` (or `587` and `false`)                                                                  |
   | `SMTP_USERNAME`                                                           | Mail login                                  | the full mailbox address                                                                                 |
   | `SMTP_PASSWORD`                                                           | Mail password                               | the mailbox password — type it yourself                                                                  |
   | `STORAGE_DRIVER`                                                          | Where uploaded files go                     | `local` (files on the server's own disk, in a private folder; see limits)                                |
   | `STORAGE_LOCAL_ROOT`                                                      | The private folder for uploaded files       | the full path of the folder you created, e.g. `/home/<your-user>/tmanage-storage`                        |
   | `STORAGE_LOCAL_SIGNING_SECRET`                                            | Protects file upload and download links     | a fresh secret of its own (see below) — not the same as the other two                                    |
   | `STORAGE_BUCKET`                                                          | Not used with `local`, but required         | `unused-local`                                                                                           |
   | `MALWARE_SCAN_DRIVER`                                                     | Virus scanning of uploads                   | `none`                                                                                                   |
   | `WORKER_INPROCESS`                                                        | Run background jobs (emails) inside the app | `1`                                                                                                      |
   | `QUEUE_DRIVER`, `CACHE_DRIVER`                                            | Internal settings                           | `redis` for both (nothing is installed or contacted; they just must not be `memory`)                     |

   **Only if you created the database by hand** (Part 1, step 4, second case) and Hostinger did not
   add the database rows: add `DATABASE_URL` yourself as
   `mysql://USER:PASSWORD@127.0.0.1:3306/DBNAME` with the full prefixed names, and type the password
   yourself. Use `127.0.0.1`, not `localhost` (the app also corrects `localhost` by itself). If the
   password has symbols such as `@ : / ? #`, choose one without them for this database.

   There are **no `NEXT_PUBLIC_…` settings** to add: they are fixed inside the ZIP when the team
   builds it. Changing any setting here simply restarts the app; nothing needs rebuilding.

   **Fresh secrets:** the four secret rows need long random values that only you hold. On any
   computer with Node.js, open a terminal in the unzipped folder and run `node generate-secret.mjs`
   (once for `SESSION_SECRET`, again for `CSRF_SECRET`, and a third time for
   `STORAGE_LOCAL_SIGNING_SECRET` — three different values) and `node generate-secret.mjs --mfa`
   (for `AUTH_MFA_SEED_KEYS`). `SETUP_TOKEN` is only needed once, for step 10 below; you can add it
   now or then. If you do not have Node.js, ask the team to run it and send you the values
   privately. Paste them only into hPanel; keep no copy in the project.

7. **Deploy / Start.** Click **Deploy** (or **Save** then **Start**). Hostinger installs the
   libraries (a few minutes), then starts the app. On its first start the app creates its own
   database tables — you never run anything by hand. Every later start checks and does nothing if
   the tables are already up to date.
8. **Turn on SSL.** In **Websites → Manage** for `tmanage.peetrix.com`, open **Security → SSL**
   and make sure a certificate is **Active** (install the free one if not). The app needs https:
   its sign-in cookies only work over a secure connection.
9. **Check it works:**
   - `https://tmanage.peetrix.com/healthz` shows `{"status":"ok"}`.
   - `https://tmanage.peetrix.com/` shows the TManage page.
   - `https://tmanage.peetrix.com/sign-in` shows the sign-in form.
   - If something fails, open the app's **Logs** (look for _Runtime logs_ / _Deployments_). The
     app writes plain messages such as the name of a missing or mistyped setting. Fix it in
     **Environment variables** and **Restart**.
   - If the log mentions **"SUPER privilege" and "binary logging"** on the first start, the MySQL
     server needs `log_bin_trust_function_creators` enabled. Ask Hostinger support to enable it for
     your database, then **Restart**.
10. **Create the first owner account.** There is **no public sign-up**: nobody can create an
    account from the sign-in page. The very first owner is made once, with a one-time setup page;
    everyone else joins later by invitation from inside the app.
    1. On your computer, in the unzipped folder, run `node generate-secret.mjs` once more. The line
       it prints is your setup token.
    2. In hPanel, open the app's **Environment variables**, add `SETUP_TOKEN` with that value, and
       **Restart** the app.
    3. Open `https://tmanage.peetrix.com/setup`. Paste the token, then fill in your name, email,
       password, organization name and workspace address, and press **Create owner account**. You
       are signed in straight away.
    4. Back in **Environment variables**, **delete `SETUP_TOKEN`** and **Restart**. The setup page
       then says setup is not available. It also closes by itself as soon as an organization
       exists, so it can never be used a second time.

    If something goes wrong on the setup page:
    - **"Setup is not available"**: `SETUP_TOKEN` is not set (or the app was not restarted after
      adding it), or an organization already exists.
    - **"That setup token is not correct"**: copy and paste the token again, without spaces before
      or after it.
    - **"Too many attempts"**: wait 10 minutes, then try again.

---

## Part 3 — Updates, rollback, limits, fallback

### Updating to a new version

1. Get the new `tmanage-hostinger.zip` from the team. **Keep the previous ZIP** — it is your
   rollback.
2. In the Web app's page, look for **Deployments** / **Redeploy** / **Upload new files** and
   upload the new ZIP. (If there is no such button: **File manager**, delete the app's old files,
   upload and **Extract** the new ZIP in the same folder, then **Restart**.)
3. Your environment variables stay as they are. The app updates its own tables on start.

### Rolling back

Upload the **previous** ZIP the same way and Restart. Database changes only move forward, so a
code rollback is safe when the older version expects the same tables. Before rolling back across
an update the team said changed the database, ask the team first.

### Known limits (please read)

- **Built-in safety checks.** The app only starts as a live (production) site, and refuses to
  start if `NODE_ENV` says anything else. The password-free "developer sign-in" used for testing
  does not exist in this bundle. The contact form accepts a few messages per visitor every ten
  minutes. Pages are sent with HTTPS-only (HSTS) and a content-security policy in "report only"
  mode, which warns but blocks nothing yet.

- **One database user for everything.** TManage is designed to use three database users (the app,
  schema changes, background jobs) so a mistake in one cannot reach the others. Hostinger shared
  hosting gives one user, so the app runs all three jobs with it and writes "single-user mode" in
  its log. Everything works; the extra safety layer of separate users is simply not available on
  this plan. On a host with separate users, set `DATABASE_MIGRATION_URL` and `WORKER_DATABASE_URL`
  and the app keeps them apart again.

- **Uploaded files live on the server's own disk, in a private folder.** Shared hosting has no
  file-storage service, so with `STORAGE_DRIVER=local` the app keeps files in a folder of your
  account that is outside `public_html`. Nobody can open these files by typing a web address: they
  can only be downloaded through the signed-in app, with the same permission checks as everything
  else, and every upload or download link expires after a short time. The app refuses to start
  if `STORAGE_LOCAL_ROOT` is not a full path (starting with `/`) or points inside `public_html` or
  any other web folder.
  - **Create the folder once, before the first start.** In hPanel open **Files → File Manager**,
    go one level **above** `public_html` (your home folder, e.g. `/home/<your-user>`), create a
    folder named `tmanage-storage`, and put its full path in `STORAGE_LOCAL_ROOT`.
  - **Back it up.** These files exist only in that folder. Hostinger's backups of your home folder
    include it; check that they are switched on, and download a copy of the folder from time to
    time as well.
  - **It uses your plan's disk space.** Every uploaded file counts against the hosting plan's disk
    quota. Each organization is also capped by `STORAGE_ORG_BYTES_LIMIT_BYTES` (500 MB unless you
    change it).
  - **Switching to a bucket later is possible.** An S3-compatible bucket (AWS S3, Cloudflare R2)
    can replace the folder later by changing the `STORAGE_*` settings (see `.env.example`). Files
    already in the folder are not moved by that switch; moving them is a separate later step.
- **Background jobs pause while the app sleeps.** With `WORKER_INPROCESS=1` the app sends emails
  and notifications itself, on a timer. If Hostinger pauses the app when nobody visits, the timer
  pauses too, and waiting emails go out on the next visit.
- **One app, one address.** The web pages and the API run as one program on
  `tmanage.peetrix.com`. Only that one address is set up.
- **No virus scanning** of uploaded files on this plan (`MALWARE_SCAN_DRIVER=none`).
- **Hostinger limits** on memory and processes apply. If the app restarts by itself under load,
  that is the plan's limit; the logs will show it.

### GitHub-only fallback (only if the flow truly offers no ZIP upload)

1. The team runs `pnpm deploy:hostinger:branch`. It writes the ready-built app into a branch named
   `hostinger-dist`, on the team's computer only. It does not upload anything and never touches
   `master`.
2. The team pushes that one branch, only after you agree.
3. In the Web app flow, connect GitHub, pick the repository and the **`hostinger-dist`** branch
   (never `master`), with the same build settings as Part 2 step 5 (app type Other, Node 22, root
   `./`, npm, build `npm run build`, entry `server.mjs`), then the same database, environment
   variables, SSL and checks as in Part 2.

The ZIP upload is the recommended path; use this only if you must.
