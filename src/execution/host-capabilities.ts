import { stableFingerprint } from './overrides'

const SAFE_REFERENCE = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i
const FINGERPRINT = /^[a-f0-9]{64}$/
const DECIMAL_INTEGER = /^(?:0|[1-9]\d*)$/
const MAX_BYTES = 2n ** 64n - 1n
const MAX_FEATURES = 128
const MAX_ACCELERATORS = 16
const MAX_CONSTRAINTS = 32
const SECRET_LIKE =
  /(?:\bBearer\s+|\b(?:sk|gh[pousr]|github_pat|xox[baprs])[_-]|\beyJ[a-zA-Z0-9_-]{8,}\.|(?:api[_-]?key|authorization|client[_-]?secret|cookie|credentials?|password|private[_-]?key|refresh[_-]?token|session[_-]?id|access[_-]?token|token)\s*[:=])/i

export type HostEvidenceState = 'observed' | 'unknown' | 'unavailable' | 'failed'
export type HostOsFamily = 'macos' | 'linux' | 'windows' | 'unknown'
export type HostArchitecture = 'arm64' | 'x64' | 'x86' | 'riscv64' | 'unknown'
export type HostAcceleratorBackend = 'metal' | 'cuda' | 'rocm' | 'directml' | 'vulkan' | 'none' | 'unknown'
export type HostAcceleratorDeviceClass = 'integrated' | 'discrete' | 'unknown'
export type HostAcceleratorMemoryKind = 'unified' | 'dedicated' | 'shared' | 'unknown'
export type HostInferenceViabilityTier = 'unsupported' | 'background-only' | 'interactive' | 'coding-capable' | 'high-capability'

export interface HostCapabilityEvidence<T> {
  state: HostEvidenceState
  value: T | null
  sourceId: string
  observedAt: string
  reasonCode?: string
}

export interface HostAcceleratorDevice {
  backend: HostAcceleratorBackend
  deviceClass: HostAcceleratorDeviceClass
  memoryKind: HostAcceleratorMemoryKind
  memoryBytes: string | null
}

export interface HostCapabilityObservation {
  schemaVersion: 1
  observedAt: string
  validUntil: string
  platform: {
    os: HostCapabilityEvidence<HostOsFamily>
    architecture: HostCapabilityEvidence<HostArchitecture>
  }
  cpu: {
    logicalCores: HostCapabilityEvidence<number>
    physicalCores: HostCapabilityEvidence<number>
    features: HostCapabilityEvidence<string[]>
  }
  accelerators: HostCapabilityEvidence<HostAcceleratorDevice[]>
  memory: {
    totalBytes: HostCapabilityEvidence<string>
    availableBytes: HostCapabilityEvidence<string>
  }
  storage: {
    availableBytes: HostCapabilityEvidence<string>
  }
}

export interface HostViabilityPolicy {
  schemaVersion: 1
  id: string
  version: string
  supportedOs: Exclude<HostOsFamily, 'unknown'>[]
  supportedArchitectures: Exclude<HostArchitecture, 'unknown'>[]
  tiers: Array<{
    tier: Exclude<HostInferenceViabilityTier, 'unsupported'>
    minimumLogicalCores: number
    minimumTotalMemoryBytes: string
    minimumAvailableMemoryBytes: string
    minimumAvailableStorageBytes: string
    acceleratorRequired: boolean
    minimumAcceleratorMemoryBytes: string
  }>
}

export type HostViabilityConstraintCode =
  | 'platform-unknown'
  | 'platform-unsupported'
  | 'architecture-unknown'
  | 'architecture-unsupported'
  | 'logical-cores-unknown'
  | 'logical-cores-below-tier'
  | 'total-memory-unknown'
  | 'total-memory-below-tier'
  | 'available-memory-unknown'
  | 'available-memory-below-tier'
  | 'storage-capacity-unknown'
  | 'storage-capacity-below-tier'
  | 'accelerator-unknown'
  | 'accelerator-required'
  | 'accelerator-memory-unknown'
  | 'accelerator-memory-below-tier'
  | 'model-fit-not-established'
  | 'runtime-availability-not-established'

