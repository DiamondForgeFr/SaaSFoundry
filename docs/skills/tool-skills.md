# Tool Skills

**Tool skills** connect your project's AI agent to external services — library docs, ticket systems, design files, workspaces. They are installed on demand (`sf new` or
`sf update --add-modules <skill>`), and the ones that require authentication use SaaSFoundryAI's **multi-account credentials system** so you can flip between personal / client / work identities with
one command.

## Two flavours of tool skill

| Flavour           | Credentials                 | Switchable between accounts | Examples                                               |
| ----------------- | --------------------------- | --------------------------- | ------------------------------------------------------ |
| **Public API**    | None (anonymous tier)       | N/A                         | `sf-tool-context7`                                     |
| **Authenticated** | Per-service token / API key | Yes, via `sf tools use`     | `sf-tool-atlassian`, `sf-tool-notion`, `sf-tool-figma` |

Workflow tool skills (`sf-tool-github-projects` today; `sf-tool-jira`, `sf-tool-linear`, `sf-tool-notion` workflow variant, and `sf-tool-clickup` on the roadmap) are a third bucket — installed **once
per project**, chosen at `sf new` time, driven by your board tool's own auth (`gh auth` for GitHub, API token for the others). See [Workflow System](/workflow/introduction) for their role.

## Available tool skills

