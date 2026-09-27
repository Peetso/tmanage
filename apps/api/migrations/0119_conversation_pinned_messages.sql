-- 0119_conversation_pinned_messages — CHAT pin/unpin (x247): a conversation's pinned-context list.
--
-- Governing sources: 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX §Chat CH-07 "Message actions" (pin) and
-- CH-02 "pinned context", 12-PERMISSION-MATRIX §2 (curating channel context is a moderation act,
-- `conversation.moderate`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §5-6 (scoped writes, composite
-- (organization_id, id) foreign keys), 07-DATA-MODEL §9 (every composite index begins with
-- organization_id), ADR-0001 (MySQL has no row-level security; layers 3-5 replace it).
--
-- ## Migration numbering
--
-- Numbered 0119 as reserved by the pass-24 queue map (x247=0119). The highest migration on this
-- slice's base is lower — the pass-13…23 branches land on master from siblings not yet integrated
-- here. The migrator applies files in ascending numeric order and a gap is legitimate
-- (migrator.db.test treats versions as a set, not positions), so 0119 on this base is correct; the
-- integrator renumbers only if a collision appears after the merges.
--
-- ## What this is
--
-- One row per pinned message: a reference an active moderator chose to keep at the top of a
-- conversation. It stores the reference (conversation_id + message_id) only, never a copy of the
-- message body — the pinned strip resolves each pin to the live message it points at. Pinning is
-- idempotent (PUT), unpinning is idempotent (DELETE), and the pinned set is capped by the service
-- (a 26th pin is a 409) so a channel's pinned strip cannot grow without bound.
--
-- ## The FK binds the pin to a message OF THE SAME TENANT; the conversation match is the service's
--
-- Unlike the coarse Home pins (0050), the pinned message is a row in this system, so the reference
-- is a real foreign key on `(organization_id, message_id)` — the same shape `message_work_links`
-- (0009) and `message_reactions`-style joins use, referencing the `(organization_id, id)` prefix of
-- `uq_messages_org_id_depth`. That is the only message key a child may reference, so the FK cannot
-- also carry `conversation_id`; instead the service resolves the conversation, then the message
-- tenant-scoped, and refuses (404, no row written) any message whose `conversation_id` is not the
-- one named on the path — a pin that pointed at another channel's message would be a way to surface
-- it in a conversation it was never posted to. Tenant safety therefore rests on resolve-before-write
-- exactly as 0050's does, with the FK adding referential integrity on top.

CREATE TABLE conversation_pinned_messages (
  id                CHAR(36)                               NOT NULL,
  organization_id   CHAR(36)                               NOT NULL,
  -- The conversation this pin belongs to. Not part of the message FK (see the header); the service
  -- enforces that the pinned message actually belongs to this conversation before any write.
  conversation_id   CHAR(36)                               NOT NULL,
  -- The pinned message. FK'd to messages of the same tenant below.
  message_id        CHAR(36)                               NOT NULL,
  -- Who pinned it, and when — CH-07 shows the pinning actor and the pinned order is by this time.
  pinned_by_user_id CHAR(36)                               NOT NULL,
  pinned_at         DATETIME(3)                            NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The composite key every tenant-owned table carries, the target of composite FKs from any child.
  UNIQUE KEY uq_conversation_pinned_messages_org_id (organization_id, id),
  -- Idempotency guard turned conflict: pinning the same message twice collides here rather than
  -- creating a second row, so PUT is idempotent and the count cap counts real pins.
  UNIQUE KEY uq_conversation_pinned_messages_pin (organization_id, conversation_id, message_id),
  -- 07-DATA-MODEL §9: the one read that exists — a conversation's pins, oldest first, id breaking
  -- ties for a total order.
  KEY ix_conversation_pinned_messages_list (organization_id, conversation_id, pinned_at, id),
  -- The pin names a message of this tenant. Referencing the (organization_id, id) prefix of
  -- uq_messages_org_id_depth, the same key message_work_links (0009) references.
  CONSTRAINT fk_conversation_pinned_messages_message_tenant
    FOREIGN KEY (organization_id, message_id) REFERENCES messages (organization_id, id),
  -- The actor who pinned it, an ordinary user reference.
  CONSTRAINT fk_conversation_pinned_messages_pinned_by
    FOREIGN KEY (pinned_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
