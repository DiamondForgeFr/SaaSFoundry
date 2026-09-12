# Execution outcomes and calibration

SaaSFoundry records what happened after dispatch separately from what the planner estimated. Authenticated outcomes support audit and explanation immediately; a bounded calibration snapshot may later
turn a qualified cohort of those outcomes into new estimate evidence for future plans.

## Authenticated outcome records

`recordExecutionOutcome` binds one normalized result to the exact run, lineage revision and head, attempt, dispatch permit, plan decision, proposal, node, candidate, retry ordinal, and calibration
cohort. The record includes only:

- normalized actual billable quantities;
- bounded latency;
- an allowlisted outcome code;
- validation result and executed check codes;
- optional retry, fallback, or replan reason;
- canonical occurrence and receipt timestamps;
- source kind and opaque evidence references.

The host verifies the provider settlement, runtime meter, or dispatch record and appends it atomically. Replaying the same event with the same canonical content returns the existing record. Reusing
the event key with different usage, bindings, or results is rejected, as is a second terminal result. Hashes detect accidental or caller-side tampering; durable authentication and compare-and-swap
storage remain host responsibilities.

`outcome-unknown`, cancelled, partially metered, and unmetered records remain useful audit evidence, but calibration censors them. They cannot report success, lower a p95 estimate, release a lineage
reservation, or authorize a retry.

## Isolated, bounded calibration

`deriveExecutionCalibrationSnapshot` accepts authenticated records for one exact cohort:

- canonical candidate and effort;
- runtime kind;
- workload class;
- privacy boundary;
- opaque tenant/security boundary.

This prevents restricted tenant evidence from entering a shared estimator. The policy also declares a cutoff, estimator version, minimum and maximum sample counts, nearest-rank quantile, per-dimension
usage caps, latency cap, generation time, expiry, and an opaque evidence reference. Caps bound the influence of one anomalous or poisoned sample. Records after the cutoff and records from another
cohort are excluded deterministically.

The immutable snapshot contains canonical source outcome IDs and a history fingerprint, calibrated usage and latency p95 estimates, exact rational outcome rates, and its validity window. Input order
does not change the snapshot.

## Forward-only evidence

`applyExecutionCalibrationToPlanEstimate` copies a proposal and replaces only the selected node's future usage/latency estimate evidence. It does not mutate the source proposal or change capabilities,
privacy, tools, prices, requirements, policy, session workload, authority, grants, reservations, lineage, or historical outcomes. Outcome rates remain explicit rational evidence for the host's
proposal builder; they are never silently rounded into a tree.

```ts
const outcome = recordExecutionOutcome(rawOutcome, expectedDispatchBinding, outcomeHost)
const snapshot = deriveExecutionCalibrationSnapshot(outcomes, cohort, calibrationPolicy, calibrationHost)
const futureProposal = applyExecutionCalibrationToPlanEstimate(previousProposal, 'primary', snapshot)
const futureDecision = selectMinimumCostExecutionPlan([futureProposal, ...alternatives], requirements, catalogue, policy)
```

The future decision must pass normal qualification and receive fresh [budget authority](./execution-budgets.md). A stale snapshot excludes the proposal through the existing estimate freshness checks.
Settled cost is audit and calibration evidence only; it never refunds the conservative p95 reservation used by [safe replanning](./execution-replanning.md).
