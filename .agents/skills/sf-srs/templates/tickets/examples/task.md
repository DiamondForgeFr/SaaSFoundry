<!--
Why this example
================
Shows:
- Objective = the technical deliverable, not a user-facing capability.
- Context = "why now" — typically duplication, drift, or an upcoming dependency.
- Scope Included/Excluded is granular — a Task touches a bounded set of files.
- Completion Criteria = fine-grained contract (each CC ≈ a test you can write).
- Specifications lists the existing artifacts being modified.

When Task vs Story:
- Task: refactor, migration, tooling, internal schema change, docs overhaul — no user-observable change.
- Story: user-facing capability.

Avoid:
- Turning a Task into a Story by inventing a "user can…" framing to look like feature work.
- AC tables on a Task (use Completion Criteria).
- Tasks without a parent — every Task lives under an Epic or is a standalone meta-task.

Title convention:
  [Parent #<epic-or-story>] <English> — <French>
  e.g. [Parent #251] Extract shared email validation — Extraire la validation email partagée

Domain chosen: cross-cutting Task under the same workspace-isolation Epic.
Content is fictional — import the pattern, not the facts.
-->

## Objective

Extract the email-validation logic duplicated across `auth/register`, `auth/forgot-password`, `users/update-profile`, and the upcoming `workspace/members/invite` into a shared Zod schema at
`@common/schemas/email.schema.ts`, and migrate the three existing callsites to consume it.

## Context

Today each route re-declares `z.string().email().min(5).max(254)` with slight drift — two callsites forgot `.max(254)`, one uses `.toLowerCase()`, one doesn't. This caused #268 (inconsistent rejection
of uppercase emails on forgot-password vs register). The upcoming workspace-invite work (FR-422) adds a 4th callsite — we lock the schema before that lands to stop the drift.

## Scope

### Included

- Create `src/common/schemas/email.schema.ts` with the canonical Zod schema.
- Migrate the 3 existing callsites to import from it.
- Replace inline DTO validators in the corresponding `*.dto.ts` files.
- Update unit tests to assert the shared schema is referenced (not reimplemented).

### Excluded

- Password schema extraction (separate Task — scope creep).
- Frontend-side email validation (React Hook Form resolvers, owned elsewhere).
- Changing the rules themselves (lowercase, max length) — lift-and-shift only.

## Completion Criteria

| CC  | Criterion                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CC1 | `src/common/schemas/email.schema.ts` exports `emailSchema` with `.toLowerCase().email().max(254)` — matches the pre-existing register-route behavior exactly |
| CC2 | All 3 callsites import `emailSchema`; no inline `z.string().email()` remains in those files (grep returns 0 hits)                                            |
| CC3 | Existing unit + e2e tests for the 3 routes still pass unchanged                                                                                              |
| CC4 | New unit test `email.schema.spec.ts` covers: lowercase normalization, > 254 chars rejected, invalid format rejected, trimmed whitespace rejected             |
| CC5 | No behavior change observable in the 3 routes (confirmed via existing e2e tests)                                                                             |

## Specifications

- Duplicated today at: `src/modules/auth/dto/register.dto.ts:12`, `src/modules/users/dto/update-profile.dto.ts:8`, `src/modules/auth/dto/forgot-password.dto.ts:5`
- Zod v4 guidance: prefer `.email()` over custom regex
- Shared schemas convention: `docs/architecture-modules.md#shared-schemas`

## Dependencies

- None — lift-and-shift only.

## Constraints

- Must land before FR-422 (workspace invite) to avoid introducing a 4th drifted callsite.
- API response error message stays `"Invalid email"` — no user-visible change.
- Backward compatibility: callsites that previously accepted uppercase emails keep silently normalizing.
