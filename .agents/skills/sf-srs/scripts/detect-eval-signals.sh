#!/bin/bash
# detect-eval-signals.sh — conversational eval hook helper (SUB-10 companion).
#
# The sf-srs skill reads this script (not SKILL.md prose) when it needs to decide
# whether a conversation turn carries a new SRS signal worth proposing via
# `srs-cli.sh apply-update`. The script ships two modes:
#
#   --rules         Emit the detection rules + patch shape as JSON on stdout.
#                   The agent loads this once per session and reasons against it.
#                   This is the deterministic source of truth — SKILL.md only
#                   points here.
#
#   --classify      Apply crude regex heuristics to a turn (text on stdin or as
#                   a single argument) and emit {signal, confidence, target}.
#                   Intended as a prefilter — the agent still has the final say,
#                   but a low-confidence classification saves a round of thought
#                   on trivial turns.
#
# Exit codes: 0 = clean output on stdout. 2 = bad input / unknown mode.
#
# The regex layer is intentionally conservative: false negatives (skip a real
# signal) are cheaper than false positives (interrupt the user on a trivial
# turn). Edit the rules JSON when the taxonomy shifts; edit the classifier
# regexes only to tighten or widen a single signal row.

set -euo pipefail

usage() {
  cat >&2 <<EOF
Usage: detect-eval-signals.sh [--rules | --classify [<text>]]

Modes:
  --rules                Emit detection rules + patch shape as JSON.
  --classify [<text>]    Classify a turn. Reads stdin if <text> omitted.

Output (classify): one JSON object
  {"signal":"ur|fr|ds|tc|revision|trivial|none","confidence":"low|medium","target":"..."}
EOF
}

emit_rules() {
  cat <<'JSON'
{
  "$schema": "https://raw.githubusercontent.com/DiamondForgeFr/SaasFoundryAI/master/schemas/detect-eval-signals-rules.schema.json",
  "description": "Detection heuristics + patch shape for the sf-srs conversational eval hook. SKILL.md points here; edit JSON, not prose.",
  "precondition": {
    "manifest_key": "tools.srs.enabled",
    "expected_value": true,
    "behavior_when_disabled": "Do nothing — the hook is dormant until the SRS module is installed."
  },
  "throttle": {
    "max_proposals_per_turn": 1,
    "dedup_window": "conversation-turn boundary (no persistent cache)"
  },
  "trivial_skip": [
    "pure tool invocations",
    "'ok' / 'thanks' / acknowledgements",
    "'read X' / 'show me Y' / 'what does this do'",
    "formatting nitpicks",
    "small bug reports already covered by an existing FR",
    "performance tweaks without observable user impact",
    "pure refactor requests"
  ],
  "signals": [
    {
      "id": "ur",
      "meaning": "Describes a user need / outcome",
      "target": "new UR on the Epic page",
      "patch_kind": "add-ur",
      "example": "users should be able to log in with SSO",
      "regex_hints": [
        "(?i)\\busers? (should|need|want|must)\\b",
        "(?i)\\bas a [a-z ]+,? i (want|need)\\b",
        "(?i)\\bl'utilisateur (doit|veut|a besoin)\\b"
      ]
    },
    {
      "id": "fr",
      "meaning": "Defines a new feature or rule",
      "target": "new FR page under the Epic",
      "patch_kind": "add-fr",
      "example": "we need a feature that lets admins export audit logs as CSV",
      "regex_hints": [
        "(?i)\\b(new feature|add a feature|feature that|functionality to)\\b",
        "(?i)\\b(allow|enable|support) [a-z]+ to\\b",
        "(?i)\\bon (doit|veut) (pouvoir|permettre)\\b"
      ]
    },
    {
      "id": "ds",
      "meaning": "Clarifies an implementation decision",
      "target": "new DS on the relevant FR page",
      "patch_kind": "add-ds",
      "example": "let's use BCrypt with cost factor 12 for password hashing",
      "regex_hints": [
        "(?i)\\b(let's use|we('ll| will) use|on va utiliser)\\b",
        "(?i)\\b(decision|choix technique|on part sur)\\b",
        "(?i)\\b(implemented? with|via|using) [A-Z][a-z]"
      ]
    },
    {
      "id": "tc",
      "meaning": "Adds an acceptance / test condition",
      "target": "new TC on the relevant FR page",
      "patch_kind": "add-tc",
      "example": "and a test that proves unicode passwords are accepted",
      "regex_hints": [
        "(?i)\\b(a test that|test case|we should test|assert that|il faut tester)\\b",
        "(?i)\\b(acceptance criteri(on|a)|given .* when .* then)\\b"
      ]
    },
    {
      "id": "revision",
      "meaning": "Reopens a previously closed decision",
      "target": "likely an FR or DS revision",
      "patch_kind": "add-ds",
      "note": "v1 is ADD-only — propose an appended item documenting the reversal rather than modifying the existing one in place.",
      "example": "on reconsidère la règle : finalement on autorise les chiffres",
      "regex_hints": [
        "(?i)\\b(reconsider|revisit|on change d'avis|finalement on)\\b",
        "(?i)\\b(actually|in fact|scratch that)\\b"
      ]
    }
  ],
  "confirmation_flow": {
    "before_coding": true,
    "prompt_template": [
      "💡 Ce que tu viens de décrire ressemble à <UR / FR / DS / TC>. Proposition :",
      "  • <target page> — add <item id> : <narrative | title>",
      "  • (if TC)        steps : ...",
      "",
      "J'applique via `srs-cli.sh apply-update` ? [accept / edit / reject]"
    ],
    "branches": {
      "accept": "build patch JSON (see shape below) and run `.claude/skills/sf-srs/scripts/srs-cli.sh apply-update < patch.json` (or pipe via stdin). On exit 0, continue with the coding task.",
      "edit": "rework the proposed item text with the user, then re-confirm.",
      "reject": "drop the proposal and continue. Do NOT re-propose the same item in the same conversation."
    }
  },
  "patch_shape": {
    "kind": "add-ur | add-fr | add-ds | add-tc",
    "pageId": "<epic page id for add-ur / add-fr, FR page id for add-ds / add-tc>",
    "item": "UrItem | FrSpec | DsItem | TcItem — same shapes as src/builders/srs/types.ts",
    "note": "optional free-text annotation appended as a paragraph"
  },
  "scope_limits_v1": {
    "add_only": "Modifying an existing item (e.g. tightening FR-012) is out of scope — SrsAdapter.updatePage is append-only on Notion. A follow-up SUB will extend the adapter with replace/delete semantics.",
    "append_placement": "add-ur / add-ds / add-tc append new blocks to the END of the target page under an 'Added …' heading2. The canonical section (User Requirements / Design / Test Cases) is NOT updated in-place. Reviewers fold the appended block back during the next human SRS review.",
    "add_fr": "Creates a brand-new child page under the Epic via adapter.createFrPage. The Epic page's 'Traceability' table is NOT refreshed (same append-only limitation) — the new FR is still discoverable as a child page."
  },
  "dogfood_checklist": "After any change to the rules, run a short manual session: drop 5 utterances (one per signal row + one trivial control) and confirm the hook fires exactly on the four signals and skips the trivial one."
}
JSON
}