const VIABILITY_CONSTRAINTS: HostViabilityConstraintCode[] = [
  'platform-unknown',
  'platform-unsupported',
  'architecture-unknown',
  'architecture-unsupported',
  'logical-cores-unknown',
  'logical-cores-below-tier',
  'total-memory-unknown',
  'total-memory-below-tier',
  'available-memory-unknown',
  'available-memory-below-tier',
  'storage-capacity-unknown',
  'storage-capacity-below-tier',
  'accelerator-unknown',
  'accelerator-required',
  'accelerator-memory-unknown',
  'accelerator-memory-below-tier',
  'model-fit-not-established',
  'runtime-availability-not-established'
]

export interface HostInferenceViability {
  tier: HostInferenceViabilityTier
  policyId: string
  constraintCodes: HostViabilityConstraintCode[]
  evidenceRefs: string[]
}

export interface HostCapabilitySnapshot extends HostCapabilityObservation {
  id: string
  viability: HostInferenceViability
  evidenceRefs: string[]
}

export class HostCapabilityContractError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`Invalid host capability contract: ${issues.join('; ')}`)
    this.name = 'HostCapabilityContractError'
    this.issues = [...issues]
  }
}

const gib = (value: number): string => String(BigInt(value) * 1024n * 1024n * 1024n)

function policyWithoutId(value: Omit<HostViabilityPolicy, 'id'>): HostViabilityPolicy {
  return { ...value, id: stableFingerprint(value) }
}

export const DEFAULT_HOST_VIABILITY_POLICY: HostViabilityPolicy = freeze(
  policyWithoutId({
    schemaVersion: 1,
    version: 'sf-host-viability/v1',
    supportedOs: ['linux', 'macos', 'windows'],
    supportedArchitectures: ['arm64', 'x64'],
    tiers: [
      {
        tier: 'high-capability',
        minimumLogicalCores: 8,
        minimumTotalMemoryBytes: gib(64),
        minimumAvailableMemoryBytes: gib(16),
        minimumAvailableStorageBytes: gib(64),
        acceleratorRequired: true,
        minimumAcceleratorMemoryBytes: gib(32)
      },
      {
        tier: 'coding-capable',
        minimumLogicalCores: 8,
        minimumTotalMemoryBytes: gib(32),
        minimumAvailableMemoryBytes: gib(8),
        minimumAvailableStorageBytes: gib(32),
        acceleratorRequired: true,
        minimumAcceleratorMemoryBytes: gib(16)
      },
      {
        tier: 'interactive',
        minimumLogicalCores: 4,
        minimumTotalMemoryBytes: gib(16),
        minimumAvailableMemoryBytes: gib(4),
        minimumAvailableStorageBytes: gib(16),
        acceleratorRequired: false,
        minimumAcceleratorMemoryBytes: '0'
      },
      {
        tier: 'background-only',
        minimumLogicalCores: 2,
        minimumTotalMemoryBytes: gib(8),
        minimumAvailableMemoryBytes: gib(2),
        minimumAvailableStorageBytes: gib(8),
        acceleratorRequired: false,
        minimumAcceleratorMemoryBytes: '0'
      }
    ]
  })
)

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[], label: string, issues: string[]): void {
  for (const field of Object.keys(value)) if (!allowed.includes(field)) issues.push(`${label}.${field} is not allowed`)
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) freeze(entry)
    Object.freeze(value)
  }
  return value
}

