# Shipping Your First Ticket

A hands-on walkthrough of the SaaSFoundryAI workflow, from an idea in your backlog to code merged on `master`. You will drive one real ticket through the full 7-status lifecycle — the same lifecycle
every contributor on your project uses, human or AI.

**Time required**: ~20 minutes **Prerequisites**: a project generated with `sf new` and a GitHub Project board wired to it (or Jira / Notion / Linear — the flow is identical).

## The example feature

We will ship a tiny endpoint: **`GET /api/version`** returning `{ version: "1.0.0" }` from `package.json`.

- Complexity: 🟢 **low** — no schema changes, no new dependencies, no security surface. Single new endpoint, under 20 lines of code.
- Target branch: `master` (or whatever your `workflow.releaseBranch` points at).

This is intentionally trivial. The point is not to build something impressive — it is to see **every status** of the workflow in action, so you trust the process when you come back with a harder
feature tomorrow.

## The seven statuses at a glance

```text
Backlog → Ready → In progress → AI testing → Human testing → In review → Done
```

Each transition has a mandatory action. Skipping a status is the fastest way to ship broken code. The `sf-workflow` skill (installed with every generated project) enforces the transitions, so both you
and your AI agent play by the same rules.

## Step 1 — Backlog: create the ticket

Open your GitHub Project board and create a new issue:

- **Title**: `Add /api/version endpoint`
- **Body**: `Expose the current package.json version at GET /api/version. Returns { version: string }. No auth required, public endpoint.`
- **Status column**: `Backlog`

::: tip Let your AI agent do this If Claude Code is set up with the `sf-workflow` skill, you can simply say:

> "Create a backlog ticket: add a /api/version endpoint that returns the package.json version. Low complexity."

The agent will create the issue, tag complexity, and place it on the board via the same CLI you would run manually.

:::

### Tag complexity

Complexity lives on a **label**, not the status. One-time setup per repo:

```bash
gh label create "complexity: low"    --color 7CFC00 --description "🟢 Low complexity"
```

Then tag the ticket:

```bash
CLI=.claude/skills/sf-tool-github-projects/github-projects-cli.sh
$CLI set-complexity 42 low   # replace 42 with your issue number
```

Complexity controls how much ceremony the AI applies later. A `low` ticket stays lightweight (no approval gate, minimal analysis), while a `complex` ticket triggers full adversarial review.

## Step 2 — Backlog → Ready

Before moving the ticket forward, confirm the spec is clear. For `low` tickets, that usually means:

- Acceptance criteria written down (even one line is fine)
- No open questions about the HTTP contract
- No risky assumptions about auth, data, or external services

When the spec is ready:

```bash
$CLI update-status 42 "Ready"
```

The ticket now sits in the team's queue.

## Step 3 — Ready → In progress

Start the work by branching off your working branch:

```bash
git checkout develop
git pull --rebase
git checkout -b feature/42-version-endpoint
```

Then update the board:

```bash
$CLI update-status 42 "In progress"
```

### Decompose if needed

For `low` tickets, decomposition is often unnecessary. For `medium` or `complex` tickets, the workflow mandates **real sub-issues** (not checklist items):

```bash
$CLI create-subtask 42 "Backend endpoint"
$CLI create-subtask 42 "Integration test"
```

Sub-issues are linked via the GraphQL `addSubIssue` mutation. The workflow reads that native hierarchy through GitHub's sub-issues API: a parent cannot move to `Done` until every child has
project-board Status `Done`. An Epic also moves to `In progress` with its first active child and to `Done` with its last completed child.

## Step 4 — Code the feature

On the `apps/api` side, add the endpoint. Following the scaffold conventions:

```ts
// apps/api/src/modules/version/version.controller.ts
import { Controller, Get } from '@nestjs/common'
import { VersionService } from './version.service'

@Controller('version')
export class VersionController {
  constructor(private readonly versionService: VersionService) {}

  @Get()
  getVersion() {
    return { version: this.versionService.getVersion() }
  }
}
```

```ts
// apps/api/src/modules/version/version.service.ts
import { Injectable } from '@nestjs/common'
import { readFileSync } from 'fs'
import { join } from 'path'

@Injectable()
export class VersionService {
  getVersion(): string {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    return pkg.version ?? '0.0.0'
  }
}
```

