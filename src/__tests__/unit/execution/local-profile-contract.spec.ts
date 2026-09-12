import {
  assertLocalExecutionProfileCandidate,
  assertLocalExecutionProfilePolicy,
  canonicalLocalExecutionProfileCandidate,
  createLocalExecutionProfilePolicy,
  DEFAULT_LOCAL_EXECUTION_PROFILE_POLICY,
  localExecutionProfileId,
  LocalProfileContractError,
  type LocalExecutionProfileCandidate
} from '../../../execution'

const GIB = 1024n * 1024n * 1024n
const bytes = (gib: number): string => String(BigInt(gib) * GIB)

function candidate(): LocalExecutionProfileCandidate {
  return {
    schemaVersion: 1,
    runtime: { runtimeId: 'llama.cpp-metal', backend: 'metal', optimization: 'host-optimized' },
    artifact: {
      artifactId: 'qwen3-coder-30b-q4_k_m',
      modelId: 'qwen3-coder-30b',
      format: 'gguf',
      quantization: 'q4_k_m',
      revision: 'r1',
      sha256: 'a'.repeat(64)
    },
    configuration: { contextTokens: 32_768, maxOutputTokens: 8_192, concurrency: 1 },
    resources: {
      artifactDownloadBytes: bytes(18),
      installedDiskBytes: bytes(20),
      systemMemoryBytes: bytes(2),
      acceleratorMemoryBytes: bytes(22),
      memoryPool: 'unified'
    },
    performance: { estimatedLatencyP95Ms: 800, estimatedTokensPerSecond: '24.5' },
    suitability: [
      { workload: 'interactive', rating: 'preferred' },
      { workload: 'background', rating: 'preferred' },
      { workload: 'high-capability', rating: 'limited' },
      { workload: 'coding', rating: 'preferred' }
    ],
    availability: {
      state: 'available',
      observedAt: '2026-09-12T12:00:00.000Z',
      validUntil: '2026-09-13T12:00:00.000Z'
    },
    evidenceRefs: ['registry/qwen3-coder-30b', 'runtime/llama.cpp-metal']
  }
}

describe('local execution profile contracts (#743)', () => {
  it('canonicalizes adapter candidates and derives stable artifact-bound identities', () => {
    const left = candidate()
    const right = structuredClone(left)
    right.suitability.reverse()
    right.evidenceRefs.reverse()

    expect(canonicalLocalExecutionProfileCandidate(right)).toEqual(canonicalLocalExecutionProfileCandidate(left))
    expect(localExecutionProfileId(right)).toBe(localExecutionProfileId(left))

    right.artifact.sha256 = 'b'.repeat(64)
    expect(localExecutionProfileId(right)).not.toBe(localExecutionProfileId(left))
  })

  it('creates immutable versioned policies with enforced safety floors', () => {
    const policy = createLocalExecutionProfilePolicy({
      schemaVersion: 1,
      version: 'team-local-policy/v1',
      minimumHostTier: 'interactive',
      headroom: {
        osSystemMemoryBytes: bytes(4),
        developerSystemMemoryBytes: bytes(6),
        developerAcceleratorMemoryBytes: bytes(2),
        storageBytes: bytes(12)
      },
      maximumProfiles: 3,
      workloadPriority: ['coding', 'interactive'],
      runtimePreference: ['portable', 'host-optimized']
    })

    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.headroom)).toBe(true)
    expect(() => assertLocalExecutionProfilePolicy(policy)).not.toThrow()

    const belowFloor = structuredClone(policy)
    belowFloor.headroom.storageBytes = bytes(1)
    expect(() => assertLocalExecutionProfilePolicy(belowFloor)).toThrow(/below the safety floor/)
  })

  it('rejects incomplete, impossible, unknown, path-like, and secret-like adapter data', () => {
    const checks: Array<[RegExp, (value: LocalExecutionProfileCandidate) => void]> = [
      [/every workload/, (value) => void value.suitability.pop()],
      [/maxOutputTokens/, (value) => (value.configuration.maxOutputTokens = value.configuration.contextTokens + 1)],
      [/system memory pool/, (value) => (value.resources.memoryPool = 'system')],
      [/at least one evidence/, (value) => (value.evidenceRefs = [])],
      [/safe references/, (value) => (value.evidenceRefs = ['/Users/me/model.gguf'])],
      [/safe references/, (value) => (value.evidenceRefs = ['https://models.example/artifact'])],
      [/safe component/, (value) => (value.artifact.revision = 'token=secret')]
    ]

    for (const [message, mutate] of checks) {
      const value = candidate()
      mutate(value)
      expect(() => assertLocalExecutionProfileCandidate(value)).toThrow(message)
    }

    const unknownField = candidate() as LocalExecutionProfileCandidate & { downloadUrl?: string }
    unknownField.downloadUrl = 'models/artifact'
    expect(() => assertLocalExecutionProfileCandidate(unknownField)).toThrow(/not allowed/)
  })

  it('rejects tampered policies and exposes structured issues without unsafe payloads', () => {
    const tampered = structuredClone(DEFAULT_LOCAL_EXECUTION_PROFILE_POLICY)
    tampered.maximumProfiles = 31
    expect(() => assertLocalExecutionProfilePolicy(tampered)).toThrow(/does not match/)

    const unsafe = candidate()
    unsafe.runtime.runtimeId = 'authorization=Bearer very-secret-value'
    try {
      assertLocalExecutionProfileCandidate(unsafe)
      throw new Error('expected candidate validation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(LocalProfileContractError)
      expect((error as LocalProfileContractError).issues).toContain('candidate.runtime.runtimeId must be a safe component')
      expect(JSON.stringify((error as LocalProfileContractError).issues)).not.toContain('very-secret-value')
    }
  })
})
