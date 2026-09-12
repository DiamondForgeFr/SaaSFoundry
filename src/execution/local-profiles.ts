import type { HostAcceleratorBackend, HostCapabilitySnapshot, HostInferenceViabilityTier } from './host-capabilities'
import { stableFingerprint } from './overrides'

const COMPONENT = /^[a-z0-9][a-z0-9._:-]{0,127}$/i
const REFERENCE = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i
const FINGERPRINT = /^[a-f0-9]{64}$/
const DECIMAL_INTEGER = /^(?:0|[1-9]\d*)$/
const POSITIVE_DECIMAL = /^(?:0\.(?:0*[1-9]\d*)|[1-9]\d*(?:\.\d+)?)$/
const MAX_BYTES = 2n ** 64n - 1n
const MAX_PROFILES = 32
const MAX_EVIDENCE_REFS = 32
const GIB = 1024n * 1024n * 1024n
const SECRET_LIKE =
  /(?:\bBearer\s+|\b(?:sk|gh[pousr]|github_pat|xox[baprs])[_-]|\beyJ[a-zA-Z0-9_-]{8,}\.|(?:api[_-]?key|authorization|client[_-]?secret|cookie|credentials?|password|private[_-]?key|refresh[_-]?token|session[_-]?id|access[_-]?token|token)\s*[:=])/i

export type LocalRuntimeOptimization = 'portable' | 'host-optimized'
export type LocalMemoryPool = 'system' | 'unified' | 'shared' | 'dedicated'
export type LocalWorkloadClass = 'background' | 'interactive' | 'coding' | 'high-capability'
export type LocalWorkloadSuitability = 'limited' | 'suitable' | 'preferred'
export type LocalProfileRecommendationStatus = 'profiles-available' | 'no-install-recommended'

export interface LocalProfileObservation {
  sourceId: string
  value: unknown
}

export interface LocalExecutionProfileCandidate {
  schemaVersion: 1
  runtime: {
    runtimeId: string
    backend: HostAcceleratorBackend
    optimization: LocalRuntimeOptimization
  }
  artifact: {
    artifactId: string
    modelId: string
    format: string
    quantization: string
    revision: string
    sha256: string
  }
  configuration: {
    contextTokens: number
    maxOutputTokens: number
    concurrency: number
  }
  resources: {
    artifactDownloadBytes: string
    installedDiskBytes: string
    systemMemoryBytes: string
    acceleratorMemoryBytes: string
    memoryPool: LocalMemoryPool
  }
  performance: {
    estimatedLatencyP95Ms: number
    estimatedTokensPerSecond: string
  }
  suitability: Array<{
    workload: LocalWorkloadClass
    rating: LocalWorkloadSuitability
  }>
  availability: {
    state: 'available' | 'unavailable'
    observedAt: string
    validUntil: string
    reasonCode?: string
  }
  evidenceRefs: string[]
}

export interface LocalExecutionProfileAdapter {
  readonly id: string
  discover(host: Readonly<HostCapabilitySnapshot>): Promise<readonly LocalProfileObservation[]> | readonly LocalProfileObservation[]
  normalize(observation: LocalProfileObservation): LocalExecutionProfileCandidate
}

export interface LocalExecutionProfilePolicy {
  schemaVersion: 1
  id: string
  version: string
  minimumHostTier: Exclude<HostInferenceViabilityTier, 'unsupported'>
  headroom: {
    osSystemMemoryBytes: string
    developerSystemMemoryBytes: string
    developerAcceleratorMemoryBytes: string
    storageBytes: string
  }
  maximumProfiles: number
  workloadPriority: LocalWorkloadClass[]
  runtimePreference: LocalRuntimeOptimization[]
}

export interface LocalExecutionProfile {
  id: string
  adapterId: string
  sourceId: string
  hostSnapshotId: string
  policyId: string
  rank: number
  runtime: LocalExecutionProfileCandidate['runtime']
  artifact: LocalExecutionProfileCandidate['artifact']
  configuration: LocalExecutionProfileCandidate['configuration']
  resources: LocalExecutionProfileCandidate['resources'] & {
    requiredDiskWithHeadroomBytes: string
    requiredSystemMemoryWithHeadroomBytes: string
    requiredAcceleratorMemoryWithHeadroomBytes: string
  }
  performance: LocalExecutionProfileCandidate['performance']
  suitability: LocalExecutionProfileCandidate['suitability']
  availability: LocalExecutionProfileCandidate['availability']
  tradeoffCodes: LocalProfileTradeoffCode[]
  evidenceRefs: string[]
}

