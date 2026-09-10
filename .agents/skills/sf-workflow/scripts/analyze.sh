#!/bin/bash

# Adaptive analysis script based on complexity level
# Extracted from apex step-01-analyze.md
# Usage: analyze.sh <ticket-number> <complexity>

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# This script is meant to be called by Claude, not executed directly
# It provides guidance on how to perform analysis based on complexity

if [[ $# -lt 2 ]]; then
  echo "Usage: analyze.sh <ticket-number> <complexity>" >&2
  echo "Complexity: bug | low | medium | complex" >&2
  exit 1
fi

TICKET=$1
COMPLEXITY=$2

# Load complexity config
CONFIG_FILE="$SKILL_DIR/complexity/${COMPLEXITY}.yml"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: Unknown complexity level: $COMPLEXITY" >&2
  exit 1
fi

# Extract configuration
ANALYZE_ENABLED=$(grep -A 10 "^  analyze:" "$CONFIG_FILE" | grep "enabled:" | awk '{print $2}')
ANALYZE_DEPTH=$(grep -A 10 "^  analyze:" "$CONFIG_FILE" | grep "depth:" | awk '{print $2}' | tr -d '"')
ANALYZE_AGENTS=$(grep -A 10 "^  analyze:" "$CONFIG_FILE" | grep "agents:" | awk '{print $2}')

# Display guidance
echo "==================================================================="
echo " ANALYZE PHASE - Complexity: $COMPLEXITY"
echo "==================================================================="
echo ""

if [[ "$ANALYZE_ENABLED" == "false" ]]; then
  echo "✓ Analysis SKIPPED for this complexity level"
  echo ""
  echo "Proceed directly to implementation."
  exit 0
fi

echo "Depth: $ANALYZE_DEPTH"
echo "Agents: $ANALYZE_AGENTS"
echo ""

# Provide specific guidance based on complexity
case "$COMPLEXITY" in
  low)
    cat <<'EOF'
MINIMAL ANALYSIS (Oneshot-style):

1. **NO parallel agents** - use direct tools only
   - Use Glob to find 2-3 key files by pattern
   - Use Grep to search for specific code patterns
   - Quick Read of relevant files

2. **What to find:**
   - Where the change needs to be made
   - Existing pattern to follow
   - Any utilities already available

3. **What NOT to do:**
   - NO exploration tours
   - NO deep research
   - NO multiple file reads
   - Find examples and MOVE ON

4. **Output:**
   - 2-3 key file paths
   - Pattern to follow (one example)
   - Ready to implement

EOF
    ;;

  medium)
    cat <<'EOF'
STANDARD ANALYSIS (Apex-free-style):

1. **Launch 2-4 parallel exploration agents:**
   ```
   /task explore-codebase "find existing {feature} implementation patterns"
   /task explore-codebase "locate {module} files and utilities"
   /task explore-docs "research {library} API for {feature}"
   ```

2. **What to find:**
   - Existing files, patterns, utilities
   - How similar features are implemented
   - Dependencies and imports
   - Error handling patterns
   - Test file locations

3. **Document findings:**
   - File paths with line numbers (file:123)
   - Code patterns to follow
   - Utilities to reuse
   - Dependencies to add

4. **Output:**
   - Comprehensive context for planning
   - Clear understanding of what exists
   - Identified integration points

EOF
    ;;

  complex)
    cat <<'EOF'
DEEP ANALYSIS (Full Apex):

1. **ULTRA THINK first:**
   - What information do I actually need?
   - Which agents will provide maximum value?
   - What are the unknowns and risks?

2. **Launch 6-10 parallel agents (BE SMART - don't blindly launch all):**
   ```
   # Codebase exploration (3-4 agents)
   /task explore-codebase "find {feature} implementation patterns"
   /task explore-codebase "locate {module} architecture and structure"
   /task explore-codebase "search for {utility} helpers and services"
   /task explore-codebase "identify {integration} points and dependencies"

   # Documentation research (2-3 agents)
   /task explore-docs "research {library} {feature} API and patterns"
   /task explore-docs "find {framework} best practices for {use-case}"

   # Web research (1-2 agents if needed)
   /task websearch "best practices for {technology} {feature}"
   /task websearch "{library} {feature} security considerations"
   ```

3. **What to find:**
   - ALL relevant files, patterns, utilities
   - Architectural decisions and constraints
   - Security considerations (OWASP relevance)
   - Performance implications
   - Edge cases and error scenarios
   - Test coverage requirements
   - Dependencies and version compatibility

4. **Document findings:**
   - Detailed file paths with line numbers
   - Code patterns with explanations
   - Utilities and their purposes
   - Dependencies to add/update
   - Security risks identified
   - Performance bottlenecks
   - Edge cases to handle

5. **Output:**
   - Comprehensive analysis report
   - Clear understanding of entire system
   - Risk assessment
   - Ready for detailed planning

EOF
    ;;

  *)
    echo "Unknown complexity: $COMPLEXITY"
    exit 1
    ;;
esac

echo ""
echo "==================================================================="
echo ""

# Return configuration as JSON for Claude to process
echo "{\"enabled\": $ANALYZE_ENABLED, \"depth\": \"$ANALYZE_DEPTH\", \"agents\": $ANALYZE_AGENTS}"

exit 0
