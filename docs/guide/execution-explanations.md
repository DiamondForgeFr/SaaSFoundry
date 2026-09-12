# Execution decision explanations

SaaSFoundry exposes a deterministic explanation for every provider-neutral plan decision. The explanation is a safe projection over the immutable planner, budget, recovery, lineage, and authenticated
outcome records. It never reruns qualification, changes the winner, or grants authority.

## What an explanation contains

`explainExecutionDecision` reports:

- the selected proposal and root candidate;
- exact expected aggregate and maximum-path p95 costs;
- every other qualified proposal and the cost or tie-break rule that placed it behind the winner;
- excluded proposals grouped by stable constraint and validation codes;
- the requirement, catalogue, and policy fingerprints used by the planner;
- the monetary authority result, session baseline, approval increments, and independent non-monetary gate;
- recovery spend and remaining authority when the decision belongs to a replan;
- the current execution lineage state, latest trigger/outcome, and invalidated permits;
- normalized authenticated outcomes: usage, latency, validation result, retry ordinal, and fallback reason.

Arrays and references are canonicalized before the explanation is fingerprinted. Equivalent validated inputs therefore produce the same explanation ID regardless of proposal, catalogue, outcome, or
evidence-reference order.

## Stable codes, presentation outside the contract

The public contract carries stable codes, safe identifiers, exact numeric evidence, timestamps, fingerprints, and opaque evidence references. A CLI or UI maps those values to localized prose. This
keeps the core record provider-neutral and prevents an explanation renderer from influencing planning.

The contract rejects unknown or mismatched records and never accepts raw prompts, generated output, tool arguments/results, provider payloads, response headers, credentials, or arbitrary error text.
Opaque references must be generated and authenticated by the host; matching the safe-ID syntax alone does not make caller data trustworthy.

## Historical explanations do not drift

Explanations read historical decisions rather than a live catalogue. A later price refresh, provider outage, outcome reconciliation, or [calibration snapshot](./execution-calibration.md) can create a
new plan and explanation, but it does not rewrite the explanation of an earlier dispatch. Budget grants and lineage reservations remain bound to their original decision fingerprints.

```ts
const explanation = explainExecutionDecision(planDecision, {
  budgetDecision,
  lineage,
  outcomes: authenticatedOutcomes
})
```

Render the returned reason codes and facts for users, while resolving private evidence only in an authorized host view.
