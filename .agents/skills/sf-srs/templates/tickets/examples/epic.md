<!--
Why this example
================
Shows:
- Goal = outcome ("user can..."), not a task list.
- Business Value = 2-3 lines, stakeholder-facing, no implementation words.
- Scope Included ≈ one bullet per child Story. Excluded names what's tempting to grab but deferred.
- FR table lists ALL children so reviewers can jump.
- Definition of Done = verifiable facts, not intents.

Avoid:
- AC tables at Epic level (those live on Stories).
- Step-by-step tech tasks (live on Stories/Tasks).
- Deadlines in prose — put them in Dates.

Title convention:
  [EPIC] <English> — <French>
  e.g. [EPIC] Multi-tenant workspace isolation — Cloisonnement multi-tenant des espaces de travail

Domain chosen: multi-tenant workspace isolation for a generated SaaS app.
Content is fictional — import the pattern, not the facts.
-->

## Goal

When this Epic is Done, a user can create, switch between, and delete workspaces that are fully isolated — data, members, billing, and audit logs scoped to the active workspace, and no API route leaks
cross-workspace data.

## Business Value

Agencies and holdings need clean client separation without managing multiple accounts. Today we force them onto a second subscription or accept data comingling — both cost ARR. This Epic unblocks the
agency pricing tier and removes the top Q1 churn reason.

## Dates

- Target start: 2026-05-05
- Target end: 2026-06-20
- Milestone: workspace switcher on staging by 2026-06-01 (agency-tier sales demo)

## Scope

### Included

- Workspace CRUD with role-gated actions
- Invite teammates scoped to a workspace, per-workspace roles
- Workspace switcher in the app shell, persisted per session
- Row-level isolation via a Prisma tenancy middleware
- Audit log entries tagged with emitting workspace

### Excluded

- Per-workspace custom domains (separate Epic)
- Cross-workspace analytics (breaks isolation guarantee)
- Workspace-to-workspace data import
- Stripe subscription split per workspace (v1 stays one-per-user)

## Specifications

Main spec: [Epic SRS page — Multi-tenant workspace isolation](https://www.notion.so/epic-workspace-isolation-abc)

| FR     | Title                     | Page                                   |
| ------ | ------------------------- | -------------------------------------- |
| FR-421 | Create & rename workspace | [FR-421](https://www.notion.so/fr-421) |
| FR-422 | Invite teammate           | [FR-422](https://www.notion.so/fr-422) |
| FR-423 | Switch active workspace   | [FR-423](https://www.notion.so/fr-423) |
| FR-424 | Prisma tenancy middleware | [FR-424](https://www.notion.so/fr-424) |
| FR-425 | Per-workspace audit log   | [FR-425](https://www.notion.so/fr-425) |

## Dependencies

- #184 Auth v2 refresh-token rotation — session context must carry `workspaceId`
- Stripe agency-tier SKU (owner: @finance)

## Constraints

- All new API routes go through the tenancy middleware. No opt-out.
- Existing single-workspace users are migrated transparently (default workspace auto-created).
- No breaking changes to public API contracts — `workspaceId` inferred from session, not URL.

## Assumptions

- Stripe subscription stays at user level; workspace is a billing attribute.
- Audit log volume growth (~2×) fits within existing Loki retention budget.
- Frontend role-gating reuses `<RequireRole>`; no new permission primitive.

## Definition of Done

- All 5 child FRs are `Done`.
- `pnpm test:e2e tenancy` passes: 0 cross-workspace data leaks.
- Staging migration executed; 100% of existing users have a default workspace.
- `docs/workspace-isolation.md` exists and is linked from getting-started.
- Agency-tier sales demo signed off by @sales.
