# TManage — Final Repository Structure

```text
tmanage/
  apps/
    web/
      app/
        [org]/
          (team)/home/
          (team)/inbox/
          (team)/chat/[conversationId]/
          (team)/projects/[projectId]/
          (team)/work/[workItemId]/
          (team)/deliverables/[deliverableId]/
          (client)/client/[projectId]/
          (admin)/admin/
      components/
      features/
      i18n/
      public/
      tests/
    api/
      src/
        modules/
          identity/
          tenancy/
          memberships/
          projects/
          work/
          conversations/
          files/
          deliverables/
          approvals/
          clients/
          notifications/
          search/
          audit/
        common/
          auth/
          authorization/
          database/
          errors/
          idempotency/
          observability/
          validation/
        main.ts
      migrations/
      test/
    worker/
      src/
        consumers/
        jobs/
        outbox/
        notifications/
        files/
        search/
    desktop/                 # created only after desktop gate
  packages/
    ui/
      src/components/
      src/tokens/
      src/styles/
      stories/
      tests/
    contracts/
      openapi/
      generated/
      events/
    domain/
      src/value-objects/
      src/policies/
      src/state-machines/
    config/
    observability/
    test-kit/
      factories/
      fixtures/
      auth-contexts/
  docs/
    planning/                # complete planning pack
    design/                  # AI designer output
    product/
    adr/
    api/
    events/
    security/
    runbooks/
    implementation-status.md
  infra/
    environments/
      local/
      staging/
      production/
    modules/
    containers/
  scripts/
  .github/workflows/
  .env.example
  compose.yaml
  package.json
  pnpm-workspace.yaml
  pnpm-lock.yaml
  README.md
```

## Boundary rules

- Feature UI may depend on `ui` and generated `contracts`, never API internals.
- API modules cannot directly write another module’s tables.
- `domain` contains pure shared value objects/policies only, not ORM entities.
- Contracts are versioned. Events and OpenAPI are reviewed artifacts.
- `test-kit` contains synthetic data only.
- Infrastructure secrets never live in repository.
