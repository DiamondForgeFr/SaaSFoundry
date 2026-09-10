#!/usr/bin/env bash
# sf-srs orchestrator — single entrypoint for every skill that hands off to SRS work.
# Body grows as sibling SUBs under #174 land ; this revision implements
# `help`, `validate`, `browse`, `draft`, `write`, `spawn`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage: srs-cli.sh <action> [args...]

Actions:
  help                              Print this message
  validate [manifest]               Smoke-test the configured backend via adapter.init()
  browse --parent <id> [--manifest] List direct children of a parent page (JSON)
  draft --from notion-pages --ids <id1,id2,...> [--manifest]
                                    Fetch pages from the backend as RawContent (JSON).
                                    The skill then drafts Epic/FR specs conversationally
                                    and hands them back via `write`.
  draft --from codebase [--path <dir>] [--manifest]
                                    Scan the local codebase and emit structured
                                    findings (JSON). The skill then drafts Epic/FR
                                    specs conversationally from the findings and
                                    hands them back via `write`. Scanners plug in
                                    via sibling SUBs under #173 (13.2 + 13.3).
  write  --spec <path> [--manifest] [--no-clear-pending]
                                    Apply a DraftCandidate[] spec file : creates Epic /
                                    FR pages through the adapter and clears the
                                    `tools.srs.pendingIngestion` flag on success.
  spawn  --epic <page-url-or-id> [--ticket <n>] [--version <title-url-or-id>] [--dry-run] [--manifest] [--bypass-reason <text>]
  normalize [--feature <url-or-id>] [--version-name <name>] [--apply] [--manifest] [--root-page <id>]
                                    Give an unversioned feature a version page and
                                    MOVE its FR pages under it (ids and URLs survive).
                                    Dry-run by default; --apply is required to write.
                                    Enumerate FR page children of a drafted Epic and
                                    create a Story sub-ticket per FR under the parent
                                    ticket. Each child is created as a GitHub
                                    sub-issue tagged `srs:new`; board placement
                                    follows the project's default automation.
                                    `--dry-run` previews without writing.
  apply-update [--patch <path>] [--manifest]
                                    Apply a conversational eval-hook patch
                                    (ADD-only : new UR / new FR / new DS / new TC)
                                    to the configured backend. Reads patch JSON
                                    from stdin when --patch is omitted. Used by
                                    the `sf-srs` eval hook after user accepts
                                    the proposed diff — see SKILL.md.
  eval  [--path <dir>] [--root-page <id>] [--threshold <pct>] [--json] [--manifest]
                                    Score SRS freshness vs. codebase (batch).
                                    Lists FR pages under the configured root,
                                    runs the scanners, and reports drift
                                    findings (FR pages with no matching code,
                                    code areas with no FR, untested FRs).
                                    Exit 0 when overall score >= threshold,
                                    1 otherwise. --json emits the structured
                                    report for CI consumption.

Common options :
  --manifest <path>                 Manifest file to read (default: .saasfoundry.json)

Exit codes (shared contract) :
  0 success · 2 bad input · 3 missing backend · 4 unknown backend · 5 runtime ·
  6 write partial (rollbackHint) · 7 write ok but pendingIngestion clear failed

Dispatch reads `tools.srs.backend` from `.saasfoundry.json` and routes through
the matching SrsAdapter. See .claude/skills/sf-srs/SKILL.md for the contract.
EOF
}

# Directories that may hold the dispatch library, nearest first.
#
# Two ancestries are searched, because neither alone is sufficient: the skill can
# be invoked from anywhere (so SCRIPT_DIR anchors it to the project it was
# installed into), and a monorepo puts node_modules above the working directory
# (so PWD's ancestors matter too).
candidate_roots() {
  local dir
  for dir in "$SCRIPT_DIR" "$PWD"; do
    while [[ "$dir" != "/" && -n "$dir" ]]; do
      echo "$dir"
      dir="$(dirname "$dir")"
    done
  done
}

