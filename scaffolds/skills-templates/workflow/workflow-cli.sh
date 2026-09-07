#!/bin/bash

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Load configuration from .saasfoundry.json (single source of truth)
load_config() {
  if [[ ! -f ".saasfoundry.json" ]]; then
    echo -e "${RED}Error: .saasfoundry.json not found${NC}" >&2
    echo "This command must be run from the project root." >&2
    exit 1
  fi

  WORKFLOW_TOOL=$(jq -r '.workflow.tool // empty' .saasfoundry.json)
  WORKING_BRANCH=$(jq -r '.workflow.workingBranch // "develop"' .saasfoundry.json)

  if [[ -z "$WORKFLOW_TOOL" ]]; then
    echo -e "${RED}Error: No workflow tool configured in .saasfoundry.json${NC}" >&2
    exit 1
  fi
}

# Get tool skill CLI path
get_tool_cli() {
  local tool=$1
  local project_root="."

  # Determine if monorepo or multirepo
  if [[ -d "apps" ]]; then
    # Monorepo - skills at root
    echo "${project_root}/.claude/skills/sf-tool-${tool}/${tool}-cli.sh"
  else
    # Multirepo - skills in current app directory
    echo "${project_root}/.claude/skills/sf-tool-${tool}/${tool}-cli.sh"
  fi
}

# Route command to appropriate tool CLI
route_to_tool() {
  local tool=$1
  shift

  local tool_cli=$(get_tool_cli "$tool")

  if [[ ! -f "$tool_cli" ]]; then
    # Fallback to installed tool skill
    tool_cli="$HOME/.claude/skills/tool-${tool}/${tool}-cli.sh"
    if [[ ! -f "$tool_cli" ]]; then
      echo -e "${RED}Error: Tool skill for '${tool}' not found${NC}" >&2
      echo "Expected: $(get_tool_cli $tool)" >&2
      exit 1
    fi
  fi

  # Make tool CLI executable
  chmod +x "$tool_cli" 2>/dev/null || true

  # Execute tool CLI
  "$tool_cli" "$@"
}

# Which adapters project a milestone today.
#
# Kept as an explicit list rather than probed at runtime: an adapter that
# silently accepts `milestone` and does nothing is worse than one that
# says it cannot, and probing would report "supported" for any tool CLI
# that happens not to fail on an unknown argument.
milestone_supported() {
  case "$1" in
    github-projects) return 0 ;;
    *) return 1 ;;
  esac
}

# Function to get current status of a ticket.
#
# Uses the tool CLI's --json flag and parses with jq — no more grep|awk on
# human-oriented output. Tool CLIs without --json support fall back to the
# legacy "Status: X" line so installers can upgrade skills independently.
get_current_status() {
  local ticket=$1
  local status=""
  local payload

  load_config

  case "$WORKFLOW_TOOL" in
    github-projects|jira|notion|linear)
      payload=$(route_to_tool "$WORKFLOW_TOOL" status "$ticket" --json 2>/dev/null || true)
      if [[ -n "$payload" ]] && echo "$payload" | jq -e . >/dev/null 2>&1; then
        status=$(echo "$payload" | jq -r '.status // ""')
      else
        # Legacy fallback — tool CLI has no --json yet
        status=$(route_to_tool "$WORKFLOW_TOOL" status "$ticket" 2>&1 | grep "^Status:" | awk -F': ' '{print $2}')
      fi
      ;;
    *)
      echo -e "${RED}Unknown workflow tool: $WORKFLOW_TOOL${NC}" >&2
      return 1
      ;;
  esac

  echo "$status"
}

# Function to display status description
# ───────────────────────────────────────────────────────────────────────────
# Manifest-driven status resolution
# ───────────────────────────────────────────────────────────────────────────
#
# The status set is owned by `.saasfoundry.json` (workflow.statuses) — presets
# differ (team = 7 statuses, solo = 5), so nothing here may hardcode a
# sequence. Status docs are resolved by SLUG (`statuses/<n>-<slug>.md`), which
# makes the lookup independent of the per-preset numbering.

status_slug() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | awk '{$1=$1;print}' | tr ' ' '-'
}

resolve_status_file() {
  local status=$1

  # Drafting phases are lifecycle docs, not board columns — resolve by suffix.
  case "$status" in
    "drafting:ai-draft") ls "$SKILL_DIR"/statuses/*-ai-drafting.md 2>/dev/null | head -n 1; return 0 ;;
    "drafting:human-review") ls "$SKILL_DIR"/statuses/*-human-review.md 2>/dev/null | head -n 1; return 0 ;;
    "drafting:spawning") ls "$SKILL_DIR"/statuses/*-spawning.md 2>/dev/null | head -n 1; return 0 ;;
  esac

  local slug
  slug=$(status_slug "$status")
  ls "$SKILL_DIR"/statuses/[0-9]*-"$slug".md 2>/dev/null | head -n 1
  return 0
}

# Print the configured status names, one per line (empty output when the
# manifest or jq is unavailable — callers fall back to legacy behaviour).
manifest_statuses() {
  command -v jq >/dev/null 2>&1 || return 0
  [[ -f ".saasfoundry.json" ]] || return 0
  jq -r '.workflow.statuses[]?.name // empty' .saasfoundry.json 2>/dev/null
}

# Does the configured sequence contain this status (case-insensitive)?
# Fail-open: with no readable manifest, every status is assumed to exist so
# the legacy 7-status behaviour is preserved.
status_in_sequence() {
  local wanted
  wanted=$(status_slug "$1")
  local sequence
  sequence=$(manifest_statuses)
  [[ -z "$sequence" ]] && return 0
  while IFS= read -r name; do
    [[ "$(status_slug "$name")" == "$wanted" ]] && return 0
  done <<< "$sequence"
  return 1
}

# Post-transition expectations banner (#436): one line for the AI, one for the
# developer, read from the target status file's `banner_ai:` / `banner_human:`
# frontmatter fields. Lives here (not in the tool CLIs) so every board tool
# (github-projects, jira, notion, linear) gets it for free. Never fails the
# transition: missing file/fields just skip the banner.
print_status_banner() {
  local status=$1
  local file_path
  file_path=$(resolve_status_file "$status")
  [[ -n "$file_path" && -f "$file_path" ]] || return 0

  local banner_ai banner_human
  banner_ai=$(sed -n 's/^banner_ai: *//p' "$file_path" | head -n 1)
  banner_human=$(sed -n 's/^banner_human: *//p' "$file_path" | head -n 1)

  [[ -n "$banner_ai" ]] && echo -e "${BLUE}▶ AI:${NC} ${banner_ai}"
  [[ -n "$banner_human" ]] && echo -e "${YELLOW}⏳ Dev:${NC} ${banner_human}"
  return 0
}

