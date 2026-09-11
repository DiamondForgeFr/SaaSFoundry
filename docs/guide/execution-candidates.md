# Execution candidates

SaaSFoundry keeps coding-agent support and model execution as two separate concepts.

- A **coding-agent profile** describes how a host such as Claude Code, Codex, Gemini CLI, Kimi Code, or Qwen Code discovers project instructions and skills. `sf agents` manages these profiles.
- An **execution candidate** is one model and effort level that the active host can run directly or through delegation. Candidates may come from a cloud provider, a local runtime, or a hybrid
  environment.

This separation allows several developers to use different coding agents in the same repository while an execution router compares only the candidates each active host can actually expose.

## Provider-neutral contract

Every provider/runtime adapter normalizes its records into the same contract:

| Area         | Recorded evidence                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Identity     | Stable candidate, provider, runtime, model, and effort identifiers                                                      |
| Capacity     | Context and output limits plus provider-neutral capability identifiers                                                  |
| Availability | State, observation time, expiry, and a machine-readable reason when unavailable                                         |
| Price        | Timestamped dimensions expressed as decimal amounts, currency, normalized unit, denominator, and original provider unit |
| Privacy      | Execution boundary, residency where known, training-use policy, and retention where known                               |
| Tools        | Invocation mode, supported tools, parallel-call support, and approval behavior                                          |
| Provenance   | Adapter, provider record reference, retrieval time, and public original metadata                                        |

Provider-specific effort labels and units remain in the provenance record after normalization. Adapters must submit public metadata only. The catalogue also rejects common secret-bearing keys and
recognizable credential formats before a candidate can enter the eligible view; it never copies raw adapter errors into a snapshot.

## Eligible and excluded views

The catalogue emits a timestamped snapshot with two views:

- `eligible` contains available candidates whose availability and price evidence are still current.
- `excluded` retains a safe identity and a deterministic reason such as `candidate-unavailable`, `catalogue-stale`, `invalid-candidate`, or `duplicate-candidate`.

Consumers therefore do not have to guess whether a missing model was unavailable, stale, malformed, or ambiguous. A failed adapter is also recorded without exposing its raw error, which may contain
provider or authentication details.

## Adapter boundary

An adapter owns discovery and provider-specific normalization. The shared catalogue knows only this interface:

```ts
interface ExecutionCandidateAdapter {
  readonly id: string
  discover(): Promise<readonly ExecutionCandidateObservation[]>
  normalize(observation: ExecutionCandidateObservation): ExecutionCandidate
}
```

Adding another provider or local runtime registers another adapter. It does not add provider branches to portable workflow skills and does not change `modules.harness.agents`.

This first contract deliberately stops before task classification, plan ranking, budget approval, retry policy, and calibration. Those layers consume immutable catalogue snapshots so they can explain
which evidence and prices informed a decision.
