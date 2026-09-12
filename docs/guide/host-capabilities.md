# Host capability inspection

SaaSFoundry can inspect the current machine before a local runtime adapter proposes models. The inspection is read-only and returns one immutable, machine-readable snapshot. It does not install a
runtime, download a model, start a service, or run a benchmark.

```ts
import { collectHostInferenceCapabilities } from 'saasfoundryai-cli/dist/execution'

const snapshot = await collectHostInferenceCapabilities({
  workingDirectory: process.cwd()
})
```

The snapshot records:

- operating-system family and architecture;
- logical and physical CPU cores plus bounded feature identifiers;
- accelerator backend, device class, memory kind, and memory capacity when safely established;
- total and currently available memory;
- available space on the filesystem that contains the working directory;
- a time-limited viability decision and the policy fingerprint used to derive it.

Every fact carries a state: `observed`, `unknown`, `unavailable`, or `failed`. A non-observed fact has no value and includes a stable reason code. Consumers must preserve these distinctions rather
than interpreting missing evidence as zero capacity.

## Conservative viability tiers

The default versioned policy classifies a host as `unsupported`, `background-only`, `interactive`, `coding-capable`, or `high-capability`. Classification starts at the highest tier and only selects a
tier when every required fact meets its threshold. The decision records why the host did not reach the next tier. Unknown operating-system, architecture, capacity, or required accelerator evidence
prevents promotion.

The tier describes machine viability only. Every decision therefore retains `model-fit-not-established` and `runtime-availability-not-established`. Runtime discovery, model compatibility, context
limits, and task requirements belong to later adapters and the execution-candidate catalogue.

The default thresholds are conservative policy inputs rather than claims about a particular model:

| Tier            | Logical cores | Total memory | Available memory | Available disk | Accelerator memory |
| --------------- | ------------: | -----------: | ---------------: | -------------: | -----------------: |
| High capability |             8 |       64 GiB |           16 GiB |         64 GiB |   32 GiB, required |
| Coding capable  |             8 |       32 GiB |            8 GiB |         32 GiB |   16 GiB, required |
| Interactive     |             4 |       16 GiB |            4 GiB |         16 GiB |       Not required |
| Background only |             2 |        8 GiB |            2 GiB |          8 GiB |       Not required |

Callers may supply another fingerprinted `HostViabilityPolicy`. Policies keep the same four-tier order and exact byte-string representation so decisions remain deterministic across JSON and process
boundaries.

## Probe boundary

The default collector uses Node APIs for operating system, architecture, logical cores, memory, and filesystem capacity. Platform-specific enrichment is restricted to fixed sources:

- macOS: absolute `sysctl` and `system_profiler` executables with literal arguments;
- Linux: bounded `/proc/cpuinfo` parsing and an absolute `nvidia-smi` query when available;
- Windows: one absolute, non-interactive PowerShell CIM query with a literal script.

Commands run without a shell, with a minimal environment, a two-second timeout, and bounded output. Public snapshots contain allowlisted normalized facts and source identifiers only. Raw command
output, errors, hostnames, device names, filesystem paths, environment variables, and credentials are never copied into the contract.

Apple silicon accelerator memory is reported as unified memory after Metal support is observed; it is never described as dedicated VRAM. Windows video-controller memory does not prove a DirectML
backend, so the backend remains unknown until a runtime adapter establishes it.

Tests can inject a `HostProbeSystem` to simulate supported, incomplete, and failing hosts without reading the CI machine or starting platform tools. Production callers should use the default system
and treat `validUntil` as a hard freshness boundary before planning local execution.