show_status_description() {
  local status=$1
  local file_path
  file_path=$(resolve_status_file "$status")

  if [[ -z "$file_path" || ! -f "$file_path" ]]; then
    echo "Unknown status: $status" >&2
    local configured
    configured=$(manifest_statuses | paste -sd ', ' -)
    if [[ -n "$configured" ]]; then
      echo "Available statuses: $configured"
    else
      echo "Available statuses: see .saasfoundry.json (workflow.statuses)"
    fi
    return 1
  fi

  cat "$file_path"
}

# ───────────────────────────────────────────────────────────────────────────
# SRS drafting guard
# ───────────────────────────────────────────────────────────────────────────
#
# A ticket tagged with any srs:drafting|srs:update|srs:new label is on the
# *drafting lifecycle*, not the code-path lifecycle. It must flow through
# `transition-drafting`, not through the code-path statuses.
#
# Block code-path targets (AI testing, Human testing, In review). Allow every
# other target (Backlog, Ready, In progress, Done). The `transition-drafting`
# command sets SF_WORKFLOW_BYPASS_SRS_GUARD=1 before routing to `update-status`
# so its own "→ Done" transition doesn't get rejected.
SRS_DRAFTING_LABELS_REGEX='^srs:(drafting|update|new)$'

is_srs_blocked_target() {
  # Fold case AND trim leading/trailing whitespace so " AI testing " is still caught
  # (copy-paste from boards often sneaks in whitespace).
  local target=$1
  local normalized
  normalized=$(echo "$target" | tr '[:upper:]' '[:lower:]' | awk '{$1=$1;print}')
  case "$normalized" in
    "ai testing"|"human testing"|"in review") return 0 ;;
  esac
  return 1
}

get_ticket_srs_label() {
  # Prints the first srs:* label on the ticket, or empty string if none.
  # Returns 0 on clean fetch (even if no label), 1 if the label fetch failed.
  local ticket=$1
  local raw
  raw=$(route_to_tool "$WORKFLOW_TOOL" get-labels "$ticket" 2>/dev/null) || return 1
  echo "$raw" | grep -E "$SRS_DRAFTING_LABELS_REGEX" | head -n1
}

check_srs_guard() {
  # Returns 0 if the caller may proceed, 1 if blocked (message already printed).
  local ticket=$1
  local target=$2

  [[ "${SF_WORKFLOW_BYPASS_SRS_GUARD:-}" == "1" ]] && return 0
  is_srs_blocked_target "$target" || return 0

  local label
  label=$(get_ticket_srs_label "$ticket") || return 0   # fail-open on fetch error — don't punish offline/auth issues

  if [[ -n "$label" ]]; then
    echo -e "${RED}✗ Ticket #${ticket} carries '${label}' — the code-path transition to '${target}' is blocked.${NC}" >&2
    echo "" >&2
    echo "  SRS tickets flow through the drafting lifecycle, not the code-path lifecycle." >&2
    echo "  Use instead:" >&2
    echo "    .claude/skills/sf-workflow/workflow-cli.sh transition-drafting ${ticket} <phase>" >&2
    echo "  Phases: ai-draft → human-review → spawning → done" >&2
    echo "  See .claude/skills/sf-workflow/statuses/3a-ai-drafting.md" >&2
    return 1
  fi
  return 0
}

# ───────────────────────────────────────────────────────────────────────────
# Complexity guard
# ───────────────────────────────────────────────────────────────────────────
#
# Every ticket must carry a `complexity: <bug|low|medium|complex>` label before
# it leaves Backlog. Without it, the adaptive workflow (analyze / plan / examine
# depth) has nothing to key off and the board ends up full of untagged tickets
# — the exact failure mode the developer flagged.
#
# The guard fires on any `update-status` whose target is NOT 'Backlog'. It
# fails open on fetch errors (same philosophy as check_srs_guard) so an offline
# gh or auth hiccup never wedges the workflow. Escape hatch:
# SF_WORKFLOW_BYPASS_COMPLEXITY_GUARD=1.

is_backlog_target() {
  local target=$1
  local normalized
  normalized=$(echo "$target" | tr '[:upper:]' '[:lower:]' | awk '{$1=$1;print}')
  [[ "$normalized" == "backlog" ]]
}