function date(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function safeReference(value: unknown): value is string {
  return typeof value === 'string' && SAFE_REFERENCE.test(value) && !SECRET_LIKE.test(value)
}

function byteString(value: unknown): value is string {
  if (typeof value !== 'string' || !DECIMAL_INTEGER.test(value) || value.length > 20) return false
  try {
    return BigInt(value) <= MAX_BYTES
  } catch {
    return false
  }
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 1024
}

function canonicalEvidence<T>(evidence: HostCapabilityEvidence<T>, canonicalValue?: (value: T) => T): HostCapabilityEvidence<T> {
  return {
    state: evidence.state,
    value: evidence.value === null || !canonicalValue ? evidence.value : canonicalValue(evidence.value),
    sourceId: evidence.sourceId,
    observedAt: evidence.observedAt,
    ...(evidence.reasonCode ? { reasonCode: evidence.reasonCode } : {})
  }
}

function validateEvidence<T>(value: unknown, label: string, issues: string[], validateValue: (entry: unknown, path: string, issues: string[]) => entry is T): value is HostCapabilityEvidence<T> {
  if (!object(value)) {
    issues.push(`${label} must be an evidence object`)
    return false
  }
  exactFields(value, ['state', 'value', 'sourceId', 'observedAt', 'reasonCode'], label, issues)
  if (!['observed', 'unknown', 'unavailable', 'failed'].includes(String(value.state))) issues.push(`${label}.state is unsupported`)
  if (!safeReference(value.sourceId)) issues.push(`${label}.sourceId must be a safe reference`)
  if (!date(value.observedAt)) issues.push(`${label}.observedAt must be a canonical UTC timestamp`)
  if (value.reasonCode !== undefined && !safeReference(value.reasonCode)) issues.push(`${label}.reasonCode must be a safe reference`)
  if (value.state === 'observed') {
    if (value.value === null || value.value === undefined) issues.push(`${label}.value is required when observed`)
    else validateValue(value.value, `${label}.value`, issues)
    if (value.reasonCode !== undefined) issues.push(`${label}.reasonCode is not allowed when observed`)
  } else {
    if (value.value !== null) issues.push(`${label}.value must be null unless observed`)
    if (value.reasonCode === undefined) issues.push(`${label}.reasonCode is required unless observed`)
  }
  return true
}

function enumValue<T extends string>(allowed: readonly T[]) {
  return (value: unknown, label: string, issues: string[]): value is T => {
    if (!allowed.includes(value as T)) issues.push(`${label} is unsupported`)
    return allowed.includes(value as T)
  }
}

function integerValue(value: unknown, label: string, issues: string[]): value is number {
  if (!positiveInteger(value)) issues.push(`${label} must be a bounded positive integer`)
  return positiveInteger(value)
}

function bytesValue(value: unknown, label: string, issues: string[]): value is string {
  if (!byteString(value)) issues.push(`${label} must be an exact bounded byte string`)
  return byteString(value)
}

function featuresValue(value: unknown, label: string, issues: string[]): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_FEATURES || !value.every(safeReference) || new Set(value).size !== value.length) {
    issues.push(`${label} must contain unique bounded feature identifiers`)
    return false
  }
  return true
}

function acceleratorsValue(value: unknown, label: string, issues: string[]): value is HostAcceleratorDevice[] {
  if (!Array.isArray(value) || value.length > MAX_ACCELERATORS) {
    issues.push(`${label} must be a bounded accelerator array`)
    return false
  }
  value.forEach((entry, index) => {
    const path = `${label}[${index}]`
    if (!object(entry)) {
      issues.push(`${path} must be an object`)
      return
    }
    exactFields(entry, ['backend', 'deviceClass', 'memoryKind', 'memoryBytes'], path, issues)
    enumValue<HostAcceleratorBackend>(['metal', 'cuda', 'rocm', 'directml', 'vulkan', 'none', 'unknown'])(entry.backend, `${path}.backend`, issues)
    enumValue<HostAcceleratorDeviceClass>(['integrated', 'discrete', 'unknown'])(entry.deviceClass, `${path}.deviceClass`, issues)
    enumValue<HostAcceleratorMemoryKind>(['unified', 'dedicated', 'shared', 'unknown'])(entry.memoryKind, `${path}.memoryKind`, issues)
    if (entry.memoryBytes !== null && !byteString(entry.memoryBytes)) issues.push(`${path}.memoryBytes must be null or an exact bounded byte string`)
    if (entry.backend === 'none' && (entry.memoryBytes !== null || entry.memoryKind !== 'unknown')) issues.push(`${path} cannot attach memory to the none backend`)
  })
  if (value.every(object) && new Set(value.map((entry) => stableFingerprint(entry))).size !== value.length) issues.push(`${label} cannot contain duplicate devices`)
  return true
}

