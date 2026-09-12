import {
  assertLocalExecutionProfileRecommendation,
  createHostCapabilitySnapshot,
  createLocalExecutionProfilePolicy,
  recommendLocalExecutionProfiles,
  type HostAcceleratorDevice,
  type HostCapabilityEvidence,
  type HostCapabilityObservation,
  type LocalExecutionProfileAdapter,
  type LocalExecutionProfileCandidate
} from '../../../execution'

const OBSERVED_AT = '2026-09-12T12:00:00.000Z'
const EVALUATED_AT = '2026-09-12T12:01:00.000Z'
const VALID_UNTIL = '2026-09-12T12:05:00.000Z'
const GIB = 1024n * 1024n * 1024n
const bytes = (gib: number): string => String(BigInt(gib) * GIB)

function observed<T>(value: T, sourceId: string): HostCapabilityEvidence<T> {
  return { state: 'observed', value, sourceId, observedAt: OBSERVED_AT }
}

function host(options: { available?: string; disk?: string; accelerators?: HostAcceleratorDevice[]; validUntil?: string } = {}) {
  const observation: HostCapabilityObservation = {
    schemaVersion: 1,
    observedAt: OBSERVED_AT,
    validUntil: options.validUntil ?? VALID_UNTIL,
    platform: { os: observed('macos', 'node/platform'), architecture: observed('arm64', 'node/architecture') },
    cpu: {
      logicalCores: observed(12, 'node/cpu/logical'),
      physicalCores: observed(10, 'darwin/cpu/physical'),
      features: observed(['aes', 'asimd', 'sha256'], 'darwin/cpu/features')
    },
    accelerators: observed(
      options.accelerators ?? [
        { backend: 'metal', deviceClass: 'integrated', memoryKind: 'unified', memoryBytes: bytes(32) },
        { backend: 'cuda', deviceClass: 'discrete', memoryKind: 'dedicated', memoryBytes: bytes(24) }
      ],
      'host/accelerators'
    ),
    memory: { totalBytes: observed(bytes(64), 'node/memory/total'), availableBytes: observed(options.available ?? bytes(48), 'node/memory/available') },
    storage: { availableBytes: observed(options.disk ?? bytes(100), 'node/storage/available') }
  }
  return createHostCapabilitySnapshot(observation)
}

function candidate(
  id: string,
  options: {
    backend?: 'metal' | 'cuda' | 'none'
    pool?: 'unified' | 'dedicated' | 'system'
    optimization?: 'portable' | 'host-optimized'
    acceleratorMemory?: string
    systemMemory?: string
    latency?: number
    rating?: 'limited' | 'suitable' | 'preferred'
  } = {}
): LocalExecutionProfileCandidate {
  const backend = options.backend ?? 'metal'
  const pool = options.pool ?? 'unified'
  return {
    schemaVersion: 1,
    runtime: { runtimeId: `runtime-${id}`, backend, optimization: options.optimization ?? 'host-optimized' },
    artifact: {
      artifactId: `artifact-${id}`,
      modelId: `model-${id}`,
      format: 'gguf',
      quantization: 'q4_k_m',
      revision: 'r1',
      sha256: id.padEnd(64, id[0]).slice(0, 64)
    },
    configuration: { contextTokens: 32_768, maxOutputTokens: 8_192, concurrency: 1 },
    resources: {
      artifactDownloadBytes: bytes(10),
      installedDiskBytes: bytes(12),
      systemMemoryBytes: options.systemMemory ?? bytes(2),
      acceleratorMemoryBytes: backend === 'none' ? '0' : (options.acceleratorMemory ?? bytes(20)),
      memoryPool: pool
    },
    performance: { estimatedLatencyP95Ms: options.latency ?? 900, estimatedTokensPerSecond: '20' },
    suitability: ['background', 'coding', 'high-capability', 'interactive'].map((workload) => ({
      workload: workload as 'background' | 'coding' | 'high-capability' | 'interactive',
      rating: options.rating ?? 'preferred'
    })),
    availability: { state: 'available', observedAt: OBSERVED_AT, validUntil: '2026-09-13T12:00:00.000Z' },
    evidenceRefs: [`registry/${id}`, `runtime/${id}`]
  }
}

function adapter(id: string, candidates: LocalExecutionProfileCandidate[]): LocalExecutionProfileAdapter {
  return {
    id,
    discover: () => candidates.map((value, index) => ({ sourceId: `${id}-${index}`, value })),
    normalize: (observation) => observation.value as LocalExecutionProfileCandidate
  }
}