get_ticket_complexity_label() {
  # Prints the complexity level (bug|low|medium|complex) or empty if none.
  # Returns 0 on clean fetch, 1 on fetch error.
  local ticket=$1
  local raw
  raw=$(route_to_tool "$WORKFLOW_TOOL" get-labels "$ticket" 2>/dev/null) || return 1
  echo "$raw" | grep -E '^complexity: ' | head -n1 | sed 's/^complexity: //'
}

check_complexity_guard() {
  # Returns 0 if the caller may proceed, 1 if blocked (message already printed).
  local ticket=$1
  local target=$2

  [[ "${SF_WORKFLOW_BYPASS_COMPLEXITY_GUARD:-}" == "1" ]] && return 0
  is_backlog_target "$target" && return 0   # moving back to Backlog is always allowed

  local level
  level=$(get_ticket_complexity_label "$ticket") || return 0   # fail-open on fetch error

  if [[ -z "$level" ]]; then
    echo -e "${RED}✗ Ticket #${ticket} has no complexity label — cannot transition to '${target}'.${NC}" >&2
    echo "" >&2
    echo "  Every ticket must be tagged with one of: bug | low | medium | complex" >&2
    echo "  before it leaves Backlog. The adaptive workflow keys off this label." >&2
    echo "" >&2
    echo "  Fix:" >&2
    echo "    .claude/skills/sf-workflow/workflow-cli.sh detect-complexity ${ticket}" >&2
    echo "    .claude/skills/sf-workflow/workflow-cli.sh retag ${ticket} <level>" >&2
    echo "" >&2
    echo "  See .claude/skills/sf-workflow/complexity/README.md for level guidance." >&2
    echo "  Escape hatch (rare): SF_WORKFLOW_BYPASS_COMPLEXITY_GUARD=1" >&2
    return 1
  fi
  return 0
}

# ───────────────────────────────────────────────────────────────────────────
# Nature guard — Human Testing / In Review optional based on `nature:*`
# ───────────────────────────────────────────────────────────────────────────
#
# Three paths controlled by the `nature:*` label:
#   - `nature:user-facing` (or no label) → AI Testing → Human Testing → In Review → Done
#   - `nature:internal`                  → AI Testing → In Review → Done (skip Human Testing)
#   - `nature:bundled-pr`                → AI Testing → Done (skip Human Testing AND In Review)
#
# `nature:bundled-pr` is for Sub-stories of an Epic whose merge happens via the
# Epic's single bundled PR — there is no individual PR to review at this level,
# so In Review would always be a lie. See SKILL.md "Nature axis".
#
# Two firing points:
#   - `→ In Review` from AI Testing — requires `nature:internal` (or
#     `nature:bundled-pr` is rejected here, since bundled-pr should not enter
#     In Review at all).
#   - `→ Done` from AI Testing — only allowed for `nature:bundled-pr`.
#
# Fails open on label fetch errors (offline / auth) to avoid wedging the
# workflow. Escape hatch: SF_WORKFLOW_BYPASS_NATURE_GUARD=1.

is_in_review_target() {
  local target=$1
  local normalized
  normalized=$(echo "$target" | tr '[:upper:]' '[:lower:]' | awk '{$1=$1;print}')
  [[ "$normalized" == "in review" ]]
}

get_ticket_nature_label() {
  # Prints `internal`, `user-facing`, `bundled-pr`, or empty if no nature label.
  # Returns 0 on clean fetch, 1 on fetch error.
  local ticket=$1
  local raw
  raw=$(route_to_tool "$WORKFLOW_TOOL" get-labels "$ticket" 2>/dev/null) || return 1
  echo "$raw" | grep -E '^nature:' | head -n1 | sed 's/^nature://'
}

check_nature_guard() {
  # Returns 0 if the caller may proceed, 1 if blocked (message printed).
  local ticket=$1
  local target=$2

  [[ "${SF_WORKFLOW_BYPASS_NATURE_GUARD:-}" == "1" ]] && return 0

  local current_status
  current_status=$(get_current_status "$ticket" 2>/dev/null || true)
  local current_normalized
  current_normalized=$(echo "$current_status" | tr '[:upper:]' '[:lower:]' | awk '{$1=$1;print}')

  # Only fire when coming from AI Testing — Human Testing → In Review and
  # In Review → Done are the standard routes and need no nature check.
  [[ "$current_normalized" == "ai testing" ]] || return 0

  local nature
  nature=$(get_ticket_nature_label "$ticket") || return 0   # fail-open on fetch error

  if is_in_review_target "$target"; then
    # Solo-style workflows have no Human Testing status — AI Testing → In
    # Review is the standard route there and needs no nature label (the PR
    # review is the human gate).
    if ! status_in_sequence "Human Testing"; then
      if [[ "$nature" == "bundled-pr" ]]; then
        echo -e "${RED}✗ Ticket #${ticket} is 'nature:bundled-pr' — cannot enter 'In Review'.${NC}" >&2
        echo "  Bundled-PR tickets go AI Testing → Done directly (PR at the parent Epic)." >&2
        return 1
      fi
      return 0
    fi
    if [[ "$nature" == "internal" ]]; then
      return 0
    fi
    if [[ "$nature" == "bundled-pr" ]]; then
      echo -e "${RED}✗ Ticket #${ticket} is 'nature:bundled-pr' — cannot enter 'In Review'.${NC}" >&2
      echo "" >&2
      echo "  Bundled-PR tickets have no individual PR (merge happens via the parent" >&2
      echo "  Epic's single PR). They go AI Testing → Done directly." >&2
      echo "" >&2
      echo "  Move to Done instead:" >&2
      echo "    .claude/skills/sf-workflow/workflow-cli.sh update-status ${ticket} Done" >&2
      echo "" >&2
      echo "  Escape hatch (rare): SF_WORKFLOW_BYPASS_NATURE_GUARD=1" >&2
      return 1
    fi
    echo -e "${RED}✗ Ticket #${ticket} is in 'AI Testing' and lacks 'nature:internal' — cannot skip Human Testing.${NC}" >&2
    echo "" >&2
    echo "  Default workflow requires AI Testing → Human Testing → In Review." >&2
    echo "  To allow skipping Human Testing, tag the ticket as internal:" >&2
    echo "    gh issue edit ${ticket} --add-label 'nature:internal'" >&2
    echo "" >&2
    echo "  Use 'nature:internal' for refactors, scaffolding, internal tooling, or" >&2
    echo "  non-terminal stories of a multi-step Epic that ship their own PR." >&2
    echo "  Use 'nature:bundled-pr' for Subs whose PR is bundled at the Epic level." >&2
    echo "  Escape hatch (rare): SF_WORKFLOW_BYPASS_NATURE_GUARD=1" >&2
    return 1
  fi

  if is_done_target "$target"; then
    if [[ "$nature" == "bundled-pr" ]]; then
      return 0
    fi
    echo -e "${RED}✗ Ticket #${ticket} is in 'AI Testing' and lacks 'nature:bundled-pr' — cannot skip 'In Review'.${NC}" >&2
    echo "" >&2
    echo "  Default workflow goes through 'In Review' (where the PR is opened, reviewed," >&2
    echo "  and merged). Only 'nature:bundled-pr' subs may go AI Testing → Done directly." >&2
    echo "" >&2
    echo "  Either open a PR and move to In Review, or tag the ticket bundled-pr:" >&2
    echo "    gh issue edit ${ticket} --add-label 'nature:bundled-pr'" >&2
    echo "" >&2
    echo "  Escape hatch (rare): SF_WORKFLOW_BYPASS_NATURE_GUARD=1" >&2
    return 1
  fi

  return 0
}