function canonicalAccelerators(value: HostAcceleratorDevice[]): HostAcceleratorDevice[] {
  return value
    .map((entry) => ({ ...entry }))
    .sort((left, right) =>
      `${left.backend}/${left.deviceClass}/${left.memoryKind}/${left.memoryBytes ?? ''}`.localeCompare(`${right.backend}/${right.deviceClass}/${right.memoryKind}/${right.memoryBytes ?? ''}`)
    )
}

function evidenceRefs(observation: HostCapabilityObservation): string[] {
  return [
    ...new Set([
      observation.platform.os.sourceId,
      observation.platform.architecture.sourceId,
      observation.cpu.logicalCores.sourceId,
      observation.cpu.physicalCores.sourceId,
      observation.cpu.features.sourceId,
      observation.accelerators.sourceId,
      observation.memory.totalBytes.sourceId,
      observation.memory.availableBytes.sourceId,
      observation.storage.availableBytes.sourceId
    ])
  ].sort()
}

function observed<T>(evidence: HostCapabilityEvidence<T>): T | null {
  return evidence.state === 'observed' ? evidence.value : null
}

function below(actual: string | null, required: string): boolean {
  return actual !== null && BigInt(actual) < BigInt(required)
}

function acceleratorMemory(value: HostAcceleratorDevice[] | null): string | null {
  if (!value) return null
  return value.reduce<string | null>((maximum, entry) => {
    if (entry.backend === 'none' || entry.backend === 'unknown' || entry.memoryBytes === null) return maximum
    return maximum === null || BigInt(entry.memoryBytes) > BigInt(maximum) ? entry.memoryBytes : maximum
  }, null)
}

function hasAccelerator(value: HostAcceleratorDevice[] | null): boolean {
  return value?.some((entry) => !['none', 'unknown'].includes(entry.backend)) ?? false
}

function tierConstraints(observation: HostCapabilityObservation, tier: HostViabilityPolicy['tiers'][number]): HostViabilityConstraintCode[] {
  const constraints: HostViabilityConstraintCode[] = []
  const logicalCores = observed(observation.cpu.logicalCores)
  const totalMemory = observed(observation.memory.totalBytes)
  const availableMemory = observed(observation.memory.availableBytes)
  const storage = observed(observation.storage.availableBytes)
  const accelerators = observed(observation.accelerators)
  const acceleratorBytes = acceleratorMemory(accelerators)
  if (logicalCores === null) constraints.push('logical-cores-unknown')
  else if (logicalCores < tier.minimumLogicalCores) constraints.push('logical-cores-below-tier')
  if (totalMemory === null) constraints.push('total-memory-unknown')
  else if (below(totalMemory, tier.minimumTotalMemoryBytes)) constraints.push('total-memory-below-tier')
  if (availableMemory === null) constraints.push('available-memory-unknown')
  else if (below(availableMemory, tier.minimumAvailableMemoryBytes)) constraints.push('available-memory-below-tier')
  if (storage === null) constraints.push('storage-capacity-unknown')
  else if (below(storage, tier.minimumAvailableStorageBytes)) constraints.push('storage-capacity-below-tier')
  if (tier.acceleratorRequired) {
    if (accelerators === null) constraints.push('accelerator-unknown')
    else if (!hasAccelerator(accelerators)) constraints.push('accelerator-required')
    else if (acceleratorBytes === null) constraints.push('accelerator-memory-unknown')
    else if (below(acceleratorBytes, tier.minimumAcceleratorMemoryBytes)) constraints.push('accelerator-memory-below-tier')
  }
  return constraints
}

