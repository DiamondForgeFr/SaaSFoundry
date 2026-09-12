# Minimum-cost execution planning

SaaSFoundry ranks complete execution trees rather than isolated model calls. A proposal explicitly describes the primary attempt, validation, bounded retries, and fallbacks, together with their
conditional probabilities and p95 usage estimates. This keeps planning provider-neutral and prevents a cheap first call from hiding an expensive recovery path.

## Qualification happens before price

Every candidate used anywhere in a tree must satisfy the resolved task requirements. The planner verifies capabilities, effort, context and output capacity, privacy boundary, training use, retention,
declared tools, required checks, availability, evidence freshness, latency, and independent-validation separation. Missing or stale evidence excludes the proposal; it is never interpreted as a zero
price or an acceptable unknown.

Tool policy applies to tools the plan declares it will invoke. A candidate may support additional tools without violating a forbidden-tool rule. When independent review is required, at least one
validation node must use both a different candidate and a different independence domain from the primary node.

## Exact complete-tree cost

For node `v`, the planner calculates its p95 invocation cost from every declared billable usage dimension and normalized price rate. Its reach probability is the product of conditional probabilities
from the root. The ranking value is:

```text
expectedAggregateP95 = sum(reachProbability(v) * invocationP95(v))
```

This value is an expected aggregate of p95 node estimates. It is not a statistical p95 quantile of the final invoice. The planner also records the unweighted maximum terminal-path cost for the
downstream budget authority.

Amounts and probabilities use reduced arbitrary-precision rationals. Comparisons never use floating point, and display amounts are rounded upward only once at the declared display scale. Every
positive usage dimension requires a matching current price; every priced dimension requires explicit usage. Mixed currencies are excluded until a separately governed conversion layer exists. A local
candidate is free only when its complete explicit rates are zero.

## Deterministic selection and safe evidence

Qualified trees are ordered by exact expected aggregate cost. Equal-cost trees use the policy's declared tie-breakers in order, followed by the canonical proposal ID. Input order and catalogue order
do not affect the result. A more capable or higher-effort candidate remains eligible and wins whenever its complete qualified tree is cheaper.

The immutable decision ledger contains only public candidate and node identifiers, requirement/policy/catalogue/proposal fingerprints, evidence references, exact costs, stable exclusion codes, and
tie-break decisions. It never stores task prompts, raw observations, provider payloads, configuration, or credentials.

[Budget authorization](./execution-budgets.md) compares the selected complete tree with authority derived from the active user-facing session. Runtime failures and evidence changes are handled by
replanning. Cost calibration can update future evidence, but it does not mutate a completed decision.