Wire the module, then write the test:

```ts
// apps/api/src/modules/version/tests/unit/version.service.spec.ts
import { VersionService } from '../../version.service'

describe('VersionService', () => {
  it('returns the package.json version', () => {
    const service = new VersionService()
    expect(service.getVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})
```

## Step 5 — Commit and push

Use the project's enforced commit format:

```bash
git add apps/api/src/modules/version/
git commit -m "feat(#42): add /api/version endpoint"
git push -u origin feature/42-version-endpoint
```

The pre-commit hook runs Prettier, ESLint, TypeScript, and Jest. The pre-push hook runs the Docker build scenarios. **Pushing succeeds only if everything is green** — humans and AI alike.

## Step 6 — In progress → AI testing

Once the commit is on the remote, hand the ticket over to automated validation:

```bash
$CLI update-status 42 "AI testing"
```

AI testing runs the full test plan the AI agent generates for this ticket. For a `low`-complexity endpoint, that looks like:

```bash
npm run build
npm run lint
npm run type-check
npm run test:unit
curl http://localhost:3500/api/version     # smoke test against the dev server
```

The agent posts a test plan comment on the issue before running, and a summary comment after. If everything passes, it transitions the ticket to Human testing.

## Step 7 — AI testing → Human testing

```bash
$CLI update-status 42 "Human testing"
```

This is your turn. Start the dev servers and **verify the feature in a browser / with curl**:

```bash
npm run dev
# in another terminal
curl http://localhost:3500/api/version
# → { "version": "1.0.0" }
```

Check:

- [ ] Endpoint returns the right shape
- [ ] Endpoint is reachable without authentication (as specified)
- [ ] Nothing unrelated broke (adjacent routes still work)

### If you find a bug

Do **not** open the PR yet. Document the bug on the issue, fix it on the feature branch, commit, push, and **restart from AI testing**. Human testing is the last checkpoint before the PR — once you
pass it, the code must be shippable.

## Step 8 — Human testing → In review

Open the pull request using the workflow CLI (it pushes if needed and targets your release branch):

```bash
$CLI create-pr 42
$CLI update-status 42 "In review"
```

The PR links back to the ticket, includes the AI test plan + summary comments in its description, and triggers CI. Add a reviewer; CI must be green and the reviewer must approve before merge.

## Step 9 — In review → Done

Once the PR is approved and CI is green, merge via the GitHub UI. Then finalise:

```bash
$CLI update-status 42 "Done"
git checkout develop
git pull --rebase
git branch -d feature/42-version-endpoint
```

The ticket is closed, the branch is cleaned up, the feature is live.

## What you just practised

Even for a trivial endpoint, you touched every guardrail the workflow provides:

| Status        | What happened                       | Guardrail                                  |
| ------------- | ----------------------------------- | ------------------------------------------ |
| Backlog       | Created ticket, tagged complexity   | Spec lives on the issue, not a chat log    |
| Ready         | Confirmed acceptance criteria       | No ambiguous tickets reach implementation  |
| In progress   | Branch + decomposition              | No work outside the status system          |
| AI testing    | Automated test plan + execution     | Tests written and run before humans review |
| Human testing | Manual validation in a real runtime | Automation blind spots caught in person    |
| In review     | PR with CI + reviewer approval      | External validation before code ships      |
| Done          | Cleanup + confirmation              | No half-closed work leaking into the board |

The next ticket — even if it is 10× larger — uses **the exact same flow**. The complexity tag (`medium` / `complex`) just scales the rigor at each step. And because your AI agent reads the same
`.saasfoundry.json` and the same `sf-workflow` skill files as you do, it will apply the same discipline.

## Next steps

- Read [Workflow System](/workflow/introduction) to understand the philosophy behind the 7 statuses.
- Read [Complexity System](/workflow/complexity-system) for the full `bug` / `low` / `medium` / `complex` contract.
- Read [AI Rules](/workflow/ai-rules) for the eight non-negotiables the AI agent follows — and why.
- Look at [First Project](/getting-started/first-project) for a deeper dive into the generated codebase itself.