| Skill                                     | Use case                                      | Credentials                 |
| ----------------------------------------- | --------------------------------------------- | --------------------------- |
| [`sf-tool-context7`](#sf-tool-context7)   | Fresh library docs (React, NestJS, Prisma, …) | None — free public API      |
| [`sf-tool-atlassian`](#sf-tool-atlassian) | Jira issues + Confluence wiki                 | Atlassian email + API token |
| [`sf-tool-notion`](#sf-tool-notion)       | Notion workspace pages / databases            | Notion integration token    |
| [`sf-tool-figma`](#sf-tool-figma)         | Figma design files + metadata                 | Figma personal access token |

## Installing a tool skill

During project creation:

```bash
sf new
# When prompted:
? Select advanced skills
→ [x] sf-tool-context7 [free, no credentials]
→ [x] sf-tool-atlassian
# [Atlassian credentials prompted here]
```

After the fact:

```bash
sf update --add-modules sf-skill-atlassian \
  --atlassian-email you@example.com \
  --atlassian-api-token $ATLASSIAN_TOKEN \
  --atlassian-domain yourcompany.atlassian.net
```

`sf update` will write the skill directory, wire it into the scaffold's CLAUDE.md, and store credentials in `~/.claude/credentials/atlassian/<account>.env`.

## Multi-account credentials

Authenticated tool skills use a **centralised credentials directory** — `~/.claude/credentials/<tool>/<account>.env` — so you can keep multiple accounts side by side:

```
~/.claude/credentials/
├── atlassian/
│   ├── work.env           # work@company.com
│   ├── client-acme.env    # consulting for ACME
│   └── personal.env
├── notion/
│   └── personal.env
└── figma/
    └── work.env
```

Each project's `.saasfoundry.json` points to the active account per tool:

```jsonc
{
  "skillsAccounts": {
    "atlassian": "work",
    "notion": "personal",
    "figma": "work"
  }
}
```

### The `sf tools` CLI

```bash
sf tools list                       # Which tool skills are installed and which account they use
sf tools accounts atlassian         # What accounts exist for Atlassian
sf tools add atlassian client-acme  # Register a new account (prompts for creds)
sf tools use atlassian client-acme  # Switch the current project to that account
sf tools current atlassian          # Echo the active account for Atlassian
```

No shell magic, no re-editing `.env` files by hand. One command to flip context.

See the [`sf tools` reference](/cli/sf-tools) for the full flag table.

## `sf-tool-context7`

Real-time, version-specific documentation for 1000+ libraries via the [Context7](https://context7.com) public API. **No credentials**, no account, no rate-limit beyond the anonymous tier.

**Auto-triggers** on questions like "how do I use `useEffect` in React 19?" or "show me the Prisma driver-adapter setup". Also triggers on the literal phrase "use context7".

**CLI**:

```bash
~/.claude/skills/sf-tool-context7/context7-cli.sh search "react"
~/.claude/skills/sf-tool-context7/context7-cli.sh docs reactjs/react.dev "useEffect"
~/.claude/skills/sf-tool-context7/context7-cli.sh docs prisma/prisma
```

Library IDs follow the `owner/repo` convention (no leading slash). When the agent isn't sure, it calls `search` first to resolve the ID, then `docs` for focused content.

**When NOT to use it**: plain JavaScript / TypeScript syntax, your project's internal code, or APIs so stable they do not need to be re-checked (e.g., `Array.prototype.map`).

## `sf-tool-atlassian`

Read and write access to Jira + Confluence via their REST APIs. Auto-triggers on `atlassian.net` URLs and on mentions of "Jira", "Confluence", "ticket", "sprint", "board", "epic", "wiki".

**Jira commands**:

```bash
atlassian-cli.sh jira projects
atlassian-cli.sh jira issue SW-123
atlassian-cli.sh jira search "project = SW AND status = 'In Progress'"
atlassian-cli.sh jira create SW Task "Summary" --desc "Details"
atlassian-cli.sh jira transition SW-123 31
atlassian-cli.sh jira comment SW-123 "Ready for review"
atlassian-cli.sh jira worklog SW-123 2h
```

**Confluence commands**:

```bash
atlassian-cli.sh confluence spaces
atlassian-cli.sh confluence pages <SPACE_ID>
atlassian-cli.sh confluence page <PAGE_ID>
atlassian-cli.sh confluence search "text ~ 'keyword'"
atlassian-cli.sh confluence create <SPACE_ID> "Title" "<p>Body</p>"
```

**Required credentials**:

```env
ATLASSIAN_EMAIL="you@example.com"
ATLASSIAN_API_TOKEN="ATATT..."
ATLASSIAN_DOMAIN="yourcompany.atlassian.net"
```

Generate the API token at https://id.atlassian.com/manage-profile/security/api-tokens.

**Where it shines**: multi-project consultancies where you context-switch between client Jiras several times a day. `sf tools use atlassian <client>` flips the skill's identity in a single command, no
browser sign-in ritual.

## `sf-tool-notion`

Notion workspace access for pages, databases, and comments. Auto-triggers on `notion.so` URLs and on mentions of "Notion", "workspace", "page", "database".

Three typical flows:

- **Read a page**: auto-triggered when you paste a Notion URL
- **Query a database**: search by property, filter, fetch rows
- **Create a page**: useful for auto-drafting release notes from ticket commits

**Required credentials**:

```env
NOTION_TOKEN="secret_..."
```

Create a Notion integration at https://www.notion.so/my-integrations, then share the target pages/databases with that integration.

**Gotcha**: Notion's permission model is opt-in — an integration can only read / write pages that have been explicitly shared with it. If a command fails with "object not found", the page likely was
not shared.

**Also the default SRS backend** : the same integration token powers the [SRS module](/modules/srs), where Notion is the V1 backend for Epic / FR page hierarchies. Confluence and local-markdown
backends are on the roadmap. See the [SRS lifecycle](/srs/lifecycle) and [walkthrough](/srs/walkthrough) for how this plays with the drafting workflow.

## `sf-tool-figma`

Read-only access to Figma files + frames + metadata. Auto-triggers on `figma.com/file/...` URLs.

Typical uses:

- Fetch a frame's size / colour tokens / text content to implement it accurately in React
- Resolve a component's auto-layout into Tailwind classes
- Extract design tokens for a design-system migration

**Required credentials**:

```env
FIGMA_TOKEN="figd_..."
```

Generate the personal access token under Figma → Settings → Personal access tokens.

**Limitation**: the skill is read-only. It does not edit Figma files back.

## Workflow tool skills

One workflow tool skill is installed per project, chosen at `sf new` time:

| Board tool      | Skill                               | Authentication                                          | Availability    |
| --------------- | ----------------------------------- | ------------------------------------------------------- | --------------- |
| GitHub Projects | `sf-tool-github-projects`           | `gh auth login` (already present)                       | Available today |
| Jira            | `sf-tool-jira`                      | Atlassian API token (shared with `sf-tool-atlassian`)   | On the roadmap  |
| Notion          | `sf-tool-notion` (workflow variant) | Notion integration token (shared with `sf-tool-notion`) | On the roadmap  |
| Linear          | `sf-tool-linear`                    | Linear API key                                          | On the roadmap  |
| ClickUp         | `sf-tool-clickup`                   | ClickUp API token                                       | On the roadmap  |

::: info What ships today

Only `sf-tool-github-projects` is in the current release. The Jira, Notion, Linear and ClickUp adapters are scheduled next — they plug in behind the same `sf-workflow` skill, so the commands you learn
today do not change when they land.

:::

These skills are **not opt-in** in the same way as `sf-tool-context7` — they are the plumbing `sf-workflow` relies on to move tickets across statuses, create sub-issues, post test-plan comments, and
open PRs from the CLI. You do not call them directly; `sf-workflow` calls them for you.

The `sf-tool-github-projects` CLI is worth reading even if you never invoke it yourself — it links native sub-issues, reports every child whose project-board Status is not `Done`, and gives
`sf-workflow` the data used for parent completion guards and Epic status roll-up.

See [GitHub Integration](/workflow/github-integration) for how the skill talks to Projects V2.

## Upgrading tool skills

Tool skills participate in the three-way merge handled by `sf update` (see [Updating Projects](/guide/updating-projects)). If the upstream skill evolves (new subcommand, new auth flow) but you have
not customised the CLI script, `sf update` auto-applies the upgrade. If you customised it (e.g. added a company-specific `jira-epic` shortcut), the upgrade lands as a `.saasfoundry.new` sidecar you
review and merge by hand.

**What `sf update` never touches**:

- Your credentials in `~/.claude/credentials/`
- The active account recorded in `.saasfoundry.json → skillsAccounts`

So upgrades are safe — the worst that can happen is a merge conflict on a CLI script, never a credentials wipe.

## Next steps

- [Creating Skills](/skills/creating-skills) — build your own
- [`sf tools` reference](/cli/sf-tools) — CLI for account management
- [`sf skill` reference](/cli/sf-skill) — add/remove skills
