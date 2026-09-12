import {
  assertHostCapabilitySnapshot,
  createHostCapabilitySnapshot,
  DEFAULT_HOST_VIABILITY_POLICY,
  deriveHostInferenceViability,
  HostCapabilityContractError,
  type HostAcceleratorDevice,
  type HostCapabilityEvidence,
  type HostCapabilityObservation,
  type HostInferenceViabilityTier
} from '../../../execution'

const OBSERVED_AT = '2026-09-12T12:00:00.000Z'
const VALID_UNTIL = '2026-09-12T12:05:00.000Z'
const GIB = 1024n * 1024n * 1024n
const bytes = (gib: number): string => String(BigInt(gib) * GIB)

function observed<T>(value: T, sourceId: string): HostCapabilityEvidence<T> {
  return { state: 'observed', value, sourceId, observedAt: OBSERVED_AT }
}

function unknown<T>(sourceId: string, reasonCode = 'source-not-available'): HostCapabilityEvidence<T> {
  return { state: 'unknown', value: null, sourceId, observedAt: OBSERVED_AT, reasonCode }
}

function accelerator(memoryGiB: number): HostAcceleratorDevice {
  return { backend: 'metal', deviceClass: 'integrated', memoryKind: 'unified', memoryBytes: bytes(memoryGiB) }
}

function observation(
  options: {
    total?: number
    available?: number
    disk?: number
    cores?: number
    accelerators?: HostAcceleratorDevice[]
  } = {}
): HostCapabilityObservation {
  const cores = options.cores ?? 8
  return {
    schemaVersion: 1,
    observedAt: OBSERVED_AT,
    validUntil: VALID_UNTIL,
    platform: {
      os: observed('macos', 'node/process-platform'),
      architecture: observed('arm64', 'node/process-arch')
    },
    cpu: {
      logicalCores: observed(cores, 'node/os-cpus/logical'),
      physicalCores: observed(Math.min(cores, 8), 'darwin/sysctl/physicalcpu'),
      features: observed(['sha256', 'aes', 'asimd'], 'darwin/sysctl/cpu-features')
    },
    accelerators: observed(options.accelerators ?? [accelerator(32)], 'darwin/system-profiler/displays'),
    memory: {
      totalBytes: observed(bytes(options.total ?? 64), 'node/os-totalmem'),
      availableBytes: observed(bytes(options.available ?? 16), 'node/os-freemem')
    },
    storage: { availableBytes: observed(bytes(options.disk ?? 64), 'node/statfs/working-filesystem') }
  }
}