export function deriveHostInferenceViability(observation: HostCapabilityObservation, policy: HostViabilityPolicy = DEFAULT_HOST_VIABILITY_POLICY): HostInferenceViability {
  const issues: string[] = []
  validateObservation(observation, issues)
  if (issues.length) throw new HostCapabilityContractError(issues)
  assertHostViabilityPolicy(policy)
  observation = canonicalObservation(observation)
  const constraints: HostViabilityConstraintCode[] = []
  const os = observed(observation.platform.os)
  const architecture = observed(observation.platform.architecture)
  if (os === null || os === 'unknown') constraints.push('platform-unknown')
  else if (!policy.supportedOs.includes(os)) constraints.push('platform-unsupported')
  if (architecture === null || architecture === 'unknown') constraints.push('architecture-unknown')
  else if (!policy.supportedArchitectures.includes(architecture)) constraints.push('architecture-unsupported')

  let tier: HostInferenceViabilityTier = 'unsupported'
  if (constraints.length === 0) {
    for (const [index, candidate] of policy.tiers.entries()) {
      const candidateConstraints = tierConstraints(observation, candidate)
      if (candidateConstraints.length === 0) {
        tier = candidate.tier
        if (index > 0) constraints.push(...tierConstraints(observation, policy.tiers[index - 1]))
        break
      }
    }
  }
  if (tier === 'unsupported' && constraints.length === 0) constraints.push(...tierConstraints(observation, policy.tiers[policy.tiers.length - 1]))
  constraints.push('model-fit-not-established', 'runtime-availability-not-established')
  return {
    tier,
    policyId: policy.id,
    constraintCodes: [...new Set(constraints)].sort(),
    evidenceRefs: evidenceRefs(observation)
  }
}

export function assertHostViabilityPolicy(value: unknown): asserts value is HostViabilityPolicy {
  const issues: string[] = []
  if (!object(value)) throw new HostCapabilityContractError(['viability policy must be an object'])
  exactFields(value, ['schemaVersion', 'id', 'version', 'supportedOs', 'supportedArchitectures', 'tiers'], 'viability policy', issues)
  if (value.schemaVersion !== 1) issues.push('viability policy.schemaVersion must be 1')
  if (!safeReference(value.version)) issues.push('viability policy.version must be a safe reference')
  if (!FINGERPRINT.test(String(value.id))) issues.push('viability policy.id must be a fingerprint')
  if (!Array.isArray(value.supportedOs) || !value.supportedOs.every((entry) => ['macos', 'linux', 'windows'].includes(String(entry)))) issues.push('viability policy.supportedOs is invalid')
  if (!Array.isArray(value.supportedArchitectures) || !value.supportedArchitectures.every((entry) => ['arm64', 'x64', 'x86', 'riscv64'].includes(String(entry))))
    issues.push('viability policy.supportedArchitectures is invalid')
  if (!Array.isArray(value.tiers) || value.tiers.length !== 4) issues.push('viability policy.tiers must define four supported tiers')
  else {
    const expectedOrder = ['high-capability', 'coding-capable', 'interactive', 'background-only']
    value.tiers.forEach((tier, index) => {
      const path = `viability policy.tiers[${index}]`
      if (!object(tier)) {
        issues.push(`${path} must be an object`)
        return
      }
      exactFields(
        tier,
        ['tier', 'minimumLogicalCores', 'minimumTotalMemoryBytes', 'minimumAvailableMemoryBytes', 'minimumAvailableStorageBytes', 'acceleratorRequired', 'minimumAcceleratorMemoryBytes'],
        path,
        issues
      )
      if (tier.tier !== expectedOrder[index]) issues.push(`${path}.tier must preserve descending capability order`)
      if (!positiveInteger(tier.minimumLogicalCores)) issues.push(`${path}.minimumLogicalCores is invalid`)
      for (const field of ['minimumTotalMemoryBytes', 'minimumAvailableMemoryBytes', 'minimumAvailableStorageBytes', 'minimumAcceleratorMemoryBytes'] as const)
        if (!byteString(tier[field])) issues.push(`${path}.${field} must be an exact byte string`)
      if (typeof tier.acceleratorRequired !== 'boolean') issues.push(`${path}.acceleratorRequired must be boolean`)
    })
  }
  if (issues.length === 0) {
    const { id, ...withoutId } = value
    if (stableFingerprint(withoutId) !== id) issues.push('viability policy.id does not match its canonical content')
  }
  if (issues.length) throw new HostCapabilityContractError(issues)
}