# ───────────────────────────────────────────────────────────────────────────
# PR-merged guard — Done requires the PR to be merged
# ───────────────────────────────────────────────────────────────────────────
#
# A ticket cannot transition to Done while its PR is still open. Done means
# "shipped to <workingBranch>"; an open PR means develop doesn't have the
# commits yet, so moving to Done would create an inconsistent state. The PR
# merge event is what should trigger Done — not reviewer approval.
#
# Tickets without any PR (Epic groupers, doc-only chores) are allowed through.
# Fail-open on `gh` fetch errors (offline / auth). Escape hatch:
# SF_WORKFLOW_BYPASS_PR_MERGED_GUARD=1.

is_done_target() {
  local target=$1
  local normalized
  normalized=$(echo "$target" | tr '[:upper:]' '[:lower:]' | awk '{$1=$1;print}')
  [[ "$normalized" == "done" ]]
}

# SANITY — this regex and `.saasfoundry.json` → workflow.branchNaming must stay
# in lock-step. The match below REQUIRES a ticket number right after the prefix
# (`feature/<ticket>-…` / `fix/<ticket>-…`). The generated branchNaming defaults
# are therefore `feature/{N}-{description}` / `fix/{N}-{description}` (DEFAULT_BRANCH_NAMING
# in src/prompts/workflow.prompts.ts). If you ever drop the `{N}` ticket prefix from
# branchNaming, this guard stops matching and silently forces SF_WORKFLOW_BYPASS_*
# on every ticket. A non-regression test locks both sides together
# (src/__tests__/unit/skill/branch-naming-pr-regex.spec.ts). Do NOT change the regex
# to "fix" a mismatch — realign branchNaming instead.
get_open_pr_for_ticket() {
  # Prints the PR number of the FIRST open PR whose head branch matches
  # `feature/<ticket>-…` or `fix/<ticket>-…` (the conventions enforced by
  # `.saasfoundry.json` → workflow.branchNaming). Empty if none.
  # Returns 0 on clean fetch (even when no PR exists), 1 on fetch error.
  local ticket=$1
  local payload
  payload=$(gh pr list --state open --json number,headRefName 2>/dev/null) || return 1
  echo "$payload" | jq -r --arg t "$ticket" '
    .[] | select(.headRefName | test("^(feature|fix)/" + $t + "(-|$)")) | .number
  ' | head -n1
}

check_pr_merged_guard() {
  # Returns 0 if the caller may proceed, 1 if blocked (message printed).
  local ticket=$1
  local target=$2

  [[ "${SF_WORKFLOW_BYPASS_PR_MERGED_GUARD:-}" == "1" ]] && return 0
  is_done_target "$target" || return 0

  local pr_number
  pr_number=$(get_open_pr_for_ticket "$ticket") || return 0   # fail-open on fetch error

  if [[ -n "$pr_number" ]]; then
    echo -e "${RED}✗ Ticket #${ticket} has an open PR (#${pr_number}) — cannot transition to 'Done'.${NC}" >&2
    echo "" >&2
    echo "  An open PR means '${WORKING_BRANCH}' doesn't have the commits yet." >&2
    echo "  The PR merge event is what should trigger 'Done' — not reviewer approval." >&2
    echo "" >&2
    echo "  Current ticket should stay in 'In review'. After PR merge:" >&2
    echo "    .claude/skills/sf-workflow/workflow-cli.sh update-status ${ticket} Done" >&2
    echo "" >&2
    echo "  Escape hatch (rare): SF_WORKFLOW_BYPASS_PR_MERGED_GUARD=1" >&2
    return 1
  fi
  return 0
}