describe('host capability contract (#739)', () => {
  it.each<[HostInferenceViabilityTier, Partial<Parameters<typeof observation>[0]>]>([
    ['high-capability', {}],
    ['coding-capable', { total: 32, available: 8, disk: 32, accelerators: [accelerator(16)] }],
    ['interactive', { total: 16, available: 4, disk: 16, cores: 4, accelerators: [{ backend: 'none', deviceClass: 'unknown', memoryKind: 'unknown', memoryBytes: null }] }],
    ['background-only', { total: 8, available: 2, disk: 8, cores: 2, accelerators: [{ backend: 'none', deviceClass: 'unknown', memoryKind: 'unknown', memoryBytes: null }] }],
    ['unsupported', { total: 4, available: 1, disk: 4, cores: 1, accelerators: [{ backend: 'none', deviceClass: 'unknown', memoryKind: 'unknown', memoryBytes: null }] }]
  ])('derives the conservative %s tier at its policy boundary', (tier, overrides) => {
    const result = createHostCapabilitySnapshot(observation(overrides))

    expect(result.viability.tier).toBe(tier)
    expect(result.viability.constraintCodes).toEqual(expect.arrayContaining(['model-fit-not-established', 'runtime-availability-not-established']))
    expect(result.viability.policyId).toBe(DEFAULT_HOST_VIABILITY_POLICY.id)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.cpu.features.value)).toBe(true)
    expect(() => assertHostCapabilitySnapshot(result)).not.toThrow()
  })

  it('canonicalizes unordered public evidence into a stable immutable snapshot', () => {
    const left = observation({ accelerators: [accelerator(32), { backend: 'cuda', deviceClass: 'discrete', memoryKind: 'dedicated', memoryBytes: bytes(48) }] })
    const right = structuredClone(left)
    right.cpu.features.value = [...right.cpu.features.value!].reverse()
    right.accelerators.value = [...right.accelerators.value!].reverse()

    const first = createHostCapabilitySnapshot(left)
    const second = createHostCapabilitySnapshot(right)

    expect(second.id).toBe(first.id)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(first.cpu.features.value).toEqual(['aes', 'asimd', 'sha256'])
  })

  it('explains why a viable host does not qualify for the next tier', () => {
    const result = createHostCapabilitySnapshot(observation({ total: 32, available: 8, disk: 32, accelerators: [accelerator(16)] }))

    expect(result.viability.tier).toBe('coding-capable')
    expect(result.viability.constraintCodes).toEqual(expect.arrayContaining(['total-memory-below-tier', 'available-memory-below-tier', 'storage-capacity-below-tier', 'accelerator-memory-below-tier']))
  })

  it('preserves unknown facts and does not promote incomplete evidence', () => {
    const input = observation()
    input.accelerators = unknown('darwin/system-profiler/displays', 'probe-timeout')
    input.memory.availableBytes = unknown('node/os-freemem', 'metric-not-established')

    const result = createHostCapabilitySnapshot(input)

    expect(result.accelerators).toMatchObject({ state: 'unknown', value: null, reasonCode: 'probe-timeout' })
    expect(result.viability.tier).toBe('unsupported')
    expect(result.viability.constraintCodes).toEqual(expect.arrayContaining(['available-memory-unknown']))
  })

  it('rejects impossible capacities, duplicate devices, unknown fields, unsafe references, and tampering', () => {
    const impossible = observation({ total: 8, available: 16 })
    expect(() => createHostCapabilitySnapshot(impossible)).toThrow(/availableBytes cannot exceed/)

    const duplicates = observation({ accelerators: [accelerator(32), accelerator(32)] })
    expect(() => createHostCapabilitySnapshot(duplicates)).toThrow(/duplicate devices/)

    const unknownField = { ...observation(), rawOutput: 'system profiler payload' }
    expect(() => createHostCapabilitySnapshot(unknownField as HostCapabilityObservation)).toThrow(/rawOutput is not allowed/)

    const unsafe = observation()
    unsafe.cpu.features.sourceId = 'authorization=Bearer-secret'
    expect(() => createHostCapabilitySnapshot(unsafe)).toThrow(/safe reference/)

    const tampered = structuredClone(createHostCapabilitySnapshot(observation()))
    tampered.memory.totalBytes.value = bytes(32)
    expect(() => assertHostCapabilitySnapshot(tampered)).toThrow(/id does not match/)
  })

  it('rejects non-canonical snapshots and invalid policies', () => {
    const snapshot = structuredClone(createHostCapabilitySnapshot(observation()))
    snapshot.cpu.features.value = [...snapshot.cpu.features.value!].reverse()
    expect(() => assertHostCapabilitySnapshot(snapshot)).toThrow(/not canonical/)

    const policy = structuredClone(DEFAULT_HOST_VIABILITY_POLICY)
    policy.tiers[0].minimumLogicalCores = 1
    expect(() => deriveHostInferenceViability(observation(), policy)).toThrow(/policy.id does not match/)
  })

  it('returns structured validation issues without retaining caller values', () => {
    try {
      createHostCapabilitySnapshot({} as HostCapabilityObservation)
      throw new Error('expected contract validation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(HostCapabilityContractError)
      expect((error as HostCapabilityContractError).issues).toEqual(expect.arrayContaining(['schemaVersion must be 1', 'platform must be an object']))
      expect(JSON.stringify((error as HostCapabilityContractError).issues)).not.toContain('process.env')
    }
  })
})
