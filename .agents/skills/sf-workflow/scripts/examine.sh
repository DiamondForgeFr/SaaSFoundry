#!/bin/bash

# Adversarial review script (complex tickets only)
# Extracted from apex step-05-examine.md
# Usage: examine.sh <ticket-number>

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $# -lt 1 ]]; then
  echo "Usage: examine.sh <ticket-number>" >&2
  exit 1
fi

TICKET=$1

echo "==================================================================="
echo " EXAMINE PHASE - Adversarial Code Review"
echo "==================================================================="
echo ""

cat <<'EOF'
This phase is ONLY for COMPLEX tickets requiring security and quality review.

## Adversarial Review Process

1. **Launch 3 parallel review agents:**
   ```
   /task general-purpose "security review: analyze code for OWASP top 10 vulnerabilities"
   /task general-purpose "logic review: identify edge cases, race conditions, logic flaws"
   /task general-purpose "performance review: identify bottlenecks, N+1 queries, inefficiencies"
   ```

2. **Security Analysis (OWASP Top 10):**
   - Injection (SQL, NoSQL, Command, etc.)
   - Broken Authentication
   - Sensitive Data Exposure
   - XML External Entities (XXE)
   - Broken Access Control
   - Security Misconfiguration
   - Cross-Site Scripting (XSS)
   - Insecure Deserialization
   - Using Components with Known Vulnerabilities
   - Insufficient Logging & Monitoring

3. **Logic Analysis:**
   - Edge cases not covered by tests
   - Race conditions in async code
   - Off-by-one errors
   - Null/undefined handling
   - Type coercion issues
   - Error propagation

4. **Performance Analysis:**
   - N+1 query problems
   - Memory leaks
   - Inefficient algorithms
   - Unnecessary re-renders (frontend)
   - Missing indexes (database)
   - Large payload sizes

5. **Classify Findings:**
   For each finding:
   - **Severity:** Critical | High | Medium | Low
   - **Validity:** Real | False Positive
   - **File:Line:** Exact location
   - **Description:** Clear explanation
   - **Recommendation:** How to fix

6. **Present Findings Table:**
   ```markdown
   | Severity | File:Line | Issue | Recommendation |
   |----------|-----------|-------|----------------|
   | Critical | auth.ts:42 | SQL injection risk | Use parameterized queries |
   | High | api.ts:18 | Missing input validation | Add Zod schema validation |
   | Medium | service.ts:105 | N+1 query | Use eager loading |
   ```

7. **Auto-fix or Create Todos:**
   - **Critical/High:** MUST fix before proceeding
   - **Medium:** Fix or document reason to defer
   - **Low:** Document for future consideration

8. **Re-validate after fixes:**
   - Run all tests again
   - Verify fixes don't introduce new issues

EOF

echo ""
echo "==================================================================="
echo ""

exit 0