function validateObservation(value: unknown, issues: string[], snapshot = false): value is HostCapabilityObservation {
  if (!object(value)) {
    issues.push('observation must be an object')
    return false
  }
  exactFields(
    value,
    snapshot
      ? ['schemaVersion', 'id', 'observedAt', 'validUntil', 'platform', 'cpu', 'accelerators', 'memory', 'storage', 'viability', 'evidenceRefs']
      : ['schemaVersion', 'observedAt', 'validUntil', 'platform', 'cpu', 'accelerators', 'memory', 'storage'],
    snapshot ? 'snapshot' : 'observation',
    issues
  )
  if (value.schemaVersion !== 1) issues.push('schemaVersion must be 1')
  if (!date(value.observedAt)) issues.push('observedAt must be a canonical UTC timestamp')
  if (!date(value.validUntil)) issues.push('validUntil must be a canonical UTC timestamp')
  if (date(value.observedAt) && date(value.validUntil) && Date.parse(value.validUntil) <= Date.parse(value.observedAt)) issues.push('validUntil must be later than observedAt')
  if (!object(value.platform)) issues.push('platform must be an object')
  else {
    exactFields(value.platform, ['os', 'architecture'], 'platform', issues)
    validateEvidence(value.platform.os, 'platform.os', issues, enumValue<HostOsFamily>(['macos', 'linux', 'windows', 'unknown']))
    validateEvidence(value.platform.architecture, 'platform.architecture', issues, enumValue<HostArchitecture>(['arm64', 'x64', 'x86', 'riscv64', 'unknown']))
  }
  if (!object(value.cpu)) issues.push('cpu must be an object')
  else {
    exactFields(value.cpu, ['logicalCores', 'physicalCores', 'features'], 'cpu', issues)
    validateEvidence(value.cpu.logicalCores, 'cpu.logicalCores', issues, integerValue)
    validateEvidence(value.cpu.physicalCores, 'cpu.physicalCores', issues, integerValue)
    validateEvidence(value.cpu.features, 'cpu.features', issues, featuresValue)
  }
  validateEvidence(value.accelerators, 'accelerators', issues, acceleratorsValue)
  if (!object(value.memory)) issues.push('memory must be an object')
  else {
    exactFields(value.memory, ['totalBytes', 'availableBytes'], 'memory', issues)
    validateEvidence(value.memory.totalBytes, 'memory.totalBytes', issues, bytesValue)
    validateEvidence(value.memory.availableBytes, 'memory.availableBytes', issues, bytesValue)
  }
  if (!object(value.storage)) issues.push('storage must be an object')
  else {
    exactFields(value.storage, ['availableBytes'], 'storage', issues)
    validateEvidence(value.storage.availableBytes, 'storage.availableBytes', issues, bytesValue)
  }
  if (object(value.cpu) && object(value.cpu.logicalCores) && object(value.cpu.physicalCores) && value.cpu.logicalCores.state === 'observed' && value.cpu.physicalCores.state === 'observed') {
    if (Number(value.cpu.physicalCores.value) > Number(value.cpu.logicalCores.value)) issues.push('cpu.physicalCores cannot exceed cpu.logicalCores')
  }
  if (
    object(value.memory) &&
    object(value.memory.totalBytes) &&
    object(value.memory.availableBytes) &&
    value.memory.totalBytes.state === 'observed' &&
    value.memory.availableBytes.state === 'observed'
  ) {
    if (byteString(value.memory.totalBytes.value) && byteString(value.memory.availableBytes.value) && BigInt(value.memory.availableBytes.value) > BigInt(value.memory.totalBytes.value))
      issues.push('memory.availableBytes cannot exceed memory.totalBytes')
  }
  return true
}

function canonicalObservation(value: HostCapabilityObservation): HostCapabilityObservation {
  return {
    schemaVersion: 1,
    observedAt: value.observedAt,
    validUntil: value.validUntil,
    platform: {
      os: canonicalEvidence(value.platform.os),
      architecture: canonicalEvidence(value.platform.architecture)
    },
    cpu: {
      logicalCores: canonicalEvidence(value.cpu.logicalCores),
      physicalCores: canonicalEvidence(value.cpu.physicalCores),
      features: canonicalEvidence(value.cpu.features, (features) => [...features].sort())
    },
    accelerators: canonicalEvidence(value.accelerators, canonicalAccelerators),
    memory: {
      totalBytes: canonicalEvidence(value.memory.totalBytes),
      availableBytes: canonicalEvidence(value.memory.availableBytes)
    },
    storage: { availableBytes: canonicalEvidence(value.storage.availableBytes) }
  }
}