# ───────────────────────────────────────────────────────────────────────────
# PR-state guard — Human Testing requires draft; In Review requires ready.
# Unknown, malformed or ambiguous remote state fails closed. PR-less Epic
# groupers are exempt; delivery Epics carrying a PR follow its draft state.
# Escape hatch: SF_WORKFLOW_BYPASS_PR_EXISTENCE_GUARD=1.

check_pr_existence_guard() {
  local ticket=$1 target=$2 normalized
  [[ "${SF_WORKFLOW_BYPASS_PR_EXISTENCE_GUARD:-}" == "1" ]] && return 0
  normalized=$(echo "$target" | tr '[:upper:]' '[:lower:]' | awk '{$1=$1;print}')
  [[ "$normalized" == "in review" || "$normalized" == "human testing" ]] || return 0
  local nature payload matches count
  nature=$(get_ticket_nature_label "$ticket") || {
    echo "Error: unable to verify ticket nature before PR readiness transition." >&2; return 1;
  }
  if [[ "$nature" == "bundled-pr" ]]; then
    echo "Error: nature:bundled-pr tickets cannot enter Human Testing or In Review; use AI Testing → Done." >&2
    return 1
  fi
  payload=$(gh pr list --state open --limit 1000 --json number,headRefName,isDraft 2>/dev/null) || {
    echo "Error: unable to verify PR state; no status transition was made." >&2; return 1;
  }
  matches=$(echo "$payload" | jq -ce --arg t "$ticket" '
    if type == "array" then [.[] | select(.headRefName | test("^(feature|fix)/" + $t + "(-|$)"))]
    else error("Expected PR array") end') || {
    echo "Error: invalid PR response; no status transition was made." >&2; return 1;
  }
  count=$(echo "$matches" | jq length)
  if [[ "$count" -eq 0 ]]; then
    # Derived Epic groupers do not own PRs. Delivery Epics with a PR still
    # follow the same draft/readiness contract as Stories.
    local issue_type
    issue_type=$(gh api graphql -F owner='{owner}' -F name='{repo}' -F number="$ticket" \
      -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){issueType{name}}}}' 2>/dev/null \
      | jq -er '.data.repository.issue.issueType.name // empty') || issue_type=""
    [[ "$issue_type" == "sf-epic" ]] && return 0
    echo "✗ Ticket #${ticket} has no open PR — cannot transition to '$(if [[ "$normalized" == 'in review' ]]; then echo 'In Review'; else echo 'Human Testing'; fi)'." >&2
    echo "  Open a draft with workflow-cli.sh create-pr ${ticket} --draft for Human Testing." >&2
    echo "  After approval, use workflow-cli.sh ready-pr ${ticket} before In Review." >&2
    echo "  Escape hatch (rare): SF_WORKFLOW_BYPASS_PR_EXISTENCE_GUARD=1" >&2
    return 1
  fi
  if [[ "$count" -ne 1 ]] || ! echo "$matches" | jq -e '.[0].isDraft | type == "boolean"' >/dev/null; then
    echo "Error: ambiguous or unknown PR draft state; no status transition was made." >&2
    return 1
  fi
  local draft
  draft=$(echo "$matches" | jq -r '.[0].isDraft')
  if [[ "$normalized" == "human testing" && "$draft" != true ]]; then
    echo "Error: Human Testing requires an open draft PR. Convert the PR to draft before continuing." >&2
    return 1
  fi
  if [[ "$normalized" == "in review" && "$draft" != false ]]; then
    echo "Error: In Review requires a non-draft PR. After human approval run workflow-cli.sh ready-pr ${ticket}." >&2
    return 1
  fi
  return 0
}

