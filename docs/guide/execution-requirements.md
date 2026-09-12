# Execution requirements

SaaSFoundry classifies a task before it considers providers, runtimes, models, or prices. The classifier turns task intent into an immutable, provider-neutral requirement set that later planning
layers can inspect and reuse.

```text
Task intent → Execution requirements → Candidate catalogue → Ranking and plan
```

This boundary prevents the available catalogue from lowering the quality or safety required by the work. A cheap candidate may rank well only after it satisfies the requirement set.

## Requirement set

The normalized artifact records:

| Area           | Meaning                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| Classification | Normalized task categories, assessed risk, classifier version, and safe evidence codes                 |
| Capabilities   | Required provider-neutral capabilities and minimum reasoning effort                                    |
| Validation     | Minimum rigor and checks such as type checking, automated tests, independent review, or security tests |
| Latency        | Interactive, balanced, or throughput priority and an optional plan-latency ceiling                     |
| Context        | Minimum input and output capacity and whether the task may be partitioned                              |
| Privacy        | Allowed execution boundaries, training use, and retention ceiling                                      |
| Tools          | Required and forbidden tool identifiers plus approval requirements                                     |
| Resolution     | Every applied or rejected override and any unsatisfiable conflict                                      |

The artifact has a stable SHA-256 identifier. The task text is normalized and hashed separately, then discarded. Raw prompts, credentials, provider responses, provider names, runtime names, and model
names are not part of the public requirement set.

## Baseline profiles

Several categories may apply to one task. SaaSFoundry combines them using the strictest compatible requirements.

| Category       | Risk     | Minimum effort | Minimum validation           | Context mode     |
| -------------- | -------- | -------------- | ---------------------------- | ---------------- |
| Mechanical     | Low      | Low            | Automated checks             | Partitionable    |
| Implementation | Medium   | Medium         | Automated checks             | Partitionable    |
| Architecture   | High     | High           | Independent review           | Single candidate |
| Security       | Critical | Extra high     | Independent review and tests | Single candidate |
| Data sensitive | High     | High           | Independent review and tests | Single candidate |

Unknown work uses the implementation profile as a conservative default. Explicit signals such as production impact, destructive operations, migrations, secrets, or restricted data can add stricter
categories.

## Workflow and user constraints

Workflow constraints are applied first, followed by explicit user constraints. Overrides are monotonic: they can add or strengthen requirements, but cannot weaken an existing safety floor.

| Constraint                                      | Merge rule                   |
| ----------------------------------------------- | ---------------------------- |
| Required capabilities, checks, and tools        | Union                        |
| Minimum effort, validation, context, and output | Strictest or highest minimum |
| Latency and retention ceilings                  | Lowest ceiling               |
| Allowed privacy boundaries and training use     | Intersection                 |
| Approval requirement                            | Logical OR                   |

Each decision retains its source, safe reference, field, result, reason, and whether it applies only to the current task or to future replans. Empty privacy intersections and required/forbidden tool
collisions make the result `unsatisfiable`; the planner must stop instead of guessing.

## Reuse during planning

```ts
const requirements = classifyTaskIntent(
  {
    text: 'Review authentication and secret handling',
    signals: { operation: 'security-review', handlesSecrets: true }
  },
  {
    workflowConstraints: [workflowPolicy],
    userConstraints: [userPolicy]
  }
)

// Pass the same immutable artifact to catalogue filtering, ranking, retries,
// and replanning. Do not classify again unless the task or policy changes.
```

Serialization preserves the complete decision artifact, so a later planning step can consume the same requirements without repeating classification. Provider adapters remain responsible only for
candidate discovery and normalization; ranking and budget policy are separate layers.
