#!/bin/bash

# Script to auto-suggest complexity level for a ticket
# Usage: detect-complexity.sh <ticket-number>

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m' # No Color

# Check arguments
if [[ $# -lt 1 ]]; then
  echo "Usage: detect-complexity.sh <ticket-number>" >&2
  exit 1
fi

TICKET_NUMBER=$1

# Load configuration
if [[ ! -f ".saasfoundry.json" ]]; then
  echo -e "${RED}Error: .saasfoundry.json not found${NC}" >&2
  exit 1
fi

WORKFLOW_TOOL=$(jq -r '.workflow.tool // empty' .saasfoundry.json)

if [[ -z "$WORKFLOW_TOOL" ]]; then
  echo -e "${RED}Error: No workflow tool configured${NC}" >&2
  exit 1
fi

# Get tool CLI path
get_tool_cli() {
  local tool=$1
  if [[ -d "apps" ]]; then
    echo "./.claude/skills/sf-tool-${tool}/${tool}-cli.sh"
  else
    echo "./.claude/skills/sf-tool-${tool}/${tool}-cli.sh"
  fi
}

TOOL_CLI=$(get_tool_cli "$WORKFLOW_TOOL")

if [[ ! -f "$TOOL_CLI" ]]; then
  # Fallback to user's global skills
  TOOL_CLI="$HOME/.claude/skills/tool-${WORKFLOW_TOOL}/${WORKFLOW_TOOL}-cli.sh"
  if [[ ! -f "$TOOL_CLI" ]]; then
    echo -e "${RED}Error: Tool CLI not found${NC}" >&2
    exit 1
  fi
fi

chmod +x "$TOOL_CLI" 2>/dev/null || true

echo -e "${BLUE}Analyzing ticket #${TICKET_NUMBER}...${NC}"
echo ""

# Get ticket details via tool CLI
TICKET_DATA=$("$TOOL_CLI" get-ticket "$TICKET_NUMBER" 2>&1)

if [[ $? -ne 0 ]]; then
  echo -e "${RED}Error fetching ticket${NC}" >&2
  echo "$TICKET_DATA" >&2
  exit 1
fi

# Extract title and description
TITLE=$(echo "$TICKET_DATA" | grep "^Title:" | sed 's/^Title: //')
DESCRIPTION=$(echo "$TICKET_DATA" | grep -A 100 "^Description:" | tail -n +2)

echo -e "${PURPLE}Title:${NC} $TITLE"
echo ""

# Complexity scoring
SCORE=0
REASONS=()

# Check for bug keywords
if echo "$TITLE $DESCRIPTION" | grep -iE "(bug|fix|error|broken|issue|regression)" >/dev/null; then
  REASONS+=("🐛 Bug-related keywords detected")
  SCORE=$((SCORE - 10))  # Negative score = lower complexity
fi

# Check for simple keywords
if echo "$TITLE $DESCRIPTION" | grep -iE "(typo|doc|readme|comment|rename|format)" >/dev/null; then
  REASONS+=("🟢 Simple task keywords detected")
  SCORE=$((SCORE - 5))
fi

# Check for complex/critical keywords
if echo "$TITLE $DESCRIPTION" | grep -iE "(auth|security|payment|oauth|encryption|migration|refactor)" >/dev/null; then
  REASONS+=("🔴 Complex/critical keywords detected")
  SCORE=$((SCORE + 15))
fi

# Check for integration keywords
if echo "$TITLE $DESCRIPTION" | grep -iE "(integration|api|third-party|service|webhook)" >/dev/null; then
  REASONS+=("🟡 Integration keywords detected")
  SCORE=$((SCORE + 5))
fi

# Estimate file impact based on description length and detail
DESC_LENGTH=${#DESCRIPTION}
if [[ $DESC_LENGTH -gt 500 ]]; then
  REASONS+=("📝 Detailed description suggests multiple components")
  SCORE=$((SCORE + 5))
fi

# Check for multi-file indicators
if echo "$DESCRIPTION" | grep -iE "(frontend|backend|database|api|ui)" | wc -l | grep -E "[2-9]|[1-9][0-9]" >/dev/null; then
  REASONS+=("📦 Multiple layers/components mentioned")
  SCORE=$((SCORE + 5))
fi

# Determine complexity based on score
if [[ $SCORE -le -5 ]]; then
  SUGGESTED="bug"
  LABEL="🐛 Bug Fix"
  COLOR=$RED
elif [[ $SCORE -le 5 ]]; then
  SUGGESTED="low"
  LABEL="🟢 Low Complexity"
  COLOR=$GREEN
elif [[ $SCORE -le 15 ]]; then
  SUGGESTED="medium"
  LABEL="🟡 Medium Complexity"
  COLOR=$YELLOW
else
  SUGGESTED="complex"
  LABEL="🔴 Complex / Critical"
  COLOR=$PURPLE
fi

# Display analysis
echo -e "${YELLOW}Analysis:${NC}"
for reason in "${REASONS[@]}"; do
  echo "  - $reason"
done
echo ""

echo -e "${COLOR}Suggested Complexity: ${LABEL}${NC}"
echo ""

# Load complexity config
CONFIG_FILE="$SKILL_DIR/complexity/${SUGGESTED}.yml"
if [[ -f "$CONFIG_FILE" ]]; then
  DESCRIPTION=$(grep "^description:" "$CONFIG_FILE" | sed 's/^description: "\(.*\)"/\1/')
  echo -e "${BLUE}What this means:${NC} $DESCRIPTION"
  echo ""
fi

# Output as JSON for programmatic use
echo ""
echo -e "${BLUE}JSON Output:${NC}"
echo "{\"suggested\": \"$SUGGESTED\", \"label\": \"$LABEL\", \"score\": $SCORE}"

exit 0