# Function to show next status
show_next_status() {
  local current_status=$1
  local ticket=${2:-}

  local current_slug
  current_slug=$(status_slug "$current_status")

  # Build the configured sequence (manifest-driven; falls back to the team
  # preset when no manifest is readable so the command still answers).
  local sequence
  sequence=$(manifest_statuses)
  if [[ -z "$sequence" ]]; then
    sequence=$(printf '%s\n' "Backlog" "Ready" "In Progress" "AI Testing" "Human Testing" "In Review" "Done")
  fi

  local -a names=()
  while IFS= read -r name; do names+=("$name"); done <<< "$sequence"

  local idx=-1 i
  for i in "${!names[@]}"; do
    [[ "$(status_slug "${names[$i]}")" == "$current_slug" ]] && idx=$i && break
  done

  if [[ $idx -lt 0 ]]; then
    echo "Unknown status: $current_status"
    return
  fi

  if [[ $idx -ge $((${#names[@]} - 1)) ]]; then
    echo "Workflow complete - no next status"
    return
  fi

  local next="${names[$((idx + 1))]}"

  # Nature-aware branching from AI Testing: bundled-pr subs skip straight to
  # Done; internal tickets skip Human Testing when the sequence contains it.
  if [[ "$current_slug" == "ai-testing" && -n "$ticket" ]]; then
    local nature
    nature=$(get_ticket_nature_label "$ticket" 2>/dev/null || true)
    if [[ "$nature" == "bundled-pr" ]]; then
      echo "Next: Done (nature:bundled-pr — no individual PR, merge happens at the parent Epic)"
      return
    fi
    if [[ "$(status_slug "$next")" == "human-testing" && "$nature" == "internal" ]]; then
      echo "Next: In Review (nature:internal — Human Testing skipped)"
      return
    fi
  fi

  echo "Next: $next"
}

# Main command dispatcher
COMMAND=$1
shift || true

case "$COMMAND" in
  # Workflow status commands
  status)
    TICKET=$1
    if [[ -z "$TICKET" ]]; then
      echo "Usage: workflow-cli.sh status <ticket-number>" >&2
      exit 1
    fi

    STATUS=$(get_current_status "$TICKET")
    if [[ $? -ne 0 ]]; then
      exit 1
    fi

    echo "═══════════════════════════════════════════════════════════════"
    echo "Ticket #$TICKET is currently in status: $STATUS"
    echo "═══════════════════════════════════════════════════════════════"
    echo ""
    show_status_description "$STATUS"
    ;;

  next)
    TICKET=$1
    if [[ -z "$TICKET" ]]; then
      echo "Usage: workflow-cli.sh next <ticket-number>" >&2
      exit 1
    fi

    STATUS=$(get_current_status "$TICKET")
    if [[ $? -ne 0 ]]; then
      exit 1
    fi

    load_config
    echo "Current status: $STATUS"
    show_next_status "$STATUS" "$TICKET"
    ;;

  validate)
    TICKET=$1
    if [[ -z "$TICKET" ]]; then
      echo "Usage: workflow-cli.sh validate <ticket-number>" >&2
      exit 1
    fi

    echo "Validation feature not yet implemented"
    echo "Please manually verify exit conditions in the status description"
    ;;

  help)
    cat "$SKILL_DIR/SKILL.md"
    ;;

  # Complexity commands
  detect-complexity)
    TICKET=$1
    if [[ -z "$TICKET" ]]; then
      echo "Usage: workflow-cli.sh detect-complexity <ticket-number>" >&2
      exit 1
    fi
    "$SKILL_DIR/scripts/detect-complexity.sh" "$TICKET"
    ;;

  retag)
    TICKET=$1
    NEW_COMPLEXITY=$2
    if [[ -z "$TICKET" ]] || [[ -z "$NEW_COMPLEXITY" ]]; then
      echo "Usage: workflow-cli.sh retag <ticket-number> <new-complexity>" >&2
      echo "Complexity: bug | low | medium | complex" >&2
      exit 1
    fi
    echo -e "${YELLOW}Retagging ticket #${TICKET} to complexity: ${NEW_COMPLEXITY}${NC}"
    echo ""
    echo "This will adjust remaining workflow steps to match the new complexity level."
    echo ""
    # Note: Actual retagging logic depends on the tool (GitHub/Jira/Notion/Linear)
    # This command updates the complexity metadata on the ticket
    load_config
    route_to_tool "$WORKFLOW_TOOL" "set-complexity" "$TICKET" "$NEW_COMPLEXITY"
    ;;

  # Workflow phase commands (adaptive based on complexity)
  prepare)
    TICKET=$1
    COMPLEXITY=$2
    if [[ -z "$TICKET" ]] || [[ -z "$COMPLEXITY" ]]; then
      echo "Usage: workflow-cli.sh prepare <ticket-number> <complexity>" >&2
      echo "Complexity: bug | low | medium | complex" >&2
      exit 1
    fi
    echo -e "${BLUE}PREPARE PHASE: Backlog → Ready${NC}"
    echo ""
    echo "Running adaptive analyze + plan for complexity: ${COMPLEXITY}"
    echo ""
    "$SKILL_DIR/scripts/analyze.sh" "$TICKET" "$COMPLEXITY"
    echo ""
    "$SKILL_DIR/scripts/plan.sh" "$TICKET" "$COMPLEXITY"
    ;;

  test)
    TICKET=$1
    COMPLEXITY=$2
    if [[ -z "$TICKET" ]]; then
      echo "Usage: workflow-cli.sh test <ticket-number> [complexity]" >&2
      exit 1
    fi
    echo -e "${BLUE}AI TESTING PHASE: In Progress → AI Testing → next status (see \`next\`)${NC}"
    echo ""
    if [[ "$COMPLEXITY" == "complex" ]]; then
      echo "Running adversarial review (complex ticket)..."
      echo ""
      "$SKILL_DIR/scripts/examine.sh" "$TICKET"
    else
      echo "Skipping adversarial review (not complex)"
    fi
    ;;

  # Tool delegation commands - route to appropriate tool CLI
  update-status)
    load_config
    TICKET=$1
    TARGET=$2
    if [[ -z "$TICKET" || -z "$TARGET" ]]; then
      echo "Usage: workflow-cli.sh update-status <ticket> <status-name>" >&2
      exit 1
    fi
    if ! check_srs_guard "$TICKET" "$TARGET"; then
      exit 2
    fi
    if ! check_complexity_guard "$TICKET" "$TARGET"; then
      exit 2
    fi
    if ! check_nature_guard "$TICKET" "$TARGET"; then
      exit 2
    fi
    if ! check_pr_existence_guard "$TICKET" "$TARGET"; then
      exit 2
    fi
    if ! check_pr_merged_guard "$TICKET" "$TARGET"; then
      exit 2
    fi
    route_to_tool "$WORKFLOW_TOOL" update-status "$@" || exit $?
    print_status_banner "$TARGET"

    # Where the release now stands.
    #
    # `readiness` reported perfectly and was called by nothing but its own unit
    # tests, so a version filled up and nobody was ever told (#572). Closing a
    # ticket is where progress actually happens, so that is where it is said.
    #
    # It REPORTS. The transition has already succeeded above and nothing here can
    # undo it: no exit code is read, stderr is discarded, and a ticket carrying no
    # milestone produces no output at all. A milestone never blocks a release, and
    # it must not block a ticket either.
    if is_done_target "$TARGET" && milestone_supported "$WORKFLOW_TOOL"; then
      route_to_tool "$WORKFLOW_TOOL" milestone progress "$TICKET" 2>/dev/null || true
    fi
    ;;

  # ───────────────────────────────────────────────────────────────────
  # milestone — the release scope, defined in the neutral layer
  #
  # A milestone is a first-class object: creatable, renamable and
  # re-scopable at any point in a project's life. `sf srs spawn` is one
  # way to POPULATE one, never the way one comes into existence — that
  # is the whole point of #542's first requirement.
  #
  # It lives here rather than in the GitHub skill for the same reason the
  # seven statuses do: the concept is tool-neutral and each adapter
  # projects it. GitHub has native milestones, Jira has fix versions,
  # Linear has cycles, Notion has a database row. A milestone defined
  # inside one adapter would have to be reinvented for the next three.
  #
  # A version is ASSOCIATED to a milestone, never identical to it: one
  # milestone per release, and several SRS version pages may point at it.
  # The association is carried by the milestone itself, in the tool that
  # holds it — not in .saasfoundry.json. Storing it in the manifest would
  # mean a schema change and a migration for something that belongs to
  # the board, and it would go stale the moment anyone edited the
  # milestone from the tool's own UI.
  # ───────────────────────────────────────────────────────────────────
  milestone)
    load_config
    SUB=$1
    shift || true

    case "$SUB" in
      create)
        if [[ -z "${1:-}" ]]; then
          echo "Usage: workflow-cli.sh milestone create <name> [--description <text>] [--due <YYYY-MM-DD>] [--version <page-url-or-id>]" >&2
          echo "  <name> is the release, e.g. v1.0.0 — not the feature, and not the version page title." >&2
          exit 1
        fi
        ;;
      show|scope)
        if [[ -z "${1:-}" ]]; then
          echo "Usage: workflow-cli.sh milestone $SUB <name>" >&2
          exit 1
        fi
        ;;
      assign)
        if [[ -z "${1:-}" || -z "${2:-}" ]]; then
          echo "Usage: workflow-cli.sh milestone assign <ticket> <name>" >&2
          exit 1
        fi
        ;;
      associate)
        if [[ -z "${1:-}" || -z "${2:-}" ]]; then
          echo "Usage: workflow-cli.sh milestone associate <name> <version-page-url-or-id>" >&2
          echo "  Links an SRS version page to a release milestone. A milestone may carry several." >&2
          exit 1
        fi
        ;;
      readiness)
        if [[ -z "${1:-}" ]]; then
          echo "Usage: workflow-cli.sh milestone readiness <name> [--acknowledge \"<reason>\"]" >&2
          echo "  Reports where the release stands. Exits 2 while work is open — that is a" >&2
          echo "  prompt for an acknowledgement, never a refusal: re-run with --acknowledge" >&2
          echo "  and it proceeds, recording why." >&2
          exit 1
        fi
        ;;
      list|progress)
        : # no required arguments to validate here
        ;;
      ""|help)
        echo "Usage: workflow-cli.sh milestone <subcommand> [args]" >&2
        echo "" >&2
        echo "Subcommands:" >&2
        echo "  create <name> [--description <text>] [--due <date>] [--version <page>]" >&2
        echo "  list [--state open|closed|all]" >&2
        echo "  show <name>                      completion, and what is still open" >&2
        echo "  scope <name>                     the tickets it holds" >&2
        echo "  assign <ticket> <name>           put a ticket in a milestone" >&2
        echo "  associate <name> <version-page>  link an SRS version to a release" >&2
        echo "  readiness <name> [--acknowledge <reason>]   where the release stands" >&2
        echo "  progress <ticket>                where the release stands after that ticket closed" >&2
        echo "" >&2
        echo "A milestone reports; it never blocks a release. See #542." >&2
        [[ "$SUB" == "help" ]] && exit 0
        exit 1
        ;;
      *)
        echo -e "${RED}Unknown milestone subcommand: $SUB${NC}" >&2
        echo "Run: workflow-cli.sh milestone help" >&2
        exit 1
        ;;
    esac

    # Refused on purpose when the configured adapter has no milestone
    # surface — exit 2, per .claude/docs/exit-codes.md, so a caller can
    # tell "this tool cannot" from "this broke".
    if ! milestone_supported "$WORKFLOW_TOOL"; then
      echo -e "${RED}The '${WORKFLOW_TOOL}' adapter does not implement milestones yet.${NC}" >&2
      echo "Milestones are defined in the workflow layer and projected per tool." >&2
      echo "Supported today: github-projects." >&2
      exit 2
    fi

    route_to_tool "$WORKFLOW_TOOL" milestone "$SUB" "$@"
    ;;

  create-subtask|create-epic|create-pr|ready-pr|draft-pr|list|get-labels)
    load_config
    route_to_tool "$WORKFLOW_TOOL" "$COMMAND" "$@"
    ;;

  # ───────────────────────────────────────────────────────────────────
  # transition-drafting — drive a ticket through the SRS drafting arc
  #   Phases: ai-draft → human-review → spawning → done
  # ───────────────────────────────────────────────────────────────────
  transition-drafting)
    TICKET=$1
    PHASE=$2
    if [[ -z "$TICKET" || -z "$PHASE" ]]; then
      echo "Usage: workflow-cli.sh transition-drafting <ticket> <phase>" >&2
      echo "Phases: ai-draft | human-review | spawning | done" >&2
      exit 1
    fi

    load_config

    # Validate ticket is in the drafting lifecycle (has a srs:* label).
    SRS_LABEL=$(get_ticket_srs_label "$TICKET" || true)
    if [[ -z "$SRS_LABEL" ]]; then
      echo -e "${RED}✗ Ticket #${TICKET} has no srs:* label — transition-drafting does not apply.${NC}" >&2
      echo "  Apply 'srs:drafting' (or srs:update / srs:new) before running this command." >&2
      exit 2
    fi

    # Validate board state:
    #   - ai-draft / human-review / spawning require 'In progress'
    #   - done accepts 'In progress' (normal exit) or 'Done' (idempotent re-run)
    #     but rejects Backlog / Ready / … so we flag operator mistakes instead
    #     of silently short-circuiting the drafting arc.
    BOARD_STATUS=$(get_current_status "$TICKET" 2>/dev/null || true)
    BOARD_STATUS_NORMALIZED=$(echo "$BOARD_STATUS" | tr '[:upper:]' '[:lower:]')
    case "$PHASE" in
      done)
        if [[ "$BOARD_STATUS_NORMALIZED" != "in progress" && "$BOARD_STATUS_NORMALIZED" != "done" ]]; then
          echo -e "${RED}✗ Ticket #${TICKET} must be in 'In progress' (or already 'Done') before running transition-drafting done (current: ${BOARD_STATUS:-unknown}).${NC}" >&2
          exit 2
        fi
        ;;
      *)
        if [[ "$BOARD_STATUS_NORMALIZED" != "in progress" ]]; then
          echo -e "${RED}✗ Ticket #${TICKET} must be in 'In progress' before running transition-drafting ${PHASE} (current: ${BOARD_STATUS:-unknown}).${NC}" >&2
          exit 2
        fi
        ;;
    esac

    SRS_CLI=".claude/skills/sf-srs/scripts/srs-cli.sh"
    case "$PHASE" in
      ai-draft)
        echo -e "${BLUE}→ AI drafting phase for #${TICKET} (label: ${SRS_LABEL})${NC}"
        if [[ ! -x "$SRS_CLI" ]]; then
          echo -e "${RED}✗ Expected ${SRS_CLI} to be executable. Run the SRS skill install first.${NC}" >&2
          exit 2
        fi
        "$SRS_CLI" draft --ticket "$TICKET" || exit $?
        print_status_banner "drafting:ai-draft"
        ;;
      human-review)
        echo -e "${BLUE}→ Human review phase for #${TICKET}${NC}"
        echo "  Post a review checklist comment on the ticket and wait for the owner's approval."
        echo "  The Notion page URL should already be in the ticket (posted by the AI draft phase)."
        echo "  No automated action — this phase is driven by the human reviewer."
        print_status_banner "drafting:human-review"
        ;;
      spawning)
        echo -e "${BLUE}→ Spawning phase for #${TICKET}${NC}"
        if [[ ! -x "$SRS_CLI" ]]; then
          echo -e "${RED}✗ Expected ${SRS_CLI} to be executable. Run the SRS skill install first.${NC}" >&2
          exit 2
        fi
        "$SRS_CLI" spawn --ticket "$TICKET" || exit $?
        print_status_banner "drafting:spawning"
        ;;
      done)
        echo -e "${BLUE}→ Closing drafting ticket #${TICKET}${NC}"
        SF_WORKFLOW_BYPASS_SRS_GUARD=1 route_to_tool "$WORKFLOW_TOOL" update-status "$TICKET" "Done" || exit $?
        print_status_banner "Done"
        ;;
      *)
        echo -e "${RED}✗ Unknown phase '${PHASE}'${NC}" >&2
        echo "  Phases: ai-draft | human-review | spawning | done" >&2
        exit 1
        ;;
    esac
    ;;

  "")
    echo -e "${RED}Error: No command specified${NC}"
    echo ""
    echo "Usage: workflow-cli.sh <command> [args...]"
    echo ""
    echo "Workflow status commands:"
    echo "  status <ticket>              Display current status and its description"
    echo "  next <ticket>                Show next status"
    echo "  validate <ticket>            Validate exit conditions"
    echo "  help                         Display skill documentation"
    echo ""
    echo "Complexity commands:"
    echo "  detect-complexity <ticket>   Auto-suggest complexity level"
    echo "  retag <ticket> <complexity>  Change ticket complexity"
    echo ""
    echo "Workflow phase commands (complexity-adaptive):"
    echo "  prepare <ticket> <complexity>    Run analyze + plan (Backlog → Ready)"
    echo "  test <ticket> [complexity]       Run validation + examine (→ AI Testing)"
    echo ""
    echo "SRS drafting lifecycle (for tickets tagged srs:drafting|srs:update|srs:new):"
    echo "  transition-drafting <ticket> <phase>"
    echo "    phase: ai-draft | human-review | spawning | done"
    echo "    Dispatches to .claude/skills/sf-srs/scripts/srs-cli.sh for draft/spawn."
    echo ""
    echo "Tool commands (delegated to tool-specific CLI):"
    echo "  create-subtask ...           Create a sub-issue/task"
    echo "  create-epic <title> [body]   Create a top-level Epic (no parent)"
    echo "  update-status ...            Update ticket status (SRS-label guarded)"
    echo "  create-pr <ticket> [--draft]  Create pull request"
    echo "  ready-pr <ticket>            Mark pull request ready for review"
    echo "  draft-pr <ticket>            Return pull request to draft"
    echo "  list ...                     List tickets"
    echo "  get-labels <ticket>          List every label on a ticket"
    exit 1
    ;;

  *)
    echo -e "${RED}Error: Unknown command '${COMMAND}'${NC}"
    echo ""
    echo "Available commands: status, next, validate, help, detect-complexity, retag, prepare, test, create-subtask, update-status, create-pr, ready-pr, draft-pr, list, get-labels, transition-drafting"
    echo "Run 'workflow-cli.sh help' for usage details"
    exit 1
    ;;
esac
