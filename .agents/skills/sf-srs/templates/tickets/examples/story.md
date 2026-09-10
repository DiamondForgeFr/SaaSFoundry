<!--
Why this example
================
Shows:
- Objective = one sentence, user-facing, names the *capability* and the FR it implements.
- Context (User Requirements) links UR items so reviewers see the user narrative.
- Scope (Functional Requirements) = usually one FR; if two, that's a smell.
- Acceptance Criteria table: 3-5 rows, each testable, each traced back to a Source FR.
- Specifications points to the FR SRS page and the parent Epic spec.
- Design References links DS items (Figma frames, email templates).

Avoid:
- Implementation steps ("use useMutation", "add /api/invite route") — those belong on Task subissues or are inferred.
- More than 5 AC — if you need more, split the Story or move some to CC on Tasks.
- Bare "should work" AC — every AC names the input *and* the observable outcome.

Title convention:
  [Parent #<epic>] <English> — <French>
  e.g. [Parent #251] Invite teammate to workspace — Inviter un coéquipier dans un espace de travail

Domain chosen: Story under the workspace-isolation Epic (see examples/epic.md).
Content is fictional — import the pattern, not the facts.
-->

## Objective

Implement FR-422 — Invite teammate to workspace. A workspace owner or admin can invite a new member by email, choose their role (`admin` / `member` / `viewer`), and the invitee receives an email link
that joins them to the workspace on first accept.

## Context (User Requirements)

- **UR-33** — As a workspace owner, I want to invite teammates by email so I can onboard my clients without creating accounts for them myself.
- **UR-34** — As an invited user, I want to accept an invite with one click (already logged in) or create my account on accept (new user).

## Scope (Functional Requirements)

- **FR-422** — Invite teammate to workspace

## Acceptance Criteria

| AC  | Criterion                                                                                                                                                  | Source FR |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| AC1 | Owner/admin submits email + role via `POST /workspace/members/invite`; a row is created in `WorkspaceInvite` with status `pending` and a 7-day expiry      | FR-422    |
| AC2 | An email is sent via the Mailer module containing a signed link `/invite/:token`; the token is a single-use JWT                                            | FR-422    |
| AC3 | Accepting while logged in as the invitee's email: creates a `WorkspaceMember` with the assigned role, marks invite `accepted`, redirects to workspace home | FR-422    |
| AC4 | Accepting while logged out: redirects to `/register?invite=<token>`; on registration completion, membership is created atomically                          | FR-422    |
| AC5 | Roles `member` and `viewer` cannot invite; attempting returns `403 Forbidden` with code `E_ROLE_INSUFFICIENT`                                              | FR-422    |

## Specifications

- FR page: [FR-422 — Invite teammate](https://www.notion.so/fr-422)
- Epic spec: [Multi-tenant workspace isolation](https://www.notion.so/epic-workspace-isolation-abc)

## Dependencies

- #184 Auth v2 — JWT service required for signed invite tokens
- Mailer module installed (run `sf skill install sf-skill-email` if missing)

## Constraints

- Expired or already-used tokens must return a friendly 410 Gone page, not a 500.
- Email content respects i18n — render in the invitee's preferred locale if they already exist.
- No silent role escalation: workspace-scoped role applies only to THIS workspace.

## Design References

- **DS-14** — Invite dialog (Figma frame)
- **DS-15** — `/invite/:token` accept screen (Figma frame)
- **DS-16** — Invite email template
