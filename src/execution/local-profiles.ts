import { assertHostCapabilitySnapshot, type HostAcceleratorBackend, type HostCapabilityEvidence, type HostCapabilitySnapshot, type HostInferenceViabilityTier } from './host-capabilities'
import { stableFingerprint } from './overrides'

const COMPONENT = /^[a-z0-9][a-z0-9._:-]{0,127}$/i
const REFERENCE = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i
const FINGERPRINT = /^[a-f0-9]{64}$/
const DECIMAL_INTEGER = /^(?:0|[1-9]\d*)$/
const POSITIVE_DECIMAL = /^(?:0\.(?:0*[1-9]\d*)|[1-9]\d*(?:\.\d+)?)$/
const MAX_BYTES = 2n ** 64n - 1n
const MAX_PROFILES = 32
const MAX_ADAPTERS = 32
const MAX_OBSERVATIONS_PER_ADAPTER = 128
const MAX_EVIDENCE_REFS = 32
const MAX_EXCLUSIONS = 256
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

const TIERS: HostInferenceViabilityTier[] = ['unsupported', 'background-only', 'interactive', 'coding-capable', 'high-capability']
const SUITABILITY_SCORE: Record<LocalWorkloadSuitability, number> = { limited: 0, suitable: 1, preferred: 2 }
const EXCLUSION_CODES: LocalProfileExclusionCode[] = [
  'adapter-failed',
  'invalid-candidate',
  'candidate-unavailable',
  'candidate-stale',
  'duplicate-profile',
  'host-tier-insufficient',
  'host-backend-unsupported',
  'host-capacity-unknown',
  'system-memory-insufficient',
  'accelerator-memory-insufficient',
  'storage-insufficient',
  'profile-limit'
]
const CONSTRAINT_CODES: LocalRecommendationConstraintCode[] = ['host-unsupported', 'host-stale', 'host-tier-insufficient', 'no-adapters', 'no-profile-observations', 'no-viable-profile']
const TRADEOFF_CODES: LocalProfileTradeoffCode[] = [
  'portable-runtime',
  'host-optimized-runtime',
  'cpu-system-memory',
  'unified-memory',
  'shared-accelerator-memory',
  'dedicated-accelerator-memory',
  'bounded-context',
  'bounded-concurrency',
  'estimated-latency'
]

function observedBytes(evidence: HostCapabilityEvidence<string>): bigint | null {
  return evidence.state === 'observed' && evidence.value !== null ? BigInt(evidence.value) : null
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort()
}

function exclusionSort(left: LocalProfileExclusion, right: LocalProfileExclusion): number {
  return (
    left.adapterId.localeCompare(right.adapterId) ||
    left.sourceId.localeCompare(right.sourceId) ||
    String(left.profileId ?? '').localeCompare(String(right.profileId ?? '')) ||
    left.code.localeCompare(right.code) ||
    left.constraintCodes.join(',').localeCompare(right.constraintCodes.join(','))
  )
}

function addExclusion(target: LocalProfileExclusion[], value: LocalProfileExclusion): void {
  if (target.length >= MAX_EXCLUSIONS) return
  target.push({ ...value, constraintCodes: sortedUnique(value.constraintCodes) })
}

function validateAdapters(adapters: readonly LocalExecutionProfileAdapter[]): LocalExecutionProfileAdapter[] {
  const issues: string[] = []
  if (!Array.isArray(adapters) || adapters.length > MAX_ADAPTERS) throw new LocalProfileContractError([`adapters must contain at most ${MAX_ADAPTERS} entries`])
  const ids = new Set<string>()
  for (const [index, adapter] of adapters.entries()) {
    if (!object(adapter)) {
      issues.push(`adapters[${index}] must be an object`)
      continue
    }
    exactFields(adapter, ['id', 'discover', 'normalize'], `adapters[${index}]`, issues)
    if (!safeComponent(adapter.id)) issues.push(`adapters[${index}].id must be a safe component`)
    else if (ids.has(adapter.id)) issues.push(`adapters[${index}].id must be unique`)
    else ids.add(adapter.id)
    if (typeof adapter.discover !== 'function') issues.push(`adapters[${index}].discover must be a function`)
    if (typeof adapter.normalize !== 'function') issues.push(`adapters[${index}].normalize must be a function`)
  }
  if (issues.length) throw new LocalProfileContractError(issues)
  return [...adapters].sort((left, right) => left.id.localeCompare(right.id))
}

