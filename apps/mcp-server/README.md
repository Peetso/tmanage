# @tmanage/mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io) server for TManage. It lets
**Claude Desktop**, **Claude Code**, **ChatGPT** (developer-mode connectors) or any
MCP-capable assistant work in a TManage workspace — search, review your work, read and create
work items, comment, and list projects — **without any paid AI model**. The assistant you
already use connects to TManage and does the work.

It talks to TManage only over the existing HTTP API (never to the database), authenticated with
a **personal access token** you create in TManage. A token acts with your own permissions and
nothing more, and you can revoke it at any time.

## What it can do

| Tool                 | What it does                                                     |
| -------------------- | ---------------------------------------------------------------- |
| `list_organizations` | List the workspaces your token can act in (and the slug to use). |
| `search_workspace`   | Full-text search across work items, documents and meetings.      |
| `list_my_work`       | Your work for today — overdue, due soon, assigned.               |
| `list_inbox`         | Your inbox: what changed and needs attention.                    |
| `get_work_item`      | Fetch one work item by id.                                       |
| `get_project`        | Fetch one project by id, with its status.                        |
| `get_document`       | Fetch one document by id, with its body.                         |
| `list_projects`      | List projects and their status.                                  |
| `create_work_item`   | Create a work item in a project.                                 |
| `add_comment`        | Comment on a work item.                                          |

Every call is checked by TManage's own permission rules — the server can only ever do what the
token's member is allowed to do.

## 1. Create a personal access token

In TManage, open **Preferences → Security → Personal access tokens**, click **Create token**,
give it a name (e.g. "Claude Desktop on my laptop"), optionally set an expiry, and copy the
token. **It is shown once** — paste it straight into the config below. If you lose it, revoke it
and make a new one.

## 2. Configure your assistant

**Hosted (recommended): nothing to install.** The TManage API serves these same tools at
`https://<your TManage host>/mcp` (Streamable HTTP, stateless). Connect with your token as an
`Authorization: Bearer <token>` header, for example
`claude mcp add --transport http tmanage https://<host>/mcp --header "Authorization: Bearer <token>"`.
Every tool call runs through the API's own authentication, tenant and permission checks, and each
token is rate limited. The AI assistant page in TManage shows the exact steps for each assistant.

**Local stdio bridge, downloaded from TManage.** For a client that only speaks stdio and cannot
reach the hosted endpoint, run this package as a local bridge straight from your TManage host — no
npm account and nothing to clone:

```
TMANAGE_API_URL=https://<host> TMANAGE_TOKEN=<token> \
  npx -y https://<host>/downloads/tmanage-mcp.tgz
```

It runs over stdio (the default transport) and talks to the same HTTP API with your token. On the
single-app (Hostinger) deployment the API answers `/v1` at the site root, so `TMANAGE_API_URL` is
the site address itself. The tarball is `pnpm pack` of this package; the deploy build
(`deploy/hostinger/build.mjs`) ships it in the bundle as `downloads/tmanage-mcp.tgz` (with
`downloads/tmanage-mcp.tgz.sha256`), and the API serves that file with no setting needed.
`TMANAGE_MCP_BRIDGE_PATH` overrides the path on other layouts; with no tarball the route answers
`503` rather than serving a missing file.

**OpenAPI / GPT Actions.** Clients that call an OpenAPI tool instead of MCP read
`https://<host>/openapi/ai.json` (generated from the same action registry) and call the REST API
with the same personal access token. Confirm-class actions return an approval link to open in
TManage rather than running from the call.

**Self-run (below):** the server needs two environment variables:

- `TMANAGE_API_URL` — your TManage API base URL, e.g. `https://app.yourdomain.com/api`
- `TMANAGE_TOKEN` — the token you just created

Optional:

