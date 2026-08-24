# TManage — Analytics Taxonomy and Measurement Specification

## 1. Principles

Measure workflow outcomes, not employee worth. No keystroke/time surveillance, hidden productivity score, private-message sentiment, or client content in analytics. Event names are stable past-tense facts; properties use IDs/enums/booleans, not free-text work content.

## 2. Event envelope

Required: `event_name`, `event_version`, `occurred_at`, `anonymous_or_user_id`, `organization_id`, `session_id`, `platform`, `locale`, `timezone`, `correlation_id`. Optional safe context: workspace/project/object IDs, role category, plan, feature flag, source surface. Never include message/document text, filename, approval feedback, email, IP in product analytics.

## 3. Core events

| Event | Trigger | Safe properties | Metric use |
|---|---|---|---|
| `organization_created_v1` | transaction success | template, locale | activation |
| `project_created_v1` | project success | template, client_linked bool | activation |
| `member_invited_v1` | invitation committed | internal/client, role category | activation |
| `client_request_submitted_v1` | request committed | category enum, desired date present | request funnel |
| `client_request_transitioned_v1` | transition committed | from/to, clarification count | triage time |
| `message_converted_v1` | conversion committed | work type, owner/date present | context-to-action |
| `work_state_changed_v1` | work transition | from/to, blocked bool, overdue bool | flow time |
| `blocker_created_v1` | blocker activated | reason category, dependency bool | blocked time |
| `deliverable_version_created_v1` | version created | version number, file count bucket | delivery funnel |
| `client_preview_completed_v1` | preview loaded/warnings resolved | role previewed, warning count bucket | safe publish |
| `deliverable_published_v1` | publication committed | reviewer count, approval policy | delivery funnel |
| `approval_opened_v1` | authorized first view | channel, deep_link bool | client engagement |
| `approval_decided_v1` | decision committed | approved/changes, hours bucket | approval cycle |
| `notification_acted_v1` | inline/open action success | bundle type, channel | notification value |
| `search_completed_v1` | results rendered | result count bucket, filters count, clicked bool later | search success |
| `pulse_published_v1` | update published | internal/client, source coverage bucket | reporting reduction proxy |
| `member_offboarded_v1` | job completed | transferred counts buckets | admin safety |

## 4. Funnels

Activation: organization → project → 3 internal invitations → 10 work items → message converted → first completed work within 7 days; service-team activation adds client linked → approval decided within 14 days.

Request loop: submitted → triaged → accepted/declined → planned → delivered. Approval loop: version created → internal ready → preview → published → opened → decided → final.

## 5. Metric definitions

- Weekly Completed Work Loop: unique work/deliverable loop reaches accepted/final outcome in week with owner, context relation, and no unresolved blocker.
- Client approval turnaround: `decision_time - publish_time`; show median/p75/p90, exclude cancelled/invalidated and segment reminder count.
- Request acknowledgement: first internal triage event minus submission.
- Blocked share: duration in blocked / active cycle duration.
- Search success proxy: result clicked/opened within session without reformulation within 60 seconds; validate qualitatively.
- Status request proxy: client request/comment classified explicitly as status request through structured action, not content inference.
- Notification usefulness: acted bundles / delivered actionable bundles; guardrail mute rate.

## 6. Dashboards

Product activation/retention; delivery funnel; client engagement; workflow flow/blocked; search/inbox; reliability/performance; security/privacy operations; unit economics. Access to customer-level dashboards is role-limited; internal product analysts use pseudonymous IDs and approved purpose.

## 7. Experiment rules

Pre-register hypothesis, primary metric, guardrails, segment, duration, decision rule. No experiment weakens authorization, privacy, approval evidence, accessibility, or misleads clients. Feature flags record exposure event once.

## 8. Data quality

Schema registry and CI validation; event versioning; duplicate/retry handling; source-of-truth reconciliation with database; freshness/completeness monitors; timezone UTC; bot/test/employee traffic classified; metric owner and definition catalog.

## 9. Retention and access

Proposed analytics retention 13 months subject to legal approval; aggregates longer if anonymized. Raw access least privilege; export/download audited. Organization admins receive product-level tenant insights, not TManage internal experimentation data.