function validateOptions(options: RecommendLocalExecutionProfilesOptions): LocalExecutionProfilePolicy {
  const issues: string[] = []
  if (!object(options)) throw new LocalProfileContractError(['options must be an object'])
  exactFields(options, ['evaluatedAt', 'policy'], 'options', issues)
  if (!timestamp(options.evaluatedAt)) issues.push('options.evaluatedAt must be a canonical UTC timestamp')
  if (issues.length) throw new LocalProfileContractError(issues)
  const policy = options.policy ?? DEFAULT_LOCAL_EXECUTION_PROFILE_POLICY
  assertLocalExecutionProfilePolicy(policy)
  return policy
}

function finalRecommendation(
  host: HostCapabilitySnapshot,
  policy: LocalExecutionProfilePolicy,
  generatedAt: string,
  profiles: LocalExecutionProfile[],
  exclusions: LocalProfileExclusion[],
  constraintCodes: LocalRecommendationConstraintCode[]
): LocalExecutionProfileRecommendation {
  const canonicalProfiles = profiles.map((profile, index) => ({ ...profile, rank: index + 1 }))
  const canonicalExclusions = exclusions.sort(exclusionSort)
  const recommendationWithoutId: Omit<LocalExecutionProfileRecommendation, 'id'> = {
    schemaVersion: 1,
    generatedAt,
    hostSnapshotId: host.id,
    policyId: policy.id,
    status: canonicalProfiles.length > 0 ? 'profiles-available' : 'no-install-recommended',
    profiles: canonicalProfiles,
    exclusions: canonicalExclusions,
    constraintCodes: sortedUnique(constraintCodes),
    evidenceRefs: sortedUnique([...host.evidenceRefs, ...canonicalProfiles.flatMap((profile) => profile.evidenceRefs)])
  }
  const recommendation = { ...recommendationWithoutId, id: stableFingerprint(recommendationWithoutId) }
  assertLocalExecutionProfileRecommendation(recommendation)
  return freeze(recommendation)
}

