-- 0209_pending_ai_actions — confirm-class AI actions waiting for a person (MCP connector S10).
--
-- When an AI client asks to run a confirm-class op (every DELETE, anything that sends, invites,
-- publishes, bills, ...), nothing runs. The server freezes the op id and its validated arguments
-- here, with a SHA-256 of the canonical arguments, and hands the client an approval link to
-- `/<org>/ai/approve/<id>`. The action runs only when the SAME member, signed in with a cookie
-- session, presses Approve on that page — and then it runs on the server, once, with exactly
-- these frozen arguments (architecture F3, T-APR-01..04).
--
-- Single use is a state transition, not a flag: `status` moves `pending` → `approved` |
-- `declined` | `expired` with a guarded UPDATE (`WHERE status = 'pending' AND expires_at > now`),
-- so a second approve changes nothing. Ten-minute lifetime (`expires_at`).
--
-- Tenant-owned (TENANT_TABLES). MariaDB-safe: no generated columns, no CHECK on JSON, plain
-- VARCHAR state.
CREATE TABLE pending_ai_actions (
  id               CHAR(36)      NOT NULL,
  organization_id  CHAR(36)      NOT NULL,
  -- The member the AI client acts for; only this member (and this user) may decide.
  membership_id    CHAR(36)      NOT NULL,
  user_id          CHAR(36)      NOT NULL,
  -- The AI client the request is attributed to (`pat:<id>` or an OAuth client id) and its name.
  client_id        VARCHAR(512)  NOT NULL,
  client_name      VARCHAR(190)  NOT NULL,
  -- The registry op id, e.g. `work_items.delete`. Never a path.
  op_id            VARCHAR(120)  NOT NULL,
  -- The frozen, schema-validated arguments and their canonical SHA-256.
  args_json        JSON          NOT NULL,
  args_sha256      CHAR(64)      NOT NULL,
  -- `pending` | `approved` | `declined` | `expired` | `failed`.
  status           VARCHAR(16)   NOT NULL DEFAULT 'pending',
  expires_at       DATETIME(3)   NOT NULL,
  decided_at       DATETIME(3)   NULL,
  -- The HTTP status and the (capped) JSON body the approved op returned, for check_approval.
  result_status    INT           NULL,
  result_json      JSON          NULL,
  created_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pending_ai_actions_org_id (organization_id, id),
  KEY ix_pending_ai_actions_member (organization_id, membership_id, status),
  CONSTRAINT fk_pending_ai_actions_member
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_pending_ai_actions_user
    FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
