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

**Self-run (below):** the server needs two environment variables:

- `TMANAGE_API_URL` — your TManage API base URL, e.g. `https://app.yourdomain.com/api`
- `TMANAGE_TOKEN` — the token you just created

Optional:

- `TMANAGE_ORG_SLUG` — pin one workspace (otherwise the token's first workspace is used)
- `TMANAGE_MCP_TRANSPORT` — `stdio` (default) or `http`
- `TMANAGE_MCP_HTTP_PORT` / `TMANAGE_MCP_HTTP_HOST` — for the `http` transport (default `127.0.0.1:8787`)

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
node /absolute/path/to/tmanage/apps/mcp-server/dist/main.js
```

The MCP endpoint is `http://<host>:8787/mcp`. In ChatGPT, enable **developer mode**, add a
connector, and point it at that URL (via your HTTPS front door, e.g.
`https://mcp.yourdomain.com/mcp`).

Each ChatGPT user authenticates with **their own** TManage token by sending
`Authorization: Bearer <token>`, so one remote server serves many members, each as themselves.
If you set `TMANAGE_TOKEN` on the server it is used as a fallback for requests that carry no
bearer header — fine for a single-user deployment, but for a shared server prefer per-request
tokens and leave `TMANAGE_TOKEN` unset.

> Expose the `http` transport only over HTTPS and treat the endpoint as sensitive: a request's
> bearer token is a live TManage credential.

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