function validateProfile(value: unknown, label: string, issues: string[], hostSnapshotId: string, policyId: string, expectedRank: number): void {
  if (!object(value)) {
    issues.push(`${label} must be an object`)
    return
  }
  exactFields(
    value,
    [
      'id',
      'adapterId',
      'sourceId',
      'hostSnapshotId',
      'policyId',
      'rank',
      'runtime',
      'artifact',
      'configuration',
      'resources',
      'performance',
      'suitability',
      'availability',
      'tradeoffCodes',
      'evidenceRefs'
    ],
    label,
    issues
  )
  if (!FINGERPRINT.test(String(value.id))) issues.push(`${label}.id must be a fingerprint`)
  if (!safeComponent(value.adapterId)) issues.push(`${label}.adapterId must be a safe component`)
  if (!safeComponent(value.sourceId)) issues.push(`${label}.sourceId must be a safe component`)
  if (value.hostSnapshotId !== hostSnapshotId) issues.push(`${label}.hostSnapshotId must match the recommendation`)
  if (value.policyId !== policyId) issues.push(`${label}.policyId must match the recommendation`)
  if (value.rank !== expectedRank) issues.push(`${label}.rank must be sequential`)
  validateRuntime(value.runtime, `${label}.runtime`, issues)
  validateArtifact(value.artifact, `${label}.artifact`, issues)
  validateConfiguration(value.configuration, `${label}.configuration`, issues)
  if (!object(value.resources)) issues.push(`${label}.resources must be an object`)
  else {
    exactFields(
      value.resources,
      [
        'artifactDownloadBytes',
        'installedDiskBytes',
        'systemMemoryBytes',
        'acceleratorMemoryBytes',
        'memoryPool',
        'requiredDiskWithHeadroomBytes',
        'requiredSystemMemoryWithHeadroomBytes',
        'requiredAcceleratorMemoryWithHeadroomBytes'
      ],
      `${label}.resources`,
      issues
    )
    validateResources(
      {
        artifactDownloadBytes: value.resources.artifactDownloadBytes,
        installedDiskBytes: value.resources.installedDiskBytes,
        systemMemoryBytes: value.resources.systemMemoryBytes,
        acceleratorMemoryBytes: value.resources.acceleratorMemoryBytes,
        memoryPool: value.resources.memoryPool
      },
      `${label}.resources`,
      issues
    )
    if (!byteString(value.resources.requiredDiskWithHeadroomBytes, true)) issues.push(`${label}.resources.requiredDiskWithHeadroomBytes must be exact`)
    if (!byteString(value.resources.requiredSystemMemoryWithHeadroomBytes, true)) issues.push(`${label}.resources.requiredSystemMemoryWithHeadroomBytes must be exact`)
    if (!byteString(value.resources.requiredAcceleratorMemoryWithHeadroomBytes)) issues.push(`${label}.resources.requiredAcceleratorMemoryWithHeadroomBytes must be exact`)
  }
  validatePerformance(value.performance, `${label}.performance`, issues)
  validateSuitability(value.suitability, `${label}.suitability`, issues)
  validateAvailability(value.availability, `${label}.availability`, issues)
  if (object(value.availability) && value.availability.state !== 'available') issues.push(`${label}.availability must be available`)
  if (
    !Array.isArray(value.tradeoffCodes) ||
    value.tradeoffCodes.length === 0 ||
    !value.tradeoffCodes.every((code) => TRADEOFF_CODES.includes(code as LocalProfileTradeoffCode)) ||
    JSON.stringify(value.tradeoffCodes) !== JSON.stringify(sortedUnique(value.tradeoffCodes as LocalProfileTradeoffCode[]))
  )
    issues.push(`${label}.tradeoffCodes must be unique canonical codes`)
  if (safeList(value.evidenceRefs, `${label}.evidenceRefs`, issues) && value.evidenceRefs.length === 0) issues.push(`${label}.evidenceRefs must not be empty`)
  else if (Array.isArray(value.evidenceRefs) && JSON.stringify(value.evidenceRefs) !== JSON.stringify([...value.evidenceRefs].sort())) issues.push(`${label}.evidenceRefs must be canonical`)
  if (issues.length === 0) {
    const candidate: LocalExecutionProfileCandidate = {
      schemaVersion: 1,
      runtime: value.runtime as LocalExecutionProfileCandidate['runtime'],
      artifact: value.artifact as LocalExecutionProfileCandidate['artifact'],
      configuration: value.configuration as LocalExecutionProfileCandidate['configuration'],
      resources: {
        artifactDownloadBytes: (value.resources as LocalExecutionProfile['resources']).artifactDownloadBytes,
        installedDiskBytes: (value.resources as LocalExecutionProfile['resources']).installedDiskBytes,
        systemMemoryBytes: (value.resources as LocalExecutionProfile['resources']).systemMemoryBytes,
        acceleratorMemoryBytes: (value.resources as LocalExecutionProfile['resources']).acceleratorMemoryBytes,
        memoryPool: (value.resources as LocalExecutionProfile['resources']).memoryPool
      },
      performance: value.performance as LocalExecutionProfileCandidate['performance'],
      suitability: value.suitability as LocalExecutionProfileCandidate['suitability'],
      availability: value.availability as LocalExecutionProfileCandidate['availability'],
      evidenceRefs: value.evidenceRefs as string[]
    }
    if (localExecutionProfileId(candidate) !== value.id) issues.push(`${label}.id does not match its runtime, artifact, and configuration`)
  }
}