describe('local execution profile recommendations (#744)', () => {
  it('ranks normalized profiles deterministically across adapter and observation order', async () => {
    const portable = candidate('b', { optimization: 'portable', latency: 500 })
    const optimized = candidate('a', { optimization: 'host-optimized', latency: 900 })
    const first = await recommendLocalExecutionProfiles(host(), [adapter('zeta', [portable]), adapter('alpha', [optimized])], { evaluatedAt: EVALUATED_AT })
    const second = await recommendLocalExecutionProfiles(host(), [adapter('alpha', [optimized]), adapter('zeta', [portable])], { evaluatedAt: EVALUATED_AT })

    expect(first.status).toBe('profiles-available')
    expect(first.profiles.map((profile) => profile.runtime.optimization)).toEqual(['host-optimized', 'portable'])
    expect(first.id).toBe(second.id)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(Object.isFrozen(first)).toBe(true)
    expect(() => assertLocalExecutionProfileRecommendation(first)).not.toThrow()
  })

  it('uses exact headroom boundaries and one compatible dedicated device without aggregation', async () => {
    const exact = candidate('c', { backend: 'cuda', pool: 'dedicated', acceleratorMemory: bytes(22) })
    const fitting = await recommendLocalExecutionProfiles(host(), [adapter('cuda-runtime', [exact])], { evaluatedAt: EVALUATED_AT })
    expect(fitting.profiles[0].resources.requiredAcceleratorMemoryWithHeadroomBytes).toBe(bytes(24))

    const splitCards = host({
      accelerators: [
        { backend: 'cuda', deviceClass: 'discrete', memoryKind: 'dedicated', memoryBytes: bytes(16) },
        { backend: 'cuda', deviceClass: 'discrete', memoryKind: 'dedicated', memoryBytes: bytes(15) }
      ]
    })
    const rejected = await recommendLocalExecutionProfiles(splitCards, [adapter('cuda-runtime', [exact])], { evaluatedAt: EVALUATED_AT })
    expect(rejected.status).toBe('no-install-recommended')
    expect(rejected.exclusions[0]).toMatchObject({ code: 'accelerator-memory-insufficient' })
  })

  it('accounts for unified memory once and rejects a candidate one byte beyond available capacity', async () => {
    const unified = candidate('d')
    const exactAvailable = bytes(28)
    const fitting = await recommendLocalExecutionProfiles(host({ available: exactAvailable }), [adapter('metal-runtime', [unified])], { evaluatedAt: EVALUATED_AT })
    expect(fitting.status).toBe('profiles-available')
    expect(fitting.profiles[0].resources.requiredSystemMemoryWithHeadroomBytes).toBe(bytes(32))

    const oneByteShort = String(BigInt(exactAvailable) - 1n)
    const rejected = await recommendLocalExecutionProfiles(host({ available: oneByteShort }), [adapter('metal-runtime', [unified])], { evaluatedAt: EVALUATED_AT })
    expect(rejected.exclusions[0]).toMatchObject({ code: 'system-memory-insufficient' })
  })

  it('returns explicit no-install recommendations for stale hosts, missing adapters, failures, and duplicates', async () => {
    const stale = await recommendLocalExecutionProfiles(host({ validUntil: EVALUATED_AT }), [adapter('metal-runtime', [candidate('e')])], { evaluatedAt: EVALUATED_AT })
    expect(stale).toMatchObject({ status: 'no-install-recommended', constraintCodes: ['host-stale'] })

    const empty = await recommendLocalExecutionProfiles(host(), [], { evaluatedAt: EVALUATED_AT })
    expect(empty.constraintCodes).toEqual(['no-adapters'])

    const failed: LocalExecutionProfileAdapter = {
      id: 'broken-runtime',
      discover: () => {
        throw new Error('credential=must-not-leak')
      },
      normalize: () => candidate('f')
    }
    const failure = await recommendLocalExecutionProfiles(host(), [failed], { evaluatedAt: EVALUATED_AT })
    expect(failure.constraintCodes).toEqual(['no-profile-observations', 'no-viable-profile'])
    expect(failure.exclusions[0]).toMatchObject({ code: 'adapter-failed' })
    expect(JSON.stringify(failure)).not.toContain('must-not-leak')

    const duplicate = candidate('f')
    const collision = await recommendLocalExecutionProfiles(host(), [adapter('one', [duplicate]), adapter('two', [duplicate])], { evaluatedAt: EVALUATED_AT })
    expect(collision.exclusions).toHaveLength(2)
    expect(collision.exclusions.every((entry) => entry.code === 'duplicate-profile')).toBe(true)
  })

  it('honors workload/runtime policy and caps the returned profile count', async () => {
    const policy = createLocalExecutionProfilePolicy({
      schemaVersion: 1,
      version: 'test-policy/v1',
      minimumHostTier: 'background-only',
      headroom: {
        osSystemMemoryBytes: bytes(2),
        developerSystemMemoryBytes: bytes(2),
        developerAcceleratorMemoryBytes: bytes(1),
        storageBytes: bytes(8)
      },
      maximumProfiles: 1,
      workloadPriority: ['coding'],
      runtimePreference: ['portable', 'host-optimized']
    })
    const portable = candidate('1', { optimization: 'portable', rating: 'suitable' })
    const optimized = candidate('2', { optimization: 'host-optimized', rating: 'suitable' })
    const result = await recommendLocalExecutionProfiles(host(), [adapter('runtime', [optimized, portable])], { evaluatedAt: EVALUATED_AT, policy })

    expect(result.profiles).toHaveLength(1)
    expect(result.profiles[0].runtime.optimization).toBe('portable')
    expect(result.exclusions).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'profile-limit' })]))
  })
})
