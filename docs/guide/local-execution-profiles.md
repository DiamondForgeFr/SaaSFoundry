# Local execution profiles

SaaSFoundry converts a fresh [host capability snapshot](./host-capabilities.md) and runtime-adapter observations into ranked local execution profiles. A profile is a complete install recommendation:
it names the runtime backend, model artifact and digest, quantization, context and output limits, concurrency, expected latency, workload suitability, and required resources.

The recommender is read-only. It does not download an artifact, install a runtime, start a service, benchmark a model, or create an [execution candidate](./execution-candidates.md). Installation
consent, measured qualification, and routing integration are separate lifecycle steps.

```ts
import { collectHostInferenceCapabilities, recommendLocalExecutionProfiles } from 'saasfoundryai-cli/dist/execution'

const host = await collectHostInferenceCapabilities({
  workingDirectory: process.cwd()
})

const recommendation = await recommendLocalExecutionProfiles(host, runtimeAdapters, {
  evaluatedAt: new Date().toISOString()
})
```

Each adapter discovers runtime-specific records and normalizes them into the same closed contract. The common recommender never branches on a runtime or model vendor name. Adapter failures and invalid
records become safe exclusion codes; raw responses, errors, local paths, URLs, and credentials do not enter the result.

## Ranking and trade-offs

The default policy ranks viable profiles in this order:

1. workload suitability, with coding and interactive work first;
2. host-optimized runtime before portable runtime;
3. lower estimated p95 latency;
4. larger context and concurrency limits;
5. lower memory and disk requirements;
6. stable profile identity as the final tie-breaker.

The output records these trade-offs instead of returning a bare model name. Every profile carries exact decimal byte strings for artifact download, installed size, system memory, accelerator memory,
and the calculated requirements with headroom. Its identity includes the artifact digest, so a changed artifact cannot silently reuse an earlier profile identity.

Applications may create another immutable, fingerprinted `LocalExecutionProfilePolicy` to change workload order, prefer portable runtimes, raise the minimum host tier, increase reserves, or reduce the
number of returned profiles. Built-in safety floors prevent a caller from reducing reserves below 2 GiB of operating-system memory, 2 GiB of developer memory, 1 GiB of accelerator memory, and 8 GiB of
storage.

## Resource qualification

Qualification keeps operating-system and active-development capacity available while the model runs:

| Memory layout  | Qualification rule                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPU/system     | Model system memory plus OS and developer reserves must fit total memory; model plus developer reserve must fit currently available memory.              |
| Unified/shared | System and accelerator allocations share the same host pool and are counted once each, with both system and accelerator reserves.                        |
| Dedicated      | System memory is checked separately. Model accelerator memory plus its reserve must fit one compatible device. Several devices are never added together. |

Disk qualification includes the download size, installed size, and storage reserve because download and installed files may coexist during installation. Unknown required capacity, an unsupported
backend, stale evidence, or a one-byte shortfall excludes the profile.

## No-install decisions

`status: "no-install-recommended"` is an intentional result. It is returned for an unsupported or stale host, a host below the configured tier, no adapters, no observations, or no viable profile.
Stable constraint and exclusion codes explain the decision without encouraging an optimistic download.

Recommendations are immutable and fingerprinted. Re-running with the same canonical host evidence, adapter profiles, policy, and evaluation time produces the same ordered result, regardless of adapter
or observation order.
