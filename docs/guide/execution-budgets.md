# Session-derived execution budgets

SaaSFoundry can delegate work to a cheaper model automatically without asking the user to configure an arbitrary spending limit. The monetary authority comes from the active user-facing session: the
exact p95 cost of its current provider, runtime, model, normalized effort, and expected workload becomes the baseline `B` for one proposed execution plan.

The host supplies current session workload evidence, the authoritative proposal and requirement inputs, the current candidate catalogue, and the same planning policy used to select the plan. The
library derives the envelope and recomputes the planner decision for every authorization. A caller cannot turn a cached total or a self-hashed JSON decision into authority. The host must also
authenticate that the workload evidence belongs to the active session.

## Automatic authority

For a selected complete execution tree, the planner records:

- `E`, its exact expected aggregate p95 cost;
- `M`, its exact maximum terminal-path p95 cost;
- `B`, the exact session-derived baseline.

The plan receives automatic monetary authority only when both `E <= B` and `M <= B`. The second bound prevents a rare expensive retry or fallback from hiding behind a low expected value. Equality is
inside the envelope.

All comparisons use reduced arbitrary-precision rationals. Display rounding never decides authority. For example, `B = 1.001` and `E = M = 1.009` may both display as `1.01`, but the plan still needs
approval because its exact cost is higher.

## Approval above the baseline

An over-envelope plan produces an immutable challenge rather than running. The challenge contains:

```text
expected increment = max(0, E - B)
path increment     = max(0, M - B)
```

It also binds the session and authority revision, plan and proposal fingerprints, requirements, catalogue, policy, workload, currency, quote time, expiry, stable reason code, benefit codes, and safe
evidence references. The host should show the user the session baseline, `E`, `M`, both increments, the reason and expected benefit, expiry, and a short plan fingerprint.

The host authenticates the user's decision and issues a grant for those exact increments. A grant cannot approve a different session, plan, evidence revision, currency, amount, or validity window. Its
event ID must be unique. The mandatory host callback authenticates and atomically consumes it; returning `false` rejects the authorization. The execution library does not provide the durable
transaction ledger, wallet, or billing system behind that callback.

## Separate non-monetary approval

Monetary authority does not replace tool, privacy, or side-effect approval. An inexpensive plan can be inside the session envelope and still expose `nonMonetaryApprovalRequired: true`. In that case
`dispatchAuthorized` remains `false` until the host satisfies the independent gate and creates its final dispatch permission.

## Freshness and failure behavior

Session workload, candidate availability, prices, plan estimates, and catalogue evidence must all be current at planning and evaluation time. Missing dimensions, missing prices, mixed currencies,
unknown candidates, mismatched fingerprints, expired evidence, and tampered serialized values fail closed. An explicitly complete zero-price schedule remains valid, including a local runtime.

If evidence changes before dispatch, the host must rebuild the catalogue, replan, and request authority again. [Safe replanning](./execution-replanning.md) extends this policy across a bounded
execution lineage: dispatched p95 reservations become sunk cost, and every recovery plan receives fresh authority. Future calibration may improve workload and price evidence, but it does not rewrite a
completed authority decision.

The envelope applies to one plan decision. It is not a reusable session wallet. Replanning may compare cumulative reservations only within the current execution lineage, and p95 estimates do not
guarantee the final provider invoice.

## Public API flow

```ts
const catalogue = await executionCandidateCatalogue.snapshot()
const requirements = classifyTaskIntent(intent, constraints)
const plan = selectMinimumCostExecutionPlan(proposals, requirements, catalogue, policy)

const authority = authorizeExecutionPlan(
  plan,
  sessionWorkload,
  catalogue,
  policy,
  {
    evaluatedAt: new Date().toISOString(),
    justification
  },
  {
    requirements,
    proposals,
    verifySessionEvidence,
    consumeApprovalGrant
  }
)
```

Dispatch only when `status === 'authorized'` and `dispatchAuthorized === true`. Present `approval-required` to the user, then call the authority function again with the host-authenticated grant. Treat
`rejected` as a planning or evidence failure to resolve rather than a request the host may bypass.