export function assertLocalExecutionProfileRecommendation(value: unknown): asserts value is LocalExecutionProfileRecommendation {
  const issues: string[] = []
  if (!object(value)) throw new LocalProfileContractError(['recommendation must be an object'])
  exactFields(value, ['schemaVersion', 'id', 'generatedAt', 'hostSnapshotId', 'policyId', 'status', 'profiles', 'exclusions', 'constraintCodes', 'evidenceRefs'], 'recommendation', issues)
  if (value.schemaVersion !== 1) issues.push('recommendation.schemaVersion must be 1')
  if (!FINGERPRINT.test(String(value.id))) issues.push('recommendation.id must be a fingerprint')
  if (!timestamp(value.generatedAt)) issues.push('recommendation.generatedAt must be a canonical UTC timestamp')
  if (!FINGERPRINT.test(String(value.hostSnapshotId))) issues.push('recommendation.hostSnapshotId must be a fingerprint')
  if (!FINGERPRINT.test(String(value.policyId))) issues.push('recommendation.policyId must be a fingerprint')
  if (!['profiles-available', 'no-install-recommended'].includes(String(value.status))) issues.push('recommendation.status is unsupported')
  if (!Array.isArray(value.profiles) || value.profiles.length > MAX_PROFILES) issues.push(`recommendation.profiles must contain at most ${MAX_PROFILES} profiles`)
  else {
    value.profiles.forEach((profile, index) => validateProfile(profile, `recommendation.profiles[${index}]`, issues, String(value.hostSnapshotId), String(value.policyId), index + 1))
    const ids = value.profiles.map((profile) => (object(profile) ? profile.id : undefined))
    if (new Set(ids).size !== ids.length) issues.push('recommendation.profiles must have unique identities')
  }
  if (!Array.isArray(value.exclusions) || value.exclusions.length > MAX_EXCLUSIONS) issues.push(`recommendation.exclusions must contain at most ${MAX_EXCLUSIONS} exclusions`)
  else {
    value.exclusions.forEach((entry, index) => {
      const label = `recommendation.exclusions[${index}]`
      if (!object(entry)) {
        issues.push(`${label} must be an object`)
        return
      }
      exactFields(entry, ['adapterId', 'sourceId', 'profileId', 'code', 'constraintCodes'], label, issues)
      if (!safeComponent(entry.adapterId)) issues.push(`${label}.adapterId must be a safe component`)
      if (!safeComponent(entry.sourceId)) issues.push(`${label}.sourceId must be a safe component`)
      if (entry.profileId !== undefined && !FINGERPRINT.test(String(entry.profileId))) issues.push(`${label}.profileId must be a fingerprint`)
      if (!EXCLUSION_CODES.includes(entry.code as LocalProfileExclusionCode)) issues.push(`${label}.code is unsupported`)
      if (safeList(entry.constraintCodes, `${label}.constraintCodes`, issues, 16)) {
        if (entry.constraintCodes.length === 0) issues.push(`${label}.constraintCodes must not be empty`)
        if (JSON.stringify(entry.constraintCodes) !== JSON.stringify([...entry.constraintCodes].sort())) issues.push(`${label}.constraintCodes must be canonical`)
      }
    })
    if (JSON.stringify(value.exclusions) !== JSON.stringify([...value.exclusions].sort(exclusionSort))) issues.push('recommendation.exclusions must be canonical')
  }
  if (
    !Array.isArray(value.constraintCodes) ||
    !value.constraintCodes.every((code) => CONSTRAINT_CODES.includes(code as LocalRecommendationConstraintCode)) ||
    JSON.stringify(value.constraintCodes) !== JSON.stringify(sortedUnique(value.constraintCodes as LocalRecommendationConstraintCode[]))
  )
    issues.push('recommendation.constraintCodes must be unique canonical codes')
  if (safeList(value.evidenceRefs, 'recommendation.evidenceRefs', issues, 256)) {
    if (value.evidenceRefs.length === 0) issues.push('recommendation.evidenceRefs must not be empty')
    if (JSON.stringify(value.evidenceRefs) !== JSON.stringify([...value.evidenceRefs].sort())) issues.push('recommendation.evidenceRefs must be canonical')
  }
  if (Array.isArray(value.profiles)) {
    if (value.status === 'profiles-available' && value.profiles.length === 0) issues.push('recommendation profiles-available status requires profiles')
    if (value.status === 'no-install-recommended' && value.profiles.length !== 0) issues.push('recommendation no-install-recommended status cannot contain profiles')
  }
  if (issues.length === 0) {
    const { id, ...withoutId } = value
    if (stableFingerprint(withoutId) !== id) issues.push('recommendation.id does not match its canonical content')
  }
  if (issues.length) throw new LocalProfileContractError(issues)
}