export type LocalProfileTradeoffCode =
  | 'portable-runtime'
  | 'host-optimized-runtime'
  | 'cpu-system-memory'
  | 'unified-memory'
  | 'shared-accelerator-memory'
  | 'dedicated-accelerator-memory'
  | 'bounded-context'
  | 'bounded-concurrency'
  | 'estimated-latency'

export type LocalProfileExclusionCode =
  | 'adapter-failed'
  | 'invalid-candidate'
  | 'candidate-unavailable'
  | 'candidate-stale'
  | 'duplicate-profile'
  | 'host-tier-insufficient'
  | 'host-backend-unsupported'
  | 'host-capacity-unknown'
  | 'system-memory-insufficient'
  | 'accelerator-memory-insufficient'
  | 'storage-insufficient'
  | 'profile-limit'

export interface LocalProfileExclusion {
  adapterId: string
  sourceId: string
  profileId?: string
  code: LocalProfileExclusionCode
  constraintCodes: string[]
}

export type LocalRecommendationConstraintCode = 'host-unsupported' | 'host-stale' | 'host-tier-insufficient' | 'no-adapters' | 'no-profile-observations' | 'no-viable-profile'

export interface LocalExecutionProfileRecommendation {
  schemaVersion: 1
  id: string
  generatedAt: string
  hostSnapshotId: string
  policyId: string
  status: LocalProfileRecommendationStatus
  profiles: LocalExecutionProfile[]
  exclusions: LocalProfileExclusion[]
  constraintCodes: LocalRecommendationConstraintCode[]
  evidenceRefs: string[]
}

export interface RecommendLocalExecutionProfilesOptions {
  evaluatedAt: string
  policy?: LocalExecutionProfilePolicy
}

export class LocalProfileContractError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`Invalid local execution profile contract: ${issues.join('; ')}`)
    this.name = 'LocalProfileContractError'
    this.issues = [...issues]
  }
}

const gib = (value: number): string => String(BigInt(value) * GIB)