export function createHostCapabilitySnapshot(observation: HostCapabilityObservation, policy: HostViabilityPolicy = DEFAULT_HOST_VIABILITY_POLICY): HostCapabilitySnapshot {
  const issues: string[] = []
  validateObservation(observation, issues)
  assertHostViabilityPolicy(policy)
  if (issues.length) throw new HostCapabilityContractError(issues)
  const canonical = canonicalObservation(observation)
  const snapshotWithoutId = {
    ...canonical,
    viability: deriveHostInferenceViability(canonical, policy),
    evidenceRefs: evidenceRefs(canonical)
  }
  return freeze({ ...snapshotWithoutId, id: stableFingerprint(snapshotWithoutId) })
}

export function assertHostCapabilitySnapshot(value: unknown): asserts value is HostCapabilitySnapshot {
  const issues: string[] = []
  if (!object(value)) throw new HostCapabilityContractError(['snapshot must be an object'])
  exactFields(value, ['schemaVersion', 'id', 'observedAt', 'validUntil', 'platform', 'cpu', 'accelerators', 'memory', 'storage', 'viability', 'evidenceRefs'], 'snapshot', issues)
  validateObservation(value, issues, true)
  if (!FINGERPRINT.test(String(value.id))) issues.push('id must be a fingerprint')
  if (!object(value.viability)) issues.push('viability must be an object')
  else {
    exactFields(value.viability, ['tier', 'policyId', 'constraintCodes', 'evidenceRefs'], 'viability', issues)
    if (!['unsupported', 'background-only', 'interactive', 'coding-capable', 'high-capability'].includes(String(value.viability.tier))) issues.push('viability.tier is unsupported')
    if (!FINGERPRINT.test(String(value.viability.policyId))) issues.push('viability.policyId must be a fingerprint')
    if (
      !Array.isArray(value.viability.constraintCodes) ||
      value.viability.constraintCodes.length > MAX_CONSTRAINTS ||
      !value.viability.constraintCodes.every((entry) => VIABILITY_CONSTRAINTS.includes(entry as HostViabilityConstraintCode)) ||
      new Set(value.viability.constraintCodes).size !== value.viability.constraintCodes.length ||
      JSON.stringify(value.viability.constraintCodes) !== JSON.stringify([...value.viability.constraintCodes].sort())
    )
      issues.push('viability.constraintCodes must contain bounded safe codes')
    if (
      !Array.isArray(value.viability.evidenceRefs) ||
      !value.viability.evidenceRefs.every(safeReference) ||
      new Set(value.viability.evidenceRefs).size !== value.viability.evidenceRefs.length ||
      JSON.stringify(value.viability.evidenceRefs) !== JSON.stringify([...value.viability.evidenceRefs].sort())
    )
      issues.push('viability.evidenceRefs must contain canonical safe references')
  }
  if (
    !Array.isArray(value.evidenceRefs) ||
    !value.evidenceRefs.every(safeReference) ||
    new Set(value.evidenceRefs).size !== value.evidenceRefs.length ||
    JSON.stringify(value.evidenceRefs) !== JSON.stringify([...value.evidenceRefs].sort())
  )
    issues.push('evidenceRefs must contain canonical safe references')
  if (issues.length === 0) {
    const canonical = canonicalObservation(value as unknown as HostCapabilityObservation)
    const rawObservation = {
      schemaVersion: value.schemaVersion,
      observedAt: value.observedAt,
      validUntil: value.validUntil,
      platform: value.platform,
      cpu: value.cpu,
      accelerators: value.accelerators,
      memory: value.memory,
      storage: value.storage
    }
    if (stableFingerprint(rawObservation) !== stableFingerprint(canonical)) issues.push('snapshot evidence is not canonical')
    const { id, ...withoutId } = value
    if (stableFingerprint(withoutId) !== id) issues.push('id does not match snapshot content')
    if (stableFingerprint((value as unknown as HostCapabilitySnapshot).evidenceRefs) !== stableFingerprint(evidenceRefs(canonical))) issues.push('evidenceRefs must match canonical sources')
  }
  if (issues.length) throw new HostCapabilityContractError(issues)
}