- `TMANAGE_ORG_SLUG` — pin one workspace (otherwise the token's first workspace is used)
- `TMANAGE_MCP_TRANSPORT` — `stdio` (default) or `http`
- `TMANAGE_MCP_HTTP_PORT` / `TMANAGE_MCP_HTTP_HOST` — for the `http` transport (default `127.0.0.1:8787`)
- `TMANAGE_MCP_ALLOWED_HOSTS` — for the `http` transport: extra `Host` header values to accept
  (comma list, e.g. `mcp.yourdomain.com` behind your HTTPS front door). Any other `Host` is
  refused `403`, which blocks DNS-rebinding attacks.

Build it once (from the repo root): `pnpm --filter @tmanage/mcp-server build`. That produces
`apps/mcp-server/dist/main.js`.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "tmanage": {
      "command": "node",
      "args": ["/absolute/path/to/tmanage/apps/mcp-server/dist/main.js"],
      "env": {
        "TMANAGE_API_URL": "https://app.yourdomain.com/api",
        "TMANAGE_TOKEN": "tmanage_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

Restart Claude Desktop. The TManage tools appear under the tools (plug) icon.

### Claude Code

From the repo root (or anywhere), register the server:

```bash
claude mcp add tmanage \
  --env TMANAGE_API_URL=https://app.yourdomain.com/api \
  --env TMANAGE_TOKEN=tmanage_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  -- node /absolute/path/to/tmanage/apps/mcp-server/dist/main.js
```

Or add it by hand to `.mcp.json`:

```json
{
  "mcpServers": {
    "tmanage": {
      "command": "node",
      "args": ["/absolute/path/to/tmanage/apps/mcp-server/dist/main.js"],
      "env": {
        "TMANAGE_API_URL": "https://app.yourdomain.com/api",
        "TMANAGE_TOKEN": "tmanage_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

### ChatGPT (developer-mode connectors)

ChatGPT connects to a **remote** MCP server over Streamable HTTP, so run the server in `http`
mode where ChatGPT can reach it (behind HTTPS in production):

```bash
TMANAGE_API_URL=https://app.yourdomain.com/api \
TMANAGE_MCP_TRANSPORT=http \
TMANAGE_MCP_HTTP_HOST=0.0.0.0 \
TMANAGE_MCP_HTTP_PORT=8787 \
TMANAGE_MCP_ALLOWED_HOSTS=mcp.yourdomain.com \
node /absolute/path/to/tmanage/apps/mcp-server/dist/main.js
```

The MCP endpoint is `http://<host>:8787/mcp`. In ChatGPT, enable **developer mode**, add a
connector, and point it at that URL (via your HTTPS front door, e.g.
`https://mcp.yourdomain.com/mcp`).

Each ChatGPT user authenticates with **their own** TManage token by sending
`Authorization: Bearer <token>`, so one remote server serves many members, each as themselves.
**Every** HTTP request must carry that header: a request without it is refused `401`. The `http`
transport never uses `TMANAGE_TOKEN` (that is for stdio only), and the server refuses to start
when `TMANAGE_TOKEN` is set together with a non-loopback `TMANAGE_MCP_HTTP_HOST`, so your own
token is never handed to whoever can reach the port. Leave `TMANAGE_TOKEN` unset here.

> Expose the `http` transport only over HTTPS and treat the endpoint as sensitive: a request's
> bearer token is a live TManage credential.

## Ready-made requests (recipes)

Once connected, people ask in plain words. The Help centre carries seven ready-made requests,
each with a Copy button, in English and Arabic: `/help/ai-recipes` (Arabic `/ar/help/ai-recipes`),
source `apps/web/src/content/help/ai-recipes.ts`.

| Recipe                          | What the assistant uses                           | Changes anything?              |
| ------------------------------- | ------------------------------------------------- | ------------------------------ |
| Plan my week                    | My day, work items, calendar focus blocks         | No                             |
| Summarise a project for client  | Project, its open work items, the project context | No (shows a draft)             |
| Sort my inbox                   | Inbox, notifications                              | No                             |
| Find what is overdue            | Projects, work items                              | No                             |
| Turn meeting notes into tasks   | Work items (create), people                       | Only after the member says yes |
| Find a document and summarise   | Search, documents                                 | No                             |
| Draft a reply in a conversation | Conversations, messages (list, create)            | Only after the member approves |

A recipe may only ask for what the catalogue really exposes; add one there before adding a
recipe that needs it. Confirm-class actions (deletes and the like) never run from a request:
they wait for the member under **Settings → AI actions** (`/<org>/settings/ai-actions`, list
read from `GET /v1/organizations/:orgSlug/ai/approvals`), with a "N waiting" badge on that menu
entry and a card on the AI assistant page.

## Running from source (development)

```bash
pnpm --filter @tmanage/mcp-server dev        # stdio, reads env
pnpm --filter @tmanage/mcp-server test        # unit tests
```

## How it works

- **Transports:** stdio (local assistants spawn the process) and Streamable HTTP (remote
  clients). Chosen with `TMANAGE_MCP_TRANSPORT`.
- **Auth:** a personal access token in `Authorization: Bearer`. The API resolves it to your
  membership and runs its ordinary permission checks — no elevation, no database access.
- **Workspace:** tools take an optional `org` (slug); omitted, the server uses
  `TMANAGE_ORG_SLUG`, or your first workspace.
