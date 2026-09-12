# Safe execution replanning

SaaSFoundry creates a fresh plan when an observed failure or changed constraint invalidates the current one. It does not patch a completed planner decision, silently reuse an approval, or treat a
failed call as free. Each recovery remains linked to one bounded execution lineage so the host can prove what was attempted, what authority remains, and why another plan is eligible.

## When replanning starts

A branch already encoded in the authorized execution tree is normal continuation. Replanning begins only when the host invalidates that tree or its remaining dispatch permits because of one of these
typed events:

- execution or validation failure;
- candidate unavailability;
- stale candidate, estimate, session, or price evidence;
- policy change;
- material scope change;
- expired dispatch permit.

The previous selected proposal is supplied separately from the fresh recovery proposals. This lets the host verify the observed node and outcome even when the failed or unavailable candidate is
intentionally absent from the new catalogue. Recovery always runs the normal qualification and deterministic minimum-cost selection again against current evidence.

An ambiguous provider or tool result uses `outcome-unknown`. SaaSFoundry records a final blocked lineage entry and refuses automatic retry or replanning until the host reconciles the result. This
avoids duplicate spend and repeated side effects when a request may already have succeeded.

## Immutable execution lineage

`createExecutionLineage` starts a bounded lineage from a selected plan. Every initial or recovery attempt records safe identifiers and fingerprints for the plan, requirements, catalogue, policy, scope
revision, evidence references, invalidated permits, and optional p95 reservation. Attempts form an append-only hash chain. Prior plans and attempts are never mutated.

The host authenticates both the current lineage head and the scope revision before planning recovery. Ordinary failures must preserve the frozen requirement and task fingerprints. A `scope-changed`
request requires a new host-authenticated scope revision and a different task fingerprint, after which the task is classified again. Constraints recorded for future replans must be included in the
authoritative requirement set supplied by the host.

Lineages have explicit attempt and replan limits. Completed, cancelled, or blocked lineages cannot be reopened; a materially different task after completion starts a new lineage.

Every accepted replan records all undispatched permit IDs invalidated by the new revision. The host remains responsible for atomically checking that list, persisting the lineage with compare-and-swap
semantics, and issuing a fresh short-lived dispatch permit.

## Remaining automatic authority

[Session-derived authority](./execution-budgets.md) still defines the baseline `B`. Replanning adds cumulative accounting only inside one execution lineage. Let `S` be the sum of exact p95
reservations for every attempt that reached dispatch, and let `Eᵣ` and `Mᵣ` be the expected aggregate and maximum-path costs of the fresh recovery tree:

```text
remaining automatic authority = max(0, B - S)
recovery expected total        = S + Eᵣ
recovery maximum total         = S + Mᵣ
expected increment             = max(0, S + Eᵣ - B)
path increment                 = max(0, S + Mᵣ - B)
```

The reservation is permanent authority evidence for the lineage. A later invoice or calibration result does not release it. Once a failure is observed, its cost is sunk and the recovery root is
reached with probability one; SaaSFoundry never subtracts the old tree's probability-weighted allocation.

`authorizeExecutionRecovery` recomputes the recovery plan from host-owned proposals and requirements, verifies the active session and lineage history, then applies both cumulative bounds. Recovery is
automatic only when both totals fit `B`. Otherwise it creates a new challenge bound to the run ID, lineage revision, history head, spent amount, new plan, current evidence fingerprints, authority
revision, and exact increments. A grant from the original plan or any earlier replan cannot transfer.

Monetary authority remains separate from privacy, tool, and side-effect approval. `dispatchAuthorized` becomes true only after every independent gate is satisfied.

## Public API flow

```ts
const lineage = createExecutionLineage(initialPlan, scopeRevision, evidenceRefs, {
  runId,
  maxAttempts: 8,
  maxReplans: 4,
  taskFingerprint: requirements.taskFingerprint
})

const request = createExecutionReplanRequest({
  schemaVersion: 1,
  parentPlanDecisionId: lineage.currentPlanDecisionId,
  parentAttemptId: lineage.currentAttemptId,
  trigger: 'candidate-unavailable',
  scopeRevision,
  nodeId: 'primary',
  outcomeCode: 'candidate-unavailable',
  invalidatedPermitIds,
  evidenceRefs
})

const recovery = replanExecution(lineage, request, priorPlan, requirements, freshProposals, freshCatalogue, freshPolicy, priorSelectedProposal, { verifyLineage, verifyScopeRevision })

const authority = authorizeExecutionRecovery(
  recovery.decision,
  sessionWorkload,
  freshCatalogue,
  freshPolicy,
  authenticatedRecoveryHistory,
  { evaluatedAt, justification, approval },
  { requirements, proposals: freshProposals, verifySessionEvidence, verifyRecoveryHistory, consumeApprovalGrant }
)
```

Dispatch only an `authorized` decision with `dispatchAuthorized === true`, using an atomic host reservation and idempotency key. Persist raw prompts, model output, provider errors, credentials, and
tool arguments outside these public records.
