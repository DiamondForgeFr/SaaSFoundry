import {
  createHostCapabilitySnapshot,
  recommendLocalExecutionProfiles,
  type HostCapabilityEvidence,
  type HostCapabilityObservation,
  type LocalExecutionProfileAdapter,
  type LocalExecutionProfileCandidate
} from '../../../execution'

const OBSERVED_AT = '2026-09-12T12:00:00.000Z'
const VALID_UNTIL = '2026-09-12T12:10:00.000Z'
const GIB = 1024n * 1024n * 1024n
const bytes = (gib: number): string => String(BigInt(gib) * GIB)

function observed<T>(value: T, sourceId: string): HostCapabilityEvidence<T> {
  return { state: 'observed', value, sourceId, observedAt: OBSERVED_AT }
}

function fixtureHost() {
  const observation: HostCapabilityObservation = {
    schemaVersion: 1,
    observedAt: OBSERVED_AT,
    validUntil: VALID_UNTIL,
    platform: { os: observed('linux', 'node/platform'), architecture: observed('x64', 'node/architecture') },
    cpu: {
      logicalCores: observed(8, 'node/cpu/logical'),
      physicalCores: observed(4, 'linux/cpu/physical'),
      features: observed(['aes', 'sha256'], 'linux/cpu/features')
    },
    accelerators: observed([{ backend: 'none', deviceClass: 'unknown', memoryKind: 'unknown', memoryBytes: null }], 'linux/accelerators'),
    memory: { totalBytes: observed(bytes(32), 'node/memory/total'), availableBytes: observed(bytes(16), 'node/memory/available') },
    storage: { availableBytes: observed(bytes(64), 'node/storage/available') }
  }
  return createHostCapabilitySnapshot(observation)
}

function cpuProfile(): LocalExecutionProfileCandidate {
  return {
    schemaVersion: 1,
    runtime: { runtimeId: 'llama.cpp-cpu', backend: 'none', optimization: 'portable' },
    artifact: {
      artifactId: 'small-coder-q4',
      modelId: 'small-coder',
      format: 'gguf',
      quantization: 'q4_k_m',
      revision: 'r1',
      sha256: 'c'.repeat(64)
    },
    configuration: { contextTokens: 16_384, maxOutputTokens: 4_096, concurrency: 1 },
    resources: {
      artifactDownloadBytes: bytes(3),
      installedDiskBytes: bytes(4),
      systemMemoryBytes: bytes(6),
      acceleratorMemoryBytes: '0',
      memoryPool: 'system'
    },
    performance: { estimatedLatencyP95Ms: 2_500, estimatedTokensPerSecond: '8.5' },
    suitability: [
      { workload: 'background', rating: 'preferred' },
      { workload: 'coding', rating: 'suitable' },
      { workload: 'high-capability', rating: 'limited' },
      { workload: 'interactive', rating: 'limited' }
    ],
    availability: { state: 'available', observedAt: OBSERVED_AT, validUntil: '2026-09-13T12:00:00.000Z' },
    evidenceRefs: ['registry/small-coder-q4', 'runtime/llama.cpp-cpu']
  }
}

describe('local profile recommendation pipeline (#745)', () => {
  it('connects host evidence to adapter profiles without mutating inputs or leaking adapter failures', async () => {
    const host = fixtureHost()
    const candidate = cpuProfile()
    const hostBytes = JSON.stringify(host)
    const candidateBytes = JSON.stringify(candidate)
    const calls: string[] = []
    const runtime: LocalExecutionProfileAdapter = {
      id: 'portable-cpu-runtime',
      discover: (snapshot) => {
        calls.push(`discover:${snapshot.id}`)
        return [{ sourceId: 'small-coder-q4', value: candidate }]
      },
      normalize: (observation) => {
        calls.push(`normalize:${observation.sourceId}`)
        return observation.value as LocalExecutionProfileCandidate
      }
    }
    const failing: LocalExecutionProfileAdapter = {
      id: 'unavailable-runtime',
      discover: () => {
        throw new Error('authorization=private-runtime-token')
      },
      normalize: () => candidate
    }

    const recommendation = await recommendLocalExecutionProfiles(host, [failing, runtime], {
      evaluatedAt: '2026-09-12T12:01:00.000Z'
    })

    expect(recommendation.status).toBe('profiles-available')
    expect(recommendation.profiles).toHaveLength(1)
    expect(recommendation.profiles[0]).toMatchObject({
      runtime: { runtimeId: 'llama.cpp-cpu', backend: 'none' },
      artifact: { modelId: 'small-coder', quantization: 'q4_k_m' },
      configuration: { contextTokens: 16_384, concurrency: 1 },
      resources: {
        requiredDiskWithHeadroomBytes: bytes(23),
        requiredSystemMemoryWithHeadroomBytes: bytes(14),
        requiredAcceleratorMemoryWithHeadroomBytes: '0'
      }
    })
    expect(recommendation.exclusions).toEqual([expect.objectContaining({ adapterId: 'unavailable-runtime', code: 'adapter-failed' })])
    expect(JSON.stringify(recommendation)).not.toContain('private-runtime-token')
    expect(calls).toEqual([`discover:${host.id}`, 'normalize:small-coder-q4'])
    expect(JSON.stringify(host)).toBe(hostBytes)
    expect(JSON.stringify(candidate)).toBe(candidateBytes)
  })
})