function candidateTradeoffs(candidate: LocalExecutionProfileCandidate): LocalProfileTradeoffCode[] {
  const poolCode: Record<LocalMemoryPool, LocalProfileTradeoffCode> = {
    system: 'cpu-system-memory',
    unified: 'unified-memory',
    shared: 'shared-accelerator-memory',
    dedicated: 'dedicated-accelerator-memory'
  }
  return sortedUnique([
    candidate.runtime.optimization === 'portable' ? 'portable-runtime' : 'host-optimized-runtime',
    poolCode[candidate.resources.memoryPool],
    'bounded-context',
    'bounded-concurrency',
    'estimated-latency'
  ])
}

function qualifyCandidate(
  host: HostCapabilitySnapshot,
  policy: LocalExecutionProfilePolicy,
  adapterId: string,
  sourceId: string,
  candidate: LocalExecutionProfileCandidate
): { profile?: LocalExecutionProfile; exclusion?: LocalProfileExclusion } {
  const profileId = localExecutionProfileId(candidate)
  const constraintCodes: string[] = []
  const totalMemory = observedBytes(host.memory.totalBytes)
  const availableMemory = observedBytes(host.memory.availableBytes)
  const availableStorage = observedBytes(host.storage.availableBytes)
  const artifactDownload = BigInt(candidate.resources.artifactDownloadBytes)
  const installedDisk = BigInt(candidate.resources.installedDiskBytes)
  const systemMemory = BigInt(candidate.resources.systemMemoryBytes)
  const acceleratorMemory = BigInt(candidate.resources.acceleratorMemoryBytes)
  const osHeadroom = BigInt(policy.headroom.osSystemMemoryBytes)
  const developerSystem = BigInt(policy.headroom.developerSystemMemoryBytes)
  const developerAccelerator = BigInt(policy.headroom.developerAcceleratorMemoryBytes)
  const storageHeadroom = BigInt(policy.headroom.storageBytes)
  const requiredDisk = artifactDownload + installedDisk + storageHeadroom

  let requiredSystem = systemMemory + osHeadroom + developerSystem
  let requiredAvailableSystem = systemMemory + developerSystem
  let requiredAccelerator = 0n
  const usesSharedSystemMemory = candidate.resources.memoryPool === 'unified' || candidate.resources.memoryPool === 'shared'
  if (usesSharedSystemMemory) {
    requiredSystem += acceleratorMemory + developerAccelerator
    requiredAvailableSystem += acceleratorMemory + developerAccelerator
  } else if (candidate.resources.memoryPool === 'dedicated') requiredAccelerator = acceleratorMemory + developerAccelerator

  if (totalMemory === null || availableMemory === null || availableStorage === null) constraintCodes.push('required-host-capacity-unobserved')
  else {
    if (requiredSystem > totalMemory || requiredAvailableSystem > availableMemory) constraintCodes.push('system-memory-capacity')
    if (requiredDisk > availableStorage) constraintCodes.push('storage-capacity')
  }

  if (candidate.runtime.backend !== 'none') {
    if (host.accelerators.state !== 'observed' || host.accelerators.value === null) constraintCodes.push('accelerator-capacity-unobserved')
    else {
      const compatible = host.accelerators.value.filter((device) => device.backend === candidate.runtime.backend && device.memoryKind === candidate.resources.memoryPool)
      if (compatible.length === 0) constraintCodes.push('compatible-accelerator-backend')
      else if (candidate.resources.memoryPool === 'dedicated') {
        const capacities = compatible
          .map((device) => device.memoryBytes)
          .filter((value): value is string => value !== null)
          .map(BigInt)
        if (capacities.length === 0) constraintCodes.push('accelerator-capacity-unobserved')
        else if (requiredAccelerator > capacities.reduce((best, value) => (value > best ? value : best), 0n)) constraintCodes.push('accelerator-memory-capacity')
      }
    }
  }

  let code: LocalProfileExclusionCode | undefined
  if (constraintCodes.includes('required-host-capacity-unobserved') || constraintCodes.includes('accelerator-capacity-unobserved')) code = 'host-capacity-unknown'
  else if (constraintCodes.includes('compatible-accelerator-backend')) code = 'host-backend-unsupported'
  else if (constraintCodes.includes('system-memory-capacity')) code = 'system-memory-insufficient'
  else if (constraintCodes.includes('accelerator-memory-capacity')) code = 'accelerator-memory-insufficient'
  else if (constraintCodes.includes('storage-capacity')) code = 'storage-insufficient'
  if (code) return { exclusion: { adapterId, sourceId, profileId, code, constraintCodes } }

  return {
    profile: {
      id: profileId,
      adapterId,
      sourceId,
      hostSnapshotId: host.id,
      policyId: policy.id,
      rank: 0,
      runtime: { ...candidate.runtime },
      artifact: { ...candidate.artifact },
      configuration: { ...candidate.configuration },
      resources: {
        ...candidate.resources,
        requiredDiskWithHeadroomBytes: String(requiredDisk),
        requiredSystemMemoryWithHeadroomBytes: String(requiredSystem),
        requiredAcceleratorMemoryWithHeadroomBytes: String(requiredAccelerator)
      },
      performance: { ...candidate.performance },
      suitability: canonicalSuitability(candidate.suitability),
      availability: { ...candidate.availability },
      tradeoffCodes: candidateTradeoffs(candidate),
      evidenceRefs: [...candidate.evidenceRefs].sort()
    }
  }
}