# Resolve the entrypoint for an action across the three real layouts:
#
#   dist/srs/bin/<bin>.js                              this checkout, built
#   src/srs/bin/<bin>.ts                               this checkout, via tsx
#   node_modules/saasfoundryai-cli/dist/srs/bin/*.js   a generated project
#
# The last one is the layout every user has and the one this resolver used to
# ignore entirely, which made the skill's documented entrypoint fail in every
# generated project while working perfectly in the only place we ever ran it.
#
# Prints "<mode>:<path>" — mode `node` runs the JS directly, mode `tsx` runs the
# TS source from the checkout root.
resolve_entrypoint() {
  local bin="$1" dir
  while read -r dir; do
    if [[ -f "$dir/dist/srs/bin/$bin.js" ]]; then
      echo "node:$dir/dist/srs/bin/$bin.js"
      return 0
    fi
    if [[ -f "$dir/src/srs/bin/$bin.ts" ]]; then
      echo "tsx:$dir"
      return 0
    fi
    if [[ -f "$dir/node_modules/saasfoundryai-cli/dist/srs/bin/$bin.js" ]]; then
      echo "node:$dir/node_modules/saasfoundryai-cli/dist/srs/bin/$bin.js"
      return 0
    fi
    dir=""
  done < <(candidate_roots)
  return 1
}

# Run an entrypoint. $1 = bin basename (no extension), $2+ = forwarded args.
run_bin() {
  local bin="$1"
  shift
  local resolved
  if ! resolved="$(resolve_entrypoint "$bin")"; then
    echo "sf-srs $bin: could not locate the SRS dispatch library." >&2
    echo "  Searched, from this script and from the working directory upwards:" >&2
    echo "    dist/srs/bin/$bin.js" >&2
    echo "    src/srs/bin/$bin.ts" >&2
    echo "    node_modules/saasfoundryai-cli/dist/srs/bin/$bin.js" >&2
    echo "  In a project: install the CLI (npm i -D saasfoundryai-cli)." >&2
    echo "  In the SaaSFoundryAI checkout: run npm run build." >&2
    echo "  Or use the CLI directly: sf srs $bin" >&2
    exit 1
  fi

  local mode="${resolved%%:*}"
  local target="${resolved#*:}"

  if [[ "$mode" == "node" ]]; then
    node "$target" "$@"
    return
  fi

  if ! command -v npx >/dev/null 2>&1; then
    echo "sf-srs $bin: node and npx must be on PATH to run the TS entrypoint." >&2
    exit 1
  fi
  if ! (cd "$target" && npx --no-install tsx --version >/dev/null 2>&1); then
    echo "sf-srs $bin: tsx is not installed in $target — run 'npm install' there, or 'npm run build' to use the dist/ entrypoint." >&2
    exit 1
  fi
  (cd "$target" && npx --no-install tsx "src/srs/bin/$bin.ts" "$@")
}

run_validate() { run_bin validate "${1:-.saasfoundry.json}"; }

run_browse() { run_bin browse-tree "$@"; }

run_write() { run_bin write-srs "$@"; }

run_spawn() { run_bin spawn "$@"; }

run_normalize() { run_bin normalize "$@"; }

run_apply_update() { run_bin apply-srs-update "$@"; }

run_eval() { run_bin eval-srs "$@"; }

run_draft() {
  # `--from <source>` selects which drafter to invoke ; default = notion-pages.
  local source="notion-pages"
  local forwarded=()
  while (( "$#" )); do
    case "$1" in
      --from) source="${2:?--from requires a value}"; shift 2 ;;
      --from=*) source="${1#--from=}"; shift ;;
      *) forwarded+=("$1"); shift ;;
    esac
  done
  case "$source" in
    notion-pages) run_bin draft-from-notion-pages ${forwarded[@]+"${forwarded[@]}"} ;;
    codebase) run_bin draft-from-codebase ${forwarded[@]+"${forwarded[@]}"} ;;
    *)
      echo "sf-srs draft: unknown --from value '$source' (expected: notion-pages | codebase)." >&2
      exit 1
      ;;
  esac
}

ACTION="${1:-help}"
shift || true

case "$ACTION" in
  help|-h|--help) usage ;;
  validate) run_validate "$@" ;;
  browse) run_browse "$@" ;;
  draft) run_draft "$@" ;;
  write) run_write "$@" ;;
  spawn) run_spawn "$@" ;;
  normalize) run_normalize "$@" ;;
  apply-update) run_apply_update "$@" ;;
  eval) run_eval "$@" ;;
  *)
    echo "sf-srs: unknown action '$ACTION'" >&2
    usage
    exit 1
    ;;
esac
