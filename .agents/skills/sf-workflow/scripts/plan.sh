#!/bin/bash

# Adaptive planning script based on complexity level
# Extracted from apex step-02-plan.md
# Usage: plan.sh <ticket-number> <complexity>

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $# -lt 2 ]]; then
  echo "Usage: plan.sh <ticket-number> <complexity>" >&2
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
PLAN_ENABLED=$(grep -A 10 "^  plan:" "$CONFIG_FILE" | grep "enabled:" | awk '{print $2}')
PLAN_DEPTH=$(grep -A 10 "^  plan:" "$CONFIG_FILE" | grep "depth:" | awk '{print $2}' | tr -d '"')
PLAN_APPROVAL=$(grep -A 10 "^  plan:" "$CONFIG_FILE" | grep "approval:" | awk '{print $2}')

echo "==================================================================="
echo " PLAN PHASE - Complexity: $COMPLEXITY"
echo "==================================================================="
echo ""

if [[ "$PLAN_ENABLED" == "false" ]]; then
  echo "✓ Planning SKIPPED for this complexity level"
  echo ""
  echo "Proceed directly to implementation."
  exit 0
fi

echo "Depth: $PLAN_DEPTH"
echo "Approval required: $PLAN_APPROVAL"
echo ""

case "$COMPLEXITY" in
  low)
    cat <<'EOF'
MINIMAL PLANNING (Oneshot-style):

1. **Quick mental plan** (no formal documentation needed):
   - Identify what needs to change
   - Note any dependencies
   - Think through the approach

2. **What to include:**
   - Which file(s) to modify
   - What pattern to follow
   - Expected outcome

3. **What NOT to do:**
   - NO detailed file-by-file breakdown
   - NO formal planning document
   - NO approval workflow

4. **Execute:**
   - Go directly to implementation
   - Follow existing patterns
   - Stay in scope

EOF
    ;;

  medium)
    cat <<'EOF'
DETAILED PLANNING (Apex-free-style):

1. **ULTRA THINK before planning:**
   - Walk through the implementation mentally
   - Identify all files that need changes
   - Determine logical order (dependencies first)
   - Consider edge cases and error handling

2. **Create file-by-file plan:**
   ```markdown
   ## Implementation Plan

   ### File 1: `path/to/file.ts`
   **Purpose:** {what this file does}
   **Changes:**
   - [ ] Add {feature} function at line ~{N}
   - [ ] Update {existing function} to handle {case}
   - [ ] Import {dependency}

   **Pattern to follow:** {link to similar code}

   ### File 2: `path/to/another.ts`
   ...
   ```

3. **Map to acceptance criteria:**
   - AC1: Implemented in files X, Y
   - AC2: Implemented in file Z
   - etc.

4. **Post plan as ticket comment**

5. **REQUEST USER APPROVAL:**
   - Wait for explicit approval before proceeding
   - Address any concerns or suggestions
   - Update plan if needed

6. **After approval:**
   - Proceed to In Progress status
   - Create subtasks from plan

EOF
    ;;

  complex)
    cat <<'EOF'
COMPREHENSIVE PLANNING (Full Apex):

1. **ULTRA THINK - simulate entire implementation:**
   - Walk through step-by-step execution
   - Identify ALL files that need changes
   - Map dependencies and execution order
   - Consider edge cases, error handling, rollback
   - Plan test coverage strategy
   - Identify potential risks

2. **Create comprehensive file-by-file plan:**
   ```markdown
   ## Implementation Plan

   ### Dependencies
   - Install: {packages}
   - Update: {existing packages}

   ### Architectural Decisions
   - {Decision 1}: {rationale}
   - {Decision 2}: {rationale}

   ### File Changes (in dependency order)

   #### 1. `path/to/types.ts` (Foundation)
   **Purpose:** Type definitions
   **Changes:**
   - [ ] Add `{Type}` interface at line ~{N}
     - Fields: {list}
     - Extends: {parent type}
   - [ ] Export from index

   **Pattern:** Following existing type pattern at {file:line}

   #### 2. `path/to/service.ts` (Business Logic)
   **Purpose:** Core service implementation
   **Changes:**
   - [ ] Add `{method}` function
     - Parameters: {list}
     - Returns: {type}
     - Error handling: {strategy}
   - [ ] Update `{existingMethod}` to integrate new feature
   - [ ] Add validation logic

   **Pattern:** Following service pattern at {file:line}
   **Security:** Validate inputs, sanitize outputs
   **Performance:** Consider caching for {scenario}

   #### 3. `path/to/controller.ts` (API Layer)
   ...

   ### Edge Cases
   - Case 1: {description} - Handled in {file}
   - Case 2: {description} - Handled in {file}

   ### Error Handling
   - Error type 1: {strategy}
   - Error type 2: {strategy}

   ### Testing Strategy
   - Unit tests: {files to test}
   - E2E tests: {scenarios}
   - Coverage target: 80%

   ### Acceptance Criteria Mapping
   - AC1: Files {X, Y} - Lines {ranges}
   - AC2: File {Z} - Lines {ranges}
   ```

3. **Document risks and mitigations:**
   - Risk 1: {description} - Mitigation: {strategy}
   - Risk 2: {description} - Mitigation: {strategy}

4. **Post comprehensive plan as ticket comment**

5. **MANDATORY USER APPROVAL:**
   - Present plan for review
   - Discuss architectural decisions
   - Address concerns
   - Update plan based on feedback
   - Get explicit approval before proceeding

6. **After approval:**
   - Save plan to .claude/output/workflow/{ticket}/plan.md
   - Create granular subtasks
   - Proceed to implementation

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

echo "{\"enabled\": $PLAN_ENABLED, \"depth\": \"$PLAN_DEPTH\", \"approval\": $PLAN_APPROVAL}"

exit 0