function compareProfiles(left: LocalExecutionProfile, right: LocalExecutionProfile, policy: LocalExecutionProfilePolicy): number {
  for (const workload of policy.workloadPriority) {
    const leftScore = SUITABILITY_SCORE[left.suitability.find((entry) => entry.workload === workload)!.rating]
    const rightScore = SUITABILITY_SCORE[right.suitability.find((entry) => entry.workload === workload)!.rating]
    if (leftScore !== rightScore) return rightScore - leftScore
  }
  const runtimeOrder = policy.runtimePreference.indexOf(left.runtime.optimization) - policy.runtimePreference.indexOf(right.runtime.optimization)
  if (runtimeOrder !== 0) return runtimeOrder
  if (left.performance.estimatedLatencyP95Ms !== right.performance.estimatedLatencyP95Ms) return left.performance.estimatedLatencyP95Ms - right.performance.estimatedLatencyP95Ms
  if (left.configuration.contextTokens !== right.configuration.contextTokens) return right.configuration.contextTokens - left.configuration.contextTokens
  if (left.configuration.concurrency !== right.configuration.concurrency) return right.configuration.concurrency - left.configuration.concurrency
  const leftMemory = BigInt(left.resources.requiredSystemMemoryWithHeadroomBytes) + BigInt(left.resources.requiredAcceleratorMemoryWithHeadroomBytes)
  const rightMemory = BigInt(right.resources.requiredSystemMemoryWithHeadroomBytes) + BigInt(right.resources.requiredAcceleratorMemoryWithHeadroomBytes)
  if (leftMemory !== rightMemory) return leftMemory < rightMemory ? -1 : 1
  const leftDisk = BigInt(left.resources.requiredDiskWithHeadroomBytes)
  const rightDisk = BigInt(right.resources.requiredDiskWithHeadroomBytes)
  if (leftDisk !== rightDisk) return leftDisk < rightDisk ? -1 : 1
  return left.id.localeCompare(right.id)
}