export const MINIMUM_LOCAL_PROFILE_HEADROOM = Object.freeze({
  osSystemMemoryBytes: gib(2),
  developerSystemMemoryBytes: gib(2),
  developerAcceleratorMemoryBytes: gib(1),
  storageBytes: gib(8)
})

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) freeze(entry)
    Object.freeze(value)
  }
  return value
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[], label: string, issues: string[]): void {
  for (const field of Object.keys(value)) if (!allowed.includes(field)) issues.push(`${label}.${field} is not allowed`)
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function safeComponent(value: unknown): value is string {
  return typeof value === 'string' && COMPONENT.test(value) && !SECRET_LIKE.test(value)
}

function safeReference(value: unknown): value is string {
  return typeof value === 'string' && REFERENCE.test(value) && !SECRET_LIKE.test(value) && !value.startsWith('/') && !/^[a-z]:\//i.test(value) && !value.includes('://')
}

function byteString(value: unknown, positive = false): value is string {
  if (typeof value !== 'string' || !DECIMAL_INTEGER.test(value) || value.length > 20) return false
  try {
    const parsed = BigInt(value)
    return parsed <= MAX_BYTES && (!positive || parsed > 0n)
  } catch {
    return false
  }
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
}

function safeList(value: unknown, label: string, issues: string[], limit = MAX_EVIDENCE_REFS): value is string[] {
  if (!Array.isArray(value) || value.length > limit || !value.every(safeReference) || new Set(value).size !== value.length) {
    issues.push(`${label} must contain unique bounded safe references`)
    return false
  }
  return true
}

function validateRuntime(value: unknown, label: string, issues: string[]): void {
  if (!object(value)) {
    issues.push(`${label} must be an object`)
    return
  }
  exactFields(value, ['runtimeId', 'backend', 'optimization'], label, issues)
  if (!safeComponent(value.runtimeId)) issues.push(`${label}.runtimeId must be a safe component`)
  if (!['metal', 'cuda', 'rocm', 'directml', 'vulkan', 'none'].includes(String(value.backend))) issues.push(`${label}.backend must be a concrete normalized backend`)
  if (!['portable', 'host-optimized'].includes(String(value.optimization))) issues.push(`${label}.optimization is unsupported`)
}

function validateArtifact(value: unknown, label: string, issues: string[]): void {
  if (!object(value)) {
    issues.push(`${label} must be an object`)
    return
  }
  exactFields(value, ['artifactId', 'modelId', 'format', 'quantization', 'revision', 'sha256'], label, issues)
  for (const field of ['artifactId', 'modelId', 'format', 'quantization', 'revision'] as const) if (!safeComponent(value[field])) issues.push(`${label}.${field} must be a safe component`)
  if (!FINGERPRINT.test(String(value.sha256))) issues.push(`${label}.sha256 must be a lowercase SHA-256 digest`)
}

function validateConfiguration(value: unknown, label: string, issues: string[]): void {
  if (!object(value)) {
    issues.push(`${label} must be an object`)
    return
  }
  exactFields(value, ['contextTokens', 'maxOutputTokens', 'concurrency'], label, issues)
  if (!boundedInteger(value.contextTokens, 1, 10_000_000)) issues.push(`${label}.contextTokens must be a bounded positive integer`)
  if (!boundedInteger(value.maxOutputTokens, 1, 1_000_000)) issues.push(`${label}.maxOutputTokens must be a bounded positive integer`)
  if (boundedInteger(value.contextTokens, 1, 10_000_000) && boundedInteger(value.maxOutputTokens, 1, 1_000_000) && value.maxOutputTokens > value.contextTokens)
    issues.push(`${label}.maxOutputTokens cannot exceed contextTokens`)
  if (!boundedInteger(value.concurrency, 1, 64)) issues.push(`${label}.concurrency must be between 1 and 64`)
}

function validateResources(value: unknown, label: string, issues: string[]): void {
  if (!object(value)) {
    issues.push(`${label} must be an object`)
    return
  }
  exactFields(value, ['artifactDownloadBytes', 'installedDiskBytes', 'systemMemoryBytes', 'acceleratorMemoryBytes', 'memoryPool'], label, issues)
  for (const field of ['artifactDownloadBytes', 'installedDiskBytes', 'systemMemoryBytes'] as const)
    if (!byteString(value[field], true)) issues.push(`${label}.${field} must be an exact positive byte string`)
  if (!byteString(value.acceleratorMemoryBytes)) issues.push(`${label}.acceleratorMemoryBytes must be an exact byte string`)
  if (!['system', 'unified', 'shared', 'dedicated'].includes(String(value.memoryPool))) issues.push(`${label}.memoryPool is unsupported`)
  if (value.memoryPool === 'system' && value.acceleratorMemoryBytes !== '0') issues.push(`${label}.acceleratorMemoryBytes must be zero for the system pool`)
  if (value.memoryPool !== 'system' && byteString(value.acceleratorMemoryBytes) && BigInt(value.acceleratorMemoryBytes) === 0n)
    issues.push(`${label}.acceleratorMemoryBytes must be positive for accelerator pools`)
}

function validatePerformance(value: unknown, label: string, issues: string[]): void {
  if (!object(value)) {
    issues.push(`${label} must be an object`)
    return
  }
  exactFields(value, ['estimatedLatencyP95Ms', 'estimatedTokensPerSecond'], label, issues)
  if (!boundedInteger(value.estimatedLatencyP95Ms, 1, 86_400_000)) issues.push(`${label}.estimatedLatencyP95Ms must be a bounded positive integer`)
  if (typeof value.estimatedTokensPerSecond !== 'string' || !POSITIVE_DECIMAL.test(value.estimatedTokensPerSecond) || value.estimatedTokensPerSecond.length > 32)
    issues.push(`${label}.estimatedTokensPerSecond must be a positive decimal string`)
}

const WORKLOADS: LocalWorkloadClass[] = ['background', 'coding', 'high-capability', 'interactive']

function validateSuitability(value: unknown, label: string, issues: string[]): void {
  if (!Array.isArray(value) || value.length !== WORKLOADS.length) {
    issues.push(`${label} must cover every workload class exactly once`)
    return
  }
  const seen = new Set<string>()
  value.forEach((entry, index) => {
    const path = `${label}[${index}]`
    if (!object(entry)) {
      issues.push(`${path} must be an object`)
      return
    }
    exactFields(entry, ['workload', 'rating'], path, issues)
    if (!WORKLOADS.includes(entry.workload as LocalWorkloadClass) || seen.has(String(entry.workload))) issues.push(`${path}.workload is duplicate or unsupported`)
    seen.add(String(entry.workload))
    if (!['limited', 'suitable', 'preferred'].includes(String(entry.rating))) issues.push(`${path}.rating is unsupported`)
  })
}

function validateAvailability(value: unknown, label: string, issues: string[]): void {
  if (!object(value)) {
    issues.push(`${label} must be an object`)
    return
  }
  exactFields(value, ['state', 'observedAt', 'validUntil', 'reasonCode'], label, issues)
  if (!['available', 'unavailable'].includes(String(value.state))) issues.push(`${label}.state is unsupported`)
  if (!timestamp(value.observedAt) || !timestamp(value.validUntil)) issues.push(`${label} timestamps must be canonical UTC timestamps`)
  else if (Date.parse(value.validUntil) <= Date.parse(value.observedAt)) issues.push(`${label}.validUntil must be later than observedAt`)
  if (value.state === 'available' && value.reasonCode !== undefined) issues.push(`${label}.reasonCode is not allowed when available`)
  if (value.state === 'unavailable' && !safeComponent(value.reasonCode)) issues.push(`${label}.reasonCode is required when unavailable`)
}

export function assertLocalExecutionProfileCandidate(value: unknown): asserts value is LocalExecutionProfileCandidate {
  const issues: string[] = []
  if (!object(value)) throw new LocalProfileContractError(['candidate must be an object'])
  exactFields(value, ['schemaVersion', 'runtime', 'artifact', 'configuration', 'resources', 'performance', 'suitability', 'availability', 'evidenceRefs'], 'candidate', issues)
  if (value.schemaVersion !== 1) issues.push('candidate.schemaVersion must be 1')
  validateRuntime(value.runtime, 'candidate.runtime', issues)
  validateArtifact(value.artifact, 'candidate.artifact', issues)
  validateConfiguration(value.configuration, 'candidate.configuration', issues)
  validateResources(value.resources, 'candidate.resources', issues)
  validatePerformance(value.performance, 'candidate.performance', issues)
  validateSuitability(value.suitability, 'candidate.suitability', issues)
  validateAvailability(value.availability, 'candidate.availability', issues)
  if (safeList(value.evidenceRefs, 'candidate.evidenceRefs', issues) && value.evidenceRefs.length === 0) issues.push('candidate.evidenceRefs must contain at least one evidence reference')
  if (object(value.runtime) && object(value.resources)) {
    if (value.runtime.backend === 'none' && value.resources.memoryPool !== 'system') issues.push('candidate CPU runtime must use the system memory pool')
    if (value.runtime.backend !== 'none' && value.resources.memoryPool === 'system') issues.push('candidate accelerator runtime cannot use only the system memory pool')
  }
  if (issues.length) throw new LocalProfileContractError(issues)
}

function canonicalSuitability(value: LocalExecutionProfileCandidate['suitability']): LocalExecutionProfileCandidate['suitability'] {
  return value.map((entry) => ({ ...entry })).sort((left, right) => left.workload.localeCompare(right.workload))
}

export function canonicalLocalExecutionProfileCandidate(value: LocalExecutionProfileCandidate): LocalExecutionProfileCandidate {
  assertLocalExecutionProfileCandidate(value)
  return {
    schemaVersion: 1,
    runtime: { ...value.runtime },
    artifact: { ...value.artifact },
    configuration: { ...value.configuration },
    resources: { ...value.resources },
    performance: { ...value.performance },
    suitability: canonicalSuitability(value.suitability),
    availability: { ...value.availability },
    evidenceRefs: [...value.evidenceRefs].sort()
  }
}

export function localExecutionProfileId(value: LocalExecutionProfileCandidate): string {
  const candidate = canonicalLocalExecutionProfileCandidate(value)
  return stableFingerprint({ runtime: candidate.runtime, artifact: candidate.artifact, configuration: candidate.configuration })
}

function policyWithoutId(value: Omit<LocalExecutionProfilePolicy, 'id'>): LocalExecutionProfilePolicy {
  return { ...value, id: stableFingerprint(value) }
}

export function createLocalExecutionProfilePolicy(value: Omit<LocalExecutionProfilePolicy, 'id'>): LocalExecutionProfilePolicy {
  const policy = policyWithoutId({
    ...value,
    headroom: { ...value.headroom },
    workloadPriority: [...value.workloadPriority],
    runtimePreference: [...value.runtimePreference]
  })
  assertLocalExecutionProfilePolicy(policy)
  return freeze(policy)
}

export const DEFAULT_LOCAL_EXECUTION_PROFILE_POLICY: LocalExecutionProfilePolicy = createLocalExecutionProfilePolicy({
  schemaVersion: 1,
  version: 'sf-local-profiles/v1',
  minimumHostTier: 'background-only',
  headroom: {
    osSystemMemoryBytes: gib(4),
    developerSystemMemoryBytes: gib(4),
    developerAcceleratorMemoryBytes: gib(2),
    storageBytes: gib(16)
  },
  maximumProfiles: 5,
  workloadPriority: ['coding', 'interactive', 'background', 'high-capability'],
  runtimePreference: ['host-optimized', 'portable']
})

export function assertLocalExecutionProfilePolicy(value: unknown): asserts value is LocalExecutionProfilePolicy {
  const issues: string[] = []
  if (!object(value)) throw new LocalProfileContractError(['policy must be an object'])
  exactFields(value, ['schemaVersion', 'id', 'version', 'minimumHostTier', 'headroom', 'maximumProfiles', 'workloadPriority', 'runtimePreference'], 'policy', issues)
  if (value.schemaVersion !== 1) issues.push('policy.schemaVersion must be 1')
  if (!FINGERPRINT.test(String(value.id))) issues.push('policy.id must be a fingerprint')
  if (!safeReference(value.version)) issues.push('policy.version must be a safe reference')
  if (!['background-only', 'interactive', 'coding-capable', 'high-capability'].includes(String(value.minimumHostTier))) issues.push('policy.minimumHostTier is unsupported')
  if (!boundedInteger(value.maximumProfiles, 1, MAX_PROFILES)) issues.push(`policy.maximumProfiles must be between 1 and ${MAX_PROFILES}`)
  if (!object(value.headroom)) issues.push('policy.headroom must be an object')
  else {
    exactFields(value.headroom, ['osSystemMemoryBytes', 'developerSystemMemoryBytes', 'developerAcceleratorMemoryBytes', 'storageBytes'], 'policy.headroom', issues)
    for (const field of ['osSystemMemoryBytes', 'developerSystemMemoryBytes', 'developerAcceleratorMemoryBytes', 'storageBytes'] as const) {
      if (!byteString(value.headroom[field], true)) issues.push(`policy.headroom.${field} must be an exact positive byte string`)
      else if (BigInt(value.headroom[field]) < BigInt(MINIMUM_LOCAL_PROFILE_HEADROOM[field])) issues.push(`policy.headroom.${field} is below the safety floor`)
    }
  }
  if (
    !Array.isArray(value.workloadPriority) ||
    value.workloadPriority.length === 0 ||
    value.workloadPriority.length > WORKLOADS.length ||
    !value.workloadPriority.every((entry) => WORKLOADS.includes(entry as LocalWorkloadClass)) ||
    new Set(value.workloadPriority).size !== value.workloadPriority.length
  )
    issues.push('policy.workloadPriority must contain unique supported workloads')
  if (
    !Array.isArray(value.runtimePreference) ||
    value.runtimePreference.length !== 2 ||
    !value.runtimePreference.every((entry) => ['portable', 'host-optimized'].includes(String(entry))) ||
    new Set(value.runtimePreference).size !== value.runtimePreference.length
  )
    issues.push('policy.runtimePreference must order both runtime optimization classes')
  if (issues.length === 0) {
    const { id, ...withoutId } = value
    if (stableFingerprint(withoutId) !== id) issues.push('policy.id does not match its canonical content')
  }
  if (issues.length) throw new LocalProfileContractError(issues)
}

// Implemented by the qualification child; declared here to keep the public contract stable.
export async function recommendLocalExecutionProfiles(
  host: HostCapabilitySnapshot,
  adapters: readonly LocalExecutionProfileAdapter[],
  options: RecommendLocalExecutionProfilesOptions
): Promise<LocalExecutionProfileRecommendation> {
  void host
  void adapters
  void options
  throw new Error('Local profile qualification is not implemented yet.')
}