classify_text() {
  local text="$1"
  local lowered
  lowered=$(echo "$text" | tr '[:upper:]' '[:lower:]')

  # Trivial short-circuit — common acknowledgements and noise.
  # Fail-closed so an empty / ack turn does not fire a proposal.
  if [[ -z "${text//[[:space:]]/}" ]]; then
    echo '{"signal":"none","confidence":"medium","target":"empty turn"}'
    return 0
  fi
  if [[ "$lowered" =~ ^(ok|okay|thanks?|ok[[:space:]]+thanks?|thx|merci|ty|yes|no|yep|nope|got[[:space:]]+it|sounds[[:space:]]+good|lgtm)[[:punct:][:space:]]*$ ]]; then
    echo '{"signal":"trivial","confidence":"medium","target":"acknowledgement"}'
    return 0
  fi
  if [[ "$lowered" =~ ^(read |show me |what does |explain |describe |montre-moi |montre moi |explique |peux-tu |peux tu |qu\'est-ce que |qu\ est-ce que ) ]]; then
    echo '{"signal":"trivial","confidence":"low","target":"read-only request"}'
    return 0
  fi

  # TC wins over FR when both match — explicit acceptance criteria are rarer
  # and more specific than a general feature ask.
  if [[ "$lowered" =~ (a\ test\ that|test\ case|we\ should\ test|assert\ that|il\ faut\ tester|acceptance\ criteri(on|a)|given.*when.*then) ]]; then
    echo '{"signal":"tc","confidence":"medium","target":"new TC on the relevant FR page"}'
    return 0
  fi

  # DS — "let's use X", "we'll use X", technical choice language.
  if [[ "$lowered" =~ (let\'s\ use|we\'ll\ use|we\ will\ use|on\ va\ utiliser|on\ part\ sur|implemented\ with|implemented\ via|decision:) ]]; then
    echo '{"signal":"ds","confidence":"medium","target":"new DS on the relevant FR page"}'
    return 0
  fi

  # FR — feature/rule language. Checked BEFORE revision so a "actually, can we
  # also add feature X" mid-task pivot is not swallowed by the revision marker.
  if [[ "$lowered" =~ (new\ feature|add\ a\ feature|feature\ that|functionality\ to|allow\ .*\ to|enable\ .*\ to|support\ .*\ to|on\ doit\ pouvoir|on\ veut\ permettre|il\ faut\ une\ fonctionnalité|fonctionnalité\ pour) ]]; then
    echo '{"signal":"fr","confidence":"medium","target":"new FR page under the Epic"}'
    return 0
  fi

  # UR — user-need language. `as an? <role> i (want|need)` covers both "as a
  # user I want" and "as an admin I want".
  if [[ "$lowered" =~ (users?\ (should|need|want|must)|as\ an?\ [a-z\ ]+\ i\ (want|need)|l\'utilisateur\ (doit|veut|a\ besoin)) ]]; then
    echo '{"signal":"ur","confidence":"medium","target":"new UR on the Epic page"}'
    return 0
  fi

  # Revision markers — reopening a closed decision. Checked LAST so that
  # explicit FR / UR / DS / TC content in the same turn wins.
  if [[ "$lowered" =~ (reconsider|revisit|on\ change\ d\'avis|finalement\ on|actually|in\ fact|scratch\ that) ]]; then
    echo '{"signal":"revision","confidence":"low","target":"FR or DS revision (ADD-only in v1)"}'
    return 0
  fi

  echo '{"signal":"none","confidence":"low","target":"no matching heuristic — agent may still judge manually"}'
}

MODE=${1:---rules}
shift || true

case "$MODE" in
  --rules)
    emit_rules
    ;;
  --classify)
    if [[ $# -gt 0 ]]; then
      classify_text "$*"
    else
      TEXT=$(cat)
      classify_text "$TEXT"
    fi
    ;;
  -h|--help)
    usage
    ;;
  *)
    usage
    exit 2
    ;;
esac