export async function recommendLocalExecutionProfiles(
  host: HostCapabilitySnapshot,
  adapters: readonly LocalExecutionProfileAdapter[],
  options: RecommendLocalExecutionProfilesOptions
): Promise<LocalExecutionProfileRecommendation> {
  assertHostCapabilitySnapshot(host)
  const policy = validateOptions(options)
  const orderedAdapters = validateAdapters(adapters)
  const evaluatedAt = Date.parse(options.evaluatedAt)
  if (Date.parse(host.observedAt) > evaluatedAt || Date.parse(host.validUntil) <= evaluatedAt) return finalRecommendation(host, policy, options.evaluatedAt, [], [], ['host-stale'])
  if (host.viability.tier === 'unsupported') return finalRecommendation(host, policy, options.evaluatedAt, [], [], ['host-unsupported'])
  if (TIERS.indexOf(host.viability.tier) < TIERS.indexOf(policy.minimumHostTier)) return finalRecommendation(host, policy, options.evaluatedAt, [], [], ['host-tier-insufficient'])
  if (orderedAdapters.length === 0) return finalRecommendation(host, policy, options.evaluatedAt, [], [], ['no-adapters'])

  const exclusions: LocalProfileExclusion[] = []
  const normalized: Array<{ adapterId: string; sourceId: string; candidate: LocalExecutionProfileCandidate; profileId: string }> = []
  let observationCount = 0
  const discoveries = await Promise.allSettled(orderedAdapters.map(async (adapter) => ({ adapter, observations: await adapter.discover(host) })))
  for (const [index, discovery] of discoveries.entries()) {
    const adapter = orderedAdapters[index]
    if (discovery.status === 'rejected' || !Array.isArray(discovery.value.observations) || discovery.value.observations.length > MAX_OBSERVATIONS_PER_ADAPTER) {
      addExclusion(exclusions, { adapterId: adapter.id, sourceId: `adapter-${adapter.id}`, code: 'adapter-failed', constraintCodes: ['adapter-discovery-failed'] })
      continue
    }
    observationCount += discovery.value.observations.length
    for (const rawObservation of discovery.value.observations) {
      const sourceId = object(rawObservation) && safeComponent(rawObservation.sourceId) ? rawObservation.sourceId : 'invalid-source'
      if (!object(rawObservation) || Object.keys(rawObservation).some((field) => !['sourceId', 'value'].includes(field)) || sourceId === 'invalid-source') {
        addExclusion(exclusions, { adapterId: adapter.id, sourceId, code: 'invalid-candidate', constraintCodes: ['invalid-observation-envelope'] })
        continue
      }
      try {
        const candidate = canonicalLocalExecutionProfileCandidate(adapter.normalize({ sourceId, value: rawObservation.value }))
        normalized.push({ adapterId: adapter.id, sourceId, candidate, profileId: localExecutionProfileId(candidate) })
      } catch {
        addExclusion(exclusions, { adapterId: adapter.id, sourceId, code: 'invalid-candidate', constraintCodes: ['adapter-normalization-failed'] })
      }
    }
  }

  const duplicateIds = new Set(
    [...new Map(normalized.map((entry) => [entry.profileId, normalized.filter((candidate) => candidate.profileId === entry.profileId).length])).entries()]
      .filter(([, count]) => count > 1)
      .map(([id]) => id)
  )
  const profiles: LocalExecutionProfile[] = []
  for (const entry of normalized.sort((left, right) => left.adapterId.localeCompare(right.adapterId) || left.sourceId.localeCompare(right.sourceId) || left.profileId.localeCompare(right.profileId))) {
    if (duplicateIds.has(entry.profileId)) {
      addExclusion(exclusions, { adapterId: entry.adapterId, sourceId: entry.sourceId, profileId: entry.profileId, code: 'duplicate-profile', constraintCodes: ['profile-identity-collision'] })
      continue
    }
    if (entry.candidate.availability.state === 'unavailable') {
      addExclusion(exclusions, {
        adapterId: entry.adapterId,
        sourceId: entry.sourceId,
        profileId: entry.profileId,
        code: 'candidate-unavailable',
        constraintCodes: [entry.candidate.availability.reasonCode!]
      })
      continue
    }
    if (Date.parse(entry.candidate.availability.observedAt) > evaluatedAt || Date.parse(entry.candidate.availability.validUntil) <= evaluatedAt) {
      addExclusion(exclusions, { adapterId: entry.adapterId, sourceId: entry.sourceId, profileId: entry.profileId, code: 'candidate-stale', constraintCodes: ['candidate-availability-expired'] })
      continue
    }
    const result = qualifyCandidate(host, policy, entry.adapterId, entry.sourceId, entry.candidate)
    if (result.exclusion) addExclusion(exclusions, result.exclusion)
    if (result.profile) profiles.push(result.profile)
  }

  profiles.sort((left, right) => compareProfiles(left, right, policy))
  for (const profile of profiles.slice(policy.maximumProfiles))
    addExclusion(exclusions, { adapterId: profile.adapterId, sourceId: profile.sourceId, profileId: profile.id, code: 'profile-limit', constraintCodes: ['maximum-profile-count'] })
  const selected = profiles.slice(0, policy.maximumProfiles)
  const constraints: LocalRecommendationConstraintCode[] = []
  if (observationCount === 0) constraints.push('no-profile-observations')
  if (selected.length === 0) constraints.push('no-viable-profile')
  return finalRecommendation(host, policy, options.evaluatedAt, selected, exclusions, constraints)
}
